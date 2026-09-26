// ─────────────────────────────────────────────────────────────────────────────
// app/capture.mjs —— 纯净模式 + 录屏导出（2026-09-15 新建；同日从 app.mjs 抽成域模块）
//
// 状态归属（① 状态收敛）：本模块 15 个可变状态（capRec / capChunks / capStream /
// capDest / capMicGain / capPianoTap / capPianoSrc / capStartedAt / capTimer /
// capHadAudio / pureOn / pureHideTimer / pureHintTimer …）全部封在这里，
// 只导出 `pureOn` 一个只读 live binding；其余状态外部连读都读不到（用 capIsRecording()
// 这个谓词代替直接读 capRec）。
//
// 跨域依赖一律由 configureCapture 注入，不反向 import 别的域（域间会成环）：
//   canvas / audioCtx / playOutNode / micSrc / recState / curProject /
//   setStatus / applyResize / downloadBlob —— 接线归 app.mjs（唯一编排层）。
//
// 每帧维护（琴声桥接补挂 + 麦克风增益门）导出为 capTick()，由 app 的 tick 调用。
// ─────────────────────────────────────────────────────────────────────────────

import log from '../log.mjs';
import { stampName } from '../proj/exporters.mjs';
import { patchWebmDuration } from '../proj/webm-duration.mjs';
import { getAudioContext as pianoCtx, getOutputNode as pianoMaster } from '../anim/piano-sound.mjs';
import anim from '../anim/registry.mjs';

const docEl = (() => {
  const cache = {};
  return (id) => (cache[id] || (cache[id] = document.querySelector('#' + id)));
})();

// DOM 在模块顶层查询：与 app.mjs 同模式（index.html 用的是 module script，求值时 DOM 必已就绪）
const appEl = docEl('app');                                  // 全屏载体
const pureBarEl = docEl('pureBar'), pbClockEl = docEl('pbClock'), pbRecEl = docEl('pbRec'), pbHintEl = docEl('pbHint');

// ---- 注入的跨域依赖（默认值保证"未接线也不炸"，且让依赖面一眼可见）----
let D = {
  canvas: null,
  getAudioCtx: () => null,
  getPlayOutNode: () => null,
  ensurePlayOut: () => {},
  getMicSrc: () => null,
  getRecState: () => 'idle',
  getProject: () => null,
  setStatus: () => {},
  applyResize: () => {},
  downloadBlob: () => {},
};
/** app.mjs 启动时接线：注入跨域读取器与工具函数。 */
export function configureCapture(deps) { D = Object.assign({}, D, deps); }

// ===== 状态 =====
let capRec = null;                 // MediaRecorder
let capChunks = [];
let capStream = null, capDest = null, capMicGain = null;
let capPianoTap = null, capPianoSrc = null;   // 琴声跨 AudioContext 桥接的两端（必须留着以便拆）
let capStartedAt = 0, capTimer = null;
let capHadAudio = false;           // 本次录制是否带音频轨（录完如实告知，别让用户自己发现是哑的）
let capTapWarn = '';               // 琴声/人声"没接进录制"的提示（每段录制最多提示一次，见 capEnsure*）
export let pureOn = false;
let pureHideTimer = null;
const PURE_IDLE_MS = 2500;         // 鼠标静止多久后淡出悬浮条（别录进视频）

// 纯净模式下传输条(#recStatus)是隐藏的，setStatus 写了也看不见。
// 凡是"用户在纯净模式下必须知道"的结果（录制失败/完成），顺带回显到悬浮条上。
const PURE_HINT = '纯净模式 · Esc 退出';
let pureHintTimer = null;
function pureHint(msg) {
  if (!pureOn || !pbHintEl) return;
  pbHintEl.textContent = msg;
  if (pureHintTimer) clearTimeout(pureHintTimer);
  pureHintTimer = setTimeout(() => { if (pbHintEl) pbHintEl.textContent = PURE_HINT; }, 6000);
}

/** 是否正在录制动画（替代外部直接读 capRec） */
export function capIsRecording() { return !!capRec; }

// 画布内还有"界面角标"（如钢琴块的「♪ 琴声: …」），它们是 ctx.fillText 画进画布的，
// 所以 canvas.captureStream() 会把它们一起录进视频。录制中或纯净模式下统一广播隐藏。
// 模板不暴露该接口 = 没有画布内角标，跳过即可（用可选调用，不强求所有模板实现）。
export function syncTemplateChrome() {
  const hide = pureOn || !!capRec;
  for (const t of anim.list()) {
    if (typeof t.setChromeHidden === 'function') { try { t.setChromeHidden(hide); } catch (e) {} }
  }
}

// ===== 纯净模式 =====
// 隐藏清单由 index.html 的 `body.pure ...` 规则实现（header / 传输条 / 收纳面板 / 工具条 /
// HUD / 角标 / 曲库浮层 #libPanel）。这里只管状态与全屏。
// ⚠️ 新增界面元素时若要一并隐藏，改 index.html 的那组选择器即可，本文件不用动。
function pureReveal() {
  if (!pureOn || !pureBarEl) return;
  pureBarEl.classList.add('shown');
  if (pureHideTimer) clearTimeout(pureHideTimer);
  if (capRec) return;              // 录制中不自动隐藏：否则找不到"停止"
  pureHideTimer = setTimeout(() => { if (!capRec) pureBarEl.classList.remove('shown'); }, PURE_IDLE_MS);
}
export async function enterPure() {
  if (pureOn) return;
  pureOn = true;
  document.body.classList.add('pure');
  if (pureBarEl) pureBarEl.classList.remove('hidden');
  pureReveal();
  syncTemplateChrome();            // 纯净模式 = 画面要干净，画布内的角标一并藏起来
  try {
    if (appEl && appEl.requestFullscreen) await appEl.requestFullscreen();
  } catch (e) {
    // 全屏被拒（iframe 无 allowfullscreen / 浏览器策略）不算失败：纯净模式照旧生效，
    // 只是画布不铺满整屏。记日志便于排查，不打扰用户。
    log.warn('pure', '进入全屏被拒绝（仅保留纯净模式）：' + (e.message || e));
  }
  setTimeout(() => D.applyResize(), 60);     // 布局变了，重算画布（全屏也会触发 resize，双保险）
  log.info('pure', '进入纯净模式', { fullscreen: !!document.fullscreenElement });
}
export function exitPure() {
  if (!pureOn) return;
  pureOn = false;
  document.body.classList.remove('pure');
  if (pureBarEl) { pureBarEl.classList.remove('shown'); pureBarEl.classList.add('hidden'); }
  if (pureHideTimer) { clearTimeout(pureHideTimer); pureHideTimer = null; }
  syncTemplateChrome();            // 退出纯净：角标恢复（但若还在录制就仍藏着）
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
  setTimeout(() => D.applyResize(), 60);
  log.info('pure', '退出纯净模式');
}
export function togglePure() { pureOn ? exitPure() : enterPure(); }

// ===== 录屏：画面只取画布，声音汇两处 =====
// 画面：canvas.captureStream()。HUD/读数/工具条都是 DOM 覆盖层，本就不在 canvas 里，
//       所以"纯洁的动画"是天然结果——纯净模式只是顺手让用户眼前也干净。
// 声音：项目有【两个独立 AudioContext】，必须分别取再桥接到同一条音轨：
//       ① app 的 audioCtx：播放音频走 playOutNode → destination
//       ② anim/piano-sound.mjs 自己的 actx：master → 压缩器 → 它自己的 destination
//       （跨上下文：在琴声上下文建 MediaStreamDestination，拿到 stream 后用
//         app 上下文的 createMediaStreamSource 拉进来。）
// 麦克风：默认不并入（否则回放时会连房间噪声一起录进去）；
//       只在 recState==='rec'（真在录人声/口哨，此时没有别的声源）时并入，见 capTick()。
const CAP_MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
function capSupported() {
  return typeof MediaRecorder !== 'undefined'
    && D.canvas && typeof D.canvas.captureStream === 'function'
    && CAP_MIMES.some((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
}
const capClock = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};
function capSetUI(on) {
  if (pbRecEl) pbRecEl.textContent = on ? '■ 停止' : '⏺ 录制';
  const b = docEl('btnRecord');
  if (b) b.textContent = on ? '■ 停止录制' : '⏺ 录制动画';
  if (pureBarEl) pureBarEl.classList.toggle('rec', on);
  if (pbClockEl) { pbClockEl.classList.toggle('on', on); if (!on) pbClockEl.textContent = '00:00'; }
  if (on) pureReveal();
  syncTemplateChrome();      // 录制中要藏起画布内的界面角标（否则会被录进视频）
}
// 琴声跨上下文桥接：幂等，可反复调。
// ⚠️ 必须在录制期间【持续补挂】，不能只在开始时挂一次：
//   钢琴引擎是惰性创建的（piano-sound.mjs 的 ensureAudio() 在勾上「钢琴声」时才建 AudioContext），
//   若先点录制、后开钢琴声，开始时 pianoCtx() 还是 null → 那次录制永远挂不上 → 视频没有琴声。
//   对 MIDI 工程尤其致命：它的 buffer 是新建的【静音时间轴】，琴声是唯一声源 → 整段全静音，
//   看起来就像"录制功能不出声"。由 capTick() 每帧调一次兜住。
function capEnsurePianoTap() {
  const audioCtx = D.getAudioCtx();
  if (!capDest || !audioCtx || capPianoSrc) return;
  try {
    const pctx = pianoCtx(), pm = pianoMaster();
    if (!pctx || !pm) return;
    capPianoTap = pctx.createMediaStreamDestination();
    pm.connect(capPianoTap);
    capPianoSrc = audioCtx.createMediaStreamSource(capPianoTap.stream);
    capPianoSrc.connect(capDest);
    log.info('cap', '琴声已接入录制', { delayed: !!capRec });
  } catch (e) {
    capPianoTap = null; capPianoSrc = null;
    log.warn('cap', '琴声接入录制失败（视频将不含琴声）：' + (e.message || e));
    // ⚠ 本函数由 capTick 每帧调用 → 失败会每帧重试，提示只许给一次（否则状态栏被刷爆）。
    if (!capTapWarn) {
      capTapWarn = '琴声';
      pureHint('⚠ 琴声没能接进视频');
      D.setStatus('⏺ 录制中…⚠ 琴声未接入（视频不会有琴声；画面与人声正常）');
    }
  }
}
// 麦克风跨会话桥接：与琴声同理，**也必须持续补挂**。
// ⚠️ micSrc 只在 app 的 startMicRoute()（点录音时才走）里创建 —— 先点「录制动画」、
//    后点「开始录音」时，开始时 getMicSrc() 还是 null，那次录制就永远没接上人声
//    （视频只有画面与琴声），所以失败必须显式报出来。
//    增益默认 0（不录现场声），由 capTick 按录音状态开合。
function capEnsureMicTap() {
  const audioCtx = D.getAudioCtx();
  if (!capDest || !audioCtx || capMicGain) return;
  const micSrc = D.getMicSrc();
  if (!micSrc) return;                    // 麦克风还没就绪：下一帧再试
  try {
    capMicGain = audioCtx.createGain();
    capMicGain.gain.value = 0;
    micSrc.connect(capMicGain);
    capMicGain.connect(capDest);
    log.info('cap', '麦克风已接入录制', { delayed: true });
  } catch (e) {
    capMicGain = null;
    log.warn('cap', '麦克风接入录制失败（视频将不含人声）：' + (e.message || e));
    // 同 capEnsurePianoTap：每帧重试，提示只给一次。
    if (!capTapWarn) {
      capTapWarn = '麦克风';
      pureHint('⚠ 麦克风没能接进视频');
      D.setStatus('⏺ 录制中…⚠ 麦克风未接入（视频不会有你唱的声音）');
    }
  }
}
function capBuildAudio() {
  const audioCtx = D.getAudioCtx();
  if (!audioCtx) return null;
  capDest = audioCtx.createMediaStreamDestination();
  // ① 播放音频：playOutNode 是常驻共享主输出（playOutNode → destination 那条绝不能断，
  //    否则第一次播放后全部静音，见 teardownPlay 注释）。这里只额外并联一条到 capDest。
  D.ensurePlayOut();
  const playOutNode = D.getPlayOutNode();
  if (playOutNode) playOutNode.connect(capDest);
  // ② 琴声：跨上下文桥接（此刻可能还没就绪，capTick() 会持续补挂）
  capEnsurePianoTap();
  // ③ 麦克风：先接好，增益由 capTick() 按录音状态开关（默认 0=不录现场声）
  capEnsureMicTap();
  // ⚠️ 返回的是 MediaStream，不是 capDest 这个 AudioNode！
  //   音频轨在 node.stream 上；对 node 本身调 getAudioTracks() 会抛 TypeError
  //   （2026-09-15 的"点录制没反应"就是这个：那句不在 try 里，异常直接冒出点击处理函数，
  //    表现为无提示无日志的静默失败。守卫见 test/cap-record.mjs）。
  return capDest.stream;
}
function capRelease() {
  // 只拆"本模块加的"那条线：disconnect(具体节点) 不会碰 playOutNode → destination 的主线
  const playOutNode = D.getPlayOutNode(), micSrc = D.getMicSrc();
  try { if (playOutNode && capDest) playOutNode.disconnect(capDest); } catch (e) {}
  try { if (micSrc && capMicGain) micSrc.disconnect(capMicGain); } catch (e) {}
  try { if (capMicGain) capMicGain.disconnect(); } catch (e) {}
  try { const pm = pianoMaster(); if (pm && capPianoTap) pm.disconnect(capPianoTap); } catch (e) {}
  try { if (capPianoSrc) capPianoSrc.disconnect(); } catch (e) {}
  try { if (capStream) for (const t of capStream.getTracks()) t.stop(); } catch (e) {}
  capMicGain = null; capPianoTap = null; capPianoSrc = null; capDest = null; capStream = null;
}
/** 每帧维护（由 app 的 tick 调用）：琴声/麦克风桥接补挂 + 麦克风增益门。 */
export function capTick() {
  if (!capDest) return;
  capEnsurePianoTap();
  capEnsureMicTap();      // 麦克风是惰性创建的（录音才建），同样要每帧兜一次
  const audioCtx = D.getAudioCtx();
  if (capMicGain && audioCtx) {
    const want = D.getRecState() === 'rec' ? 1 : 0;
    if (capMicGain.gain.value !== want) capMicGain.gain.setValueAtTime(want, audioCtx.currentTime);
  }
}
export function capStart() {
  if (capRec) return;
  capTapWarn = '';      // 上一段的接入失败提示不能带到这一段（收尾消息要用它，故在开头清而不是 capRelease）
  if (!capSupported()) {
    D.setStatus('此浏览器不支持录制动画（需要 MediaRecorder + canvas.captureStream）');
    pureHint('⚠ 此浏览器不支持录制');
    log.warn('cap', '浏览器不支持录制动画');
    return;
  }
  const audioCtx = D.getAudioCtx();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  let vstream;
  try { vstream = D.canvas.captureStream(60); }
  catch (e) { D.setStatus('录制失败：' + (e.message || e)); pureHint('⚠ 录制失败：' + (e.message || e)); log.error('cap', 'captureStream 失败：' + (e.message || e)); return; }
  capStream = vstream;
  let astream = null;
  try { astream = capBuildAudio(); } catch (e) { log.warn('cap', '音频汇流构建失败：' + (e.message || e)); }
  // 轨装配同样要包起来：这里若抛异常会直接冒出点击处理函数 → "点了没反应"（本文件
  // 曾因此静默失败一次）。宁可"只有画面没声音"也不能整个按钮失效，故失败即降级继续。
  const tracks = [];
  try {
    tracks.push(...vstream.getVideoTracks());
    if (astream) tracks.push(...astream.getAudioTracks());
  } catch (e) {
    log.error('cap', '录制轨装配失败：' + (e.message || e));
    pureHint('⚠ 录制音频轨装配失败');
  }
  if (!tracks.length) {
    capStream = null; capRelease();
    D.setStatus('录制失败：拿不到画布视频轨');
    pureHint('⚠ 录制失败：拿不到视频轨');
    log.error('cap', 'captureStream 未产出视频轨');
    return;
  }
  const mime = CAP_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  try {
    capRec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 12e6 });
  } catch (e) {
    capRec = null; capRelease();
    D.setStatus('录制失败：' + (e.message || e));
    pureHint('⚠ 录制失败：' + (e.message || e));
    log.error('cap', 'MediaRecorder 创建失败：' + (e.message || e));
    return;
  }
  capChunks = [];
  capRec.ondataavailable = (e) => { if (e.data && e.data.size) capChunks.push(e.data); };
  // 收尾是异步的（要读 blob 字节补 Duration）——必须自己接住 rejection，
  // 否则 onstop 里冒出的异常会静默吞掉，用户看到"点了停止但没下载"。
  capRec.onstop = () => {
    capFinish().catch((e) => {
      log.error('cap', '录制收尾失败：' + (e.message || e));
      D.setStatus('录制收尾失败：' + (e.message || e));
      pureHint('⚠ 录制收尾失败');
    });
  };
  capRec.onerror = (e) => { log.error('cap', '录制出错', { err: (e && e.error && e.error.name) || 'unknown' }); };
  try {
    capRec.start(1000);           // 1s 一片：长录制不会把全部数据堆到最后一次性出
  } catch (e) {
    capRec = null; capRelease(); capSetUI(false);
    D.setStatus('录制启动失败：' + (e.message || e));
    pureHint('⚠ 录制启动失败：' + (e.message || e));
    log.error('cap', 'MediaRecorder.start 失败：' + (e.message || e));
    return;
  }
  capHadAudio = !!astream;
  capStartedAt = Date.now();
  capTimer = setInterval(() => {
    if (capRec && pbClockEl) pbClockEl.textContent = capClock(Date.now() - capStartedAt);
  }, 500);
  capSetUI(true);
  // 声音自检：把"这段视频会有什么声音"当面说清楚。录完才发现是哑的最难排查——
  // MIDI 工程的 buffer 是静音时间轴，唯一声源是钢琴声；音频工程才是播放原声。
  const proj = D.getProject();
  const isMidi = !!(proj && proj.midiNotes && proj.midiNotes.length);
  const pianoReady = !!(pianoCtx() && pianoMaster());
  const cv = D.canvas;
  log.info('cap', '开始录制动画', {
    mime, size: cv.width + 'x' + cv.height,
    audioTrack: !!astream, isMidi, pianoReady, micAvail: !!D.getMicSrc(), micLive: D.getRecState() === 'rec',
  });
  if (!astream) {
    // ⚠ 判据是"有没有音频轨"，不是"有没有声音"（无轨才能确凿断言；有轨但全静音这里判不出来）。
    //   文案要跟判据对齐，别把"没有轨道"说成"没有声音"（2026-09-22 改）。
    pureHint('⚠ 本次没有音频轨');
    D.setStatus('⏺ 录制中…⚠ 本次没有音频轨，视频将无声；再点一次停止并保存');
  } else if (isMidi && !pianoReady) {
    pureHint('提示：MIDI 的声音来自「钢琴声」开关');
    D.setStatus('⏺ 录制中…提示：MIDI 工程的声音来自「钢琴声」，没开就是无声的；再点一次停止并保存');
  } else {
    D.setStatus('⏺ 正在录制动画…（画面只含动画；再点一次停止并保存）');
  }
}
async function capFinish() {
  if (capTimer) { clearInterval(capTimer); capTimer = null; }
  const dur = (Date.now() - capStartedAt) / 1000;
  const type = (capRec && capRec.mimeType) || 'video/webm';
  const blob = new Blob(capChunks, { type });
  capChunks = [];
  capRec = null;
  capRelease();
  capSetUI(false);
  if (!blob.size) { D.setStatus('录制结束但没有数据（画面可能始终未刷新）'); pureHint('⚠ 录制没有数据'); log.warn('cap', '录制结果为空'); return; }
  // 补 Duration（2026-09-15）：MediaRecorder 不写 Segment>Info>Duration，播放器会显示
  // 总时长 0:00、进度条拖不动（文件本身是好的，只是缺元数据）。见 proj/webm-duration.mjs。
  // 用墙钟时长：那是用户感知的录制长度；媒体时间在页面被节流时会更短，宁可略长也不要 0。
  // 任何失败都退回"原样下载"——绝不能因为补元数据把整段录制弄丢。
  let out = blob, noted = '';
  try {
    const raw = new Uint8Array(await blob.arrayBuffer());
    const fixed = patchWebmDuration(raw, Math.round(dur * 1000));
    if (fixed !== raw) { out = new Blob([fixed], { type }); noted = ' · 已补时长元数据'; }
    else log.warn('cap', '补时长被跳过（结构不是预期的 MediaRecorder WebM）');
  } catch (e) {
    log.warn('cap', '补时长失败（视频仍可播放，只是进度条可能拖不动）：' + (e.message || e));
  }
  const file = '动画-' + stampName() + '.webm';
  D.downloadBlob(out, file);
  // 收尾时把"哪一路没接进来"一并说清：录制开始时的提示可能被别的状态覆盖过，
  // 用户录完才发现是哑的（2026-09-22）。capTapWarn 由 capStart 清、capEnsure* 置。
  const tapNote = capTapWarn ? (' ⚠ ' + capTapWarn + '未接入') : '';
  D.setStatus('✓ 已导出动画视频 ' + file + '（' + dur.toFixed(1) + 's / ' + (out.size / 1048576).toFixed(1) + 'MB）' +
    (capHadAudio ? '' : ' ⚠ 无声音轨') + tapNote + noted);
  pureHint(capHadAudio ? ('✓ 已保存 ' + dur.toFixed(1) + 's 视频' + tapNote) : '⚠ 已保存，但这段没有声音');
  log.info('cap', '录制完成', { file, durSec: +dur.toFixed(1), mib: +(out.size / 1048576).toFixed(2), durationPatched: out !== blob });
}
export function capStop() { if (capRec && capRec.state !== 'inactive') capRec.stop(); }
export function capToggle() { capRec ? capStop() : capStart(); }

/** app.mjs 启动时调用一次：绑定本域的全部事件（主界面按钮 + 悬浮条 + document 级）。 */
export function bindCapture() {
  const bPure = docEl('btnPure');
  if (bPure) bPure.addEventListener('click', togglePure);
  const bRecord = docEl('btnRecord');
  if (bRecord) bRecord.addEventListener('click', capToggle);
  // 纯净模式悬浮条：退出 / 录制。鼠标动一下就亮出来（静止自动淡出，避免被录进视频）
  const pbExit = docEl('pbExit');
  if (pbExit) pbExit.addEventListener('click', exitPure);
  if (pbRecEl) pbRecEl.addEventListener('click', capToggle);
  // 鼠标/触摸一动就亮出悬浮条：触摸屏没有 pointermove（或只在按下时才发），
  // 所以 pointerdown 也要接——否则手机上进了纯净模式就再也点不到"退出"。
  document.addEventListener('pointermove', pureReveal, { passive: true });
  document.addEventListener('pointerdown', pureReveal, { passive: true });
  // Esc：全屏态由浏览器自己退，这里兜"全屏被拒"或"非全屏的纯净模式"两种情况
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pureOn && !document.fullscreenElement) exitPure();
  });
  // 用户在浏览器里按 Esc / F11 退出全屏 → 一并退出纯净模式（否则界面全没了却不在全屏，很迷惑）
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && pureOn) exitPure();
    else setTimeout(() => D.applyResize(), 60);
  });
}
