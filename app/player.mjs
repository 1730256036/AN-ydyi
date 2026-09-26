// ─────────────────────────────────────────────────────────────────────────────
// app/player.mjs —— 播放器引擎（2026-09-15 从 app.mjs 抽成域模块）
//
// 管的是"一段 buffer 的播放生命周期"：装载/清空片段、播放/暂停/拖动/重播、
// 播完停在末尾；以及驱动主循环的 playInfo.on 与视图切换 appView。
//
// ── 状态归属（① 状态收敛第五域）──
//   pl        引擎状态对象（字段由本模块的函数维护；app 侧只读）
//   playInfo  { on } —— tick 据此维持 RAF 循环
//   appView   'live' | 'play'（只读导出；改写走 setView）
//   curClip   当前片段（只读导出；改写走 adoptClip / resetClip）
//   clipSeq   片段代际（只读导出；同上）
//   playRate  播放倍速（只读导出；改写走 setPlayRate）
//   pitchTape 倍速是否连音高一起变（只读导出；改写走 setPitchTape）
//
// ── 倍速（2026-09-17）──
// 两条口径，靠 pitchTape 切：
//   · false（默认，变速不变调）：播放前把整段 PCM 用 dsp/stretch.mjs 重排成新 buffer，
//     播放速率恒为 1；音高不动，慢放能拿去练耳。
//   · true（磁带式）：直接把倍速交给 AudioBufferSourceNode.playbackRate 重采样，
//     音高跟着变（0.5× 低八度）——不做任何缓冲处理，零成本。
// 【时间轴口径】无论哪条口径，pl.pos / pl.dur / nowPosSec / 工程帧查表一律是**原时长**：
// 变调档下 buffer 就是原 buffer（时间轴=原时长，天然对齐）；不变调档下拉伸 buffer 的
// 内部时间被拉长了，故起播点要除以倍率换算。所有"按倍速推进"只发生在 plPos() 里。
//
// 【MIDI 工程】buffer 本身是静音的（声音由 anim/piano-sound.mjs 合成琴声），所以
// 永远走磁带档（拉伸静音毫无意义还费内存），但琴声的音高是音符决定的、不随倍速变——
// 界面据此对静音时间轴隐藏「变调」开关（见 app.mjs 的控件作用域约定）。
// 导出 pl / playInfo 是**对象**：外部能读字段、也能改字段（这是本模块边界的固有性质：
// const 对象本来人人可改），但"换掉整个对象"这种事被模块边界挡掉了。真正的
// 片段装卸入口收敛成 adoptClip() / resetClip() 两个具名函数——散落在
// loadClip 和 newSession 里各写一遍（漏改一处就是静默的状态不同步）。
//
// ── 留在 app.mjs 的 ──
// loadClip / newSession / isProjPlayback 是**编排者**：loadClip 要跨 record
// （abortRecordSession）、proj（openedProjId 作废）、分析（autoAnalyzeClip）三个域，
// 不属于本域。它们通过 adoptClip/resetClip 改本域状态。
//
// 跨域依赖一律注入（不反向 import 别的域，域间会成环）。
// ─────────────────────────────────────────────────────────────────────────────

import log from '../log.mjs';
import { timeStretch } from '../dsp/stretch.mjs';

const docEl = (() => {
  const cache = {};
  return (id) => (cache[id] || (cache[id] = document.querySelector('#' + id)));
})();

let D = {
  getAudioCtx: () => null,
  getPlayGain: () => null,
  ensurePlayOut: () => null,
  routeNow: () => {},
  stopLiveFeeding: () => {},
  ensureLoop: () => {},
  setStatus: () => {},
  updateTransportUI: () => {},
  setNoteRate: () => {},          // 把倍速转告琴声模块（时值/提前量按倍速缩放）
  snapshot: () => ({}),
  renderTemplate: () => {},
  getRecState: () => 'idle',
  isProjPlayback: () => false,
};
/** app.mjs 启动时接线。 */
export function configurePlayer(deps) { D = Object.assign({}, D, deps); }

// ===== 状态（只读导出）=====
export const pl = { clip: null, playing: false, pos: 0, dur: 0, src: null, out: null, baseCtxPos: 0, manualStop: false };
export const playInfo = { on: false };
export let appView = 'live';            // 'live' 录音机界面 | 'play' 播放器界面(有片段)
export let curClip = null;              // 当前片段 {name, buffer, blob, dur}
export let clipSeq = 0;                 // 片段代际：录音/导入/新建时自增；动画模板据此复位曲线(resetKey)
export let playRate = 1;                // 播放倍速（1=原速）
export let pitchTape = false;           // false=变速不变调(默认) | true=磁带式(音高跟着变)

/** 界面档位（index.html 的 <option> 必须与这份清单一致；未知值一律回退 1×）。 */
export const RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

// ===== 播放头 =====
/** 当前播放位置（秒）——时间轴单位恒为【原时长】，倍速下按 rate 倍推进。
 *  这是全项目唯一的播放头推进实现：app 的 nowPosSec / 走带条 / 快照 audioMs 都走它，
 *  倍速改动只影响这一处。 */
export function plPos() {
  if (!pl.clip) return 0;
  if (!pl.playing) return pl.pos;
  const audioCtx = D.getAudioCtx();
  const adv = audioCtx ? audioCtx.currentTime - pl.baseCtxPos : 0;
  return Math.min(pl.dur, pl.pos + (adv > 0 ? adv * playRate : 0));
}

// ===== 片段装卸（唯一写入口）=====
/** 装载片段：自增代际 + 写 curClip / pl。 */
export function adoptClip(clip) {
  clipSeq++;
  stretchCache = null;                  // 换片段 → 拉伸缓存（可能上百 MB）立即释放
  curClip = clip;
  pl.clip = clip; pl.pos = 0; pl.dur = clip.buffer.duration; pl.playing = false;
  // 换片段必然先 teardown（或本来就空闲）→ 播放键必须回到「▶ 播放」。
  // 漏了这步的话：上一段还在播时装载新片段，按钮残留「⏸ 暂停」但实际没在播，
  // 点一下才复位（2026-09-19 导入即播守卫测试揪出）。
  setPlayUI();
}
/** 清空片段回到无片段态：自增代际 + 清零 pl。 */
export function resetClip() {
  clipSeq++;
  stretchCache = null;
  curClip = null; pl.clip = null; pl.playing = false; pl.pos = 0; pl.dur = 0;
}

// ===== 倍速（写入口）=====
/** 改倍速。正在播就地从当前播放头按新速率接着播（不回到 0、不打断"听到哪儿了"）。 */
export function setPlayRate(r) {
  const v = RATES.includes(Number(r)) ? Number(r) : 1;
  if (v === playRate) return;
  applyPlaybackChange(() => { playRate = v; }, '倍速', v + '×');
}
/** 切换「变调」（磁带式）口径。同样就地续播。 */
export function setPitchTape(on) {
  const v = !!on;
  if (v === pitchTape) return;
  applyPlaybackChange(() => { pitchTape = v; }, '变速变调', v ? '开' : '关');
}
/** 改播放口径的公共收尾：先冻结播放头（要用旧的 rate 算），再按需重启音源。 */
function applyPlaybackChange(mutate, label, valueText) {
  const wasPlaying = pl.playing && !!pl.clip;
  const pos = plPos();
  mutate();
  pl.pos = pos;
  log.debug('play', label, { value: valueText, playing: wasPlaying, posSec: +pos.toFixed(2) });
  if (wasPlaying) playerPlay();          // 内部会 teardown 旧音源 → 从 pl.pos 接着放
  else { D.setNoteRate(1); D.updateTransportUI(); setPlayUI(); }
}

// ===== 播放用 buffer（倍速不变调的那条口径）=====
// 只缓存最近一份：切档就整段重排，留着旧的纯属占内存（0.25× 的拉伸 buffer 是原长 4 倍）。
let stretchCache = null;                // { clip, rate, buffer }
// 拉伸后样点上限（约 200MB Float32）。超了就不硬撑，改走磁带档并把原因说出来——
// 静默换口径才是真的坑（用户会以为"这一档听不出音高不变"是功能坏了）。
const MAX_STRETCH_SAMPLES = 50e6;

function playBuffer() {
  const clip = pl.clip;
  const audioCtx = D.getAudioCtx();
  // 磁带档 / 原速 / 静音时间轴(MIDI 工程：buffer 里没有声音，拉伸毫无意义) → 原 buffer
  if (!audioCtx || pitchTape || playRate === 1 || clip.silent) return clip.buffer;
  if (stretchCache && stretchCache.clip === clip && stretchCache.rate === playRate) return stretchCache.buffer;
  const src = clip.buffer;
  const outLen = Math.round(src.length / playRate);
  if (outLen > MAX_STRETCH_SAMPLES) {
    D.setStatus('音频过长，这一档改用磁带式（音高跟着变）播放；想听不变调的慢放请用短一些的片段');
    log.info('play', '变速不变调跳档：拉伸后样本数超上限', { outLen, rate: playRate, sec: +src.duration.toFixed(1) });
    return src;
  }
  try {
    const t0 = performance.now();
    const pcm = timeStretch(src.getChannelData(0), playRate, src.sampleRate);
    const buf = audioCtx.createBuffer(1, pcm.length, src.sampleRate);
    buf.copyToChannel(pcm, 0);
    stretchCache = { clip, rate: playRate, buffer: buf };
    log.debug('play', '变速不变调：整段重排完成', {
      rate: playRate, sec: +src.duration.toFixed(2), ms: Math.round(performance.now() - t0),
    });
    return buf;
  } catch (e) {
    console.error('timeStretch', e);
    D.setStatus('变速处理失败，这一档改用磁带式播放');
    log.error('play', '变速不变调失败，回退磁带档：' + (e && e.message || e), { rate: playRate });
    return src;
  }
}

// ===== 视图切换 =====
export function setView(v) {
  appView = v;
  const liveC = docEl('liveCtrls'), playC = docEl('playCtrls');
  if (liveC) liveC.style.display = v === 'live' ? '' : 'none';
  if (playC) playC.style.display = v === 'play' ? '' : 'none';
  const nm = docEl('clipName'); if (nm) nm.textContent = v === 'play' && curClip ? curClip.name : '';
  // 主按钮文案由 updateTransportUI 统一维护（setView 只负责视图显隐），这里补一轮保证一致性
  try { D.updateTransportUI(); } catch (e) {}
  const clock = docEl('recClock');
  if (clock) clock.classList.toggle('on', D.getRecState() === 'rec');
}

// ===== 播放器引擎（暂停/继续/重播/拖动 seek/播完停末尾）=====
export function teardownPlay() {
  if (pl.src) {
    pl.manualStop = true;
    try { pl.src.stop(); } catch (e) {}
    pl.src.onended = null;
    try { pl.src.disconnect(); } catch (e) {}
  }
  // 关键：pl.out = playOutNode 是【常驻共享主输出】，永久连向 destination。
  // 绝不能在 teardown 里 disconnect 它——一旦断开就不会自动重连，
  // 会导致第一次播放有声、之后的播放全部静音。
  pl.src = null; pl.playing = false;
  playInfo.on = false;
  D.setNoteRate(1);   // 停播即回到实时口径：录音/回声期间琴声必须按真实时间走
}
export function playerPlay() {
  if (!pl.clip) return;
  const audioCtx = D.getAudioCtx();
  if (!audioCtx) return;
  if (pl.src) teardownPlay();
  if (pl.pos >= pl.dur - 0.02) pl.pos = 0;   // 已在末尾 → 从头
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const buf = playBuffer();                  // 倍速不变调时这里是重排后的 buffer
  const tapeLike = buf === pl.clip.buffer;   // 原 buffer = 磁带/原速口径（速率交给重采样）
  const src = audioCtx.createBufferSource(); src.buffer = buf;
  // 两条口径的换算：· 原 buffer → 播放速率就是倍速，起播点就是时间轴位置本身；
  //                · 拉伸 buffer → 内部时间已被拉长，速率恒 1，起播点要除以倍率。
  // 两者对时间轴的推进都是 rate 倍（见 plPos），故上层口径完全一致。
  src.playbackRate.value = tapeLike ? playRate : 1;
  const out = D.ensurePlayOut();
  const offset = tapeLike ? pl.pos : pl.pos / playRate;
  src.connect(D.getPlayGain());   // 喂 analyser → 驱动音高动画
  src.connect(out);               // 喇叭出声
  D.routeNow('play'); D.stopLiveFeeding();
  const pg = D.getPlayGain();
  if (pg) pg.gain.setValueAtTime(1, audioCtx.currentTime);
  pl.src = src; pl.out = out;
  pl.baseCtxPos = audioCtx.currentTime;
  pl.manualStop = false;
  src.onended = () => {
    if (pl.manualStop) return;
    pl.playing = false; pl.pos = pl.dur; playInfo.on = false;
    setPlayUI(); D.updateTransportUI(); D.setStatus('播放结束');
  };
  playInfo.on = true; pl.playing = true;
  D.ensureLoop();
  src.start(0, offset);
  D.setNoteRate(playRate);        // 琴声时值/提前量按倍速缩放（钢琴块按时间轴触发）
  log.debug('play', '开始播放', {
    posSec: +offset.toFixed(2), durSec: +pl.dur.toFixed(2), rate: playRate,
    tape: pitchTape, useProj: D.isProjPlayback(),
  });
  setPlayUI(); D.updateTransportUI();
}
export function playerPause() {
  if (!pl.playing) return;
  pl.pos = plPos();                 // 按旧倍速结算到当前播放头（必须在 teardown 之前）
  pl.manualStop = true;
  teardownPlay();
  pl.playing = false; playInfo.on = false;
  setPlayUI(); D.updateTransportUI();
}
export function playerToggle() { pl.playing ? playerPause() : playerPlay(); }
export function playerSeek(t) {
  if (!pl.clip) return;
  t = Math.max(0, Math.min(pl.dur, t));   // t 是【原时长】口径的位置
  const wasPlaying = pl.playing;
  const atEnd = t >= pl.dur - 0.02;   // 拖到末尾
  pl.manualStop = true;
  if (pl.src) teardownPlay();
  pl.playing = false; playInfo.on = false;
  pl.pos = t;
  log.debug('play', '拖动时间线', { posSec: +t.toFixed(2), wasPlaying, atEnd });
  if (wasPlaying && !atEnd) playerPlay();
  else {
    // 拖到末尾 或 本来就没在播：停在当前位置不动。
    // 若是从播放中拖到末尾，就"播完停在末尾"（暂停态），而非从头重播。
    D.updateTransportUI(); setPlayUI();
    if (atEnd) D.setStatus('已到末尾 · 点 ▶ 从头播放');
    // 暂停态 RAF 循环已停，需手动补一帧让曲线游标立即跟随到新位置
    try { D.renderTemplate(D.snapshot(), performance.now()); } catch (e) {}
  }
}
export function playerReplay() { pl.pos = 0; playerPlay(); }
export function setPlayUI() {
  const pbtn = docEl('btnPP');
  // 高亮跟"播放态"走：index.html 里 .btn-play.play 的注释就是"进入播放态=冷强调实心"，
  // 与录音键 .btn-rec.rec-stop（录制中才变红）同一套语义。写成 !pl.playing 的话，
  // 结果是"暂停态反而高亮、正在播放却是素描边"（若原本就想要
  // "空闲时高亮播放键"，把这行的 pl.playing 改回 !pl.playing 即可）。
  if (pbtn) { pbtn.textContent = pl.playing ? '⏸ 暂停' : '▶ 播放'; pbtn.classList.toggle('play', pl.playing); }
}
