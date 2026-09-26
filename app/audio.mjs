// ─────────────────────────────────────────────────────────────────────────────
// app/audio.mjs —— 音频路由域（2026-09-15 从 app.mjs 抽成域模块，① 状态收敛第七域）
//
// 管的是"声音从哪来、到哪去"：AudioContext 生命周期、mic/播放两条总线汇入
// analyser（检测数据源）的路由开关、播放输出节点、底噪校准。
//
// ── 状态归属 ──
//   audioCtx / stream / analyser / analyserRms / ctxSr / micSrc / micGain /
//   playGain / activeRoute / pendingMic / envBase / playOutNode / origPlayVol
//   全部封在这里，export let 只读导出——**写点只在 initAudio / startMicRoute /
//   routeNow / autoCalib / setOrigPlayVol 这几个具名函数里**（envBase 只有一处
//   写点却要全文件可写；origPlayVol 的"改值+落盘+更新 gain"散在滑杆回调里三行）。
//   analyser 的全部读引用（processBlock / pullWaveform / spectrum / snapshot）零改动。
//
// ── 刻意不搬 ──
//   running / dbg.run：写点散布在 record 状态迁移的 9 处（它们总是成对写），搬走
//   只能换成 9 个 setter 调用，收益为零——按"写点是否散布全文件"的尺子留原地。
//   测量/显示组（curProm/statsMin/dbg…）：与 snapshot/processBlock 的显示逻辑强耦合。
//
// 跨域依赖注入：analyser 的 fftSize 来自检测配置、校准后要刷新门控 UI。
// ─────────────────────────────────────────────────────────────────────────────

import log from '../log.mjs';
import { dbOf } from '../dsp/detect.mjs';

let D = {
  getCfgWindow: () => 4096,      // analyser.fftSize = 检测窗长（两处必须一致）
  isGateAuto: () => true,
  syncGateUI: () => {},
  onSampleRate: () => {},        // ctxSr 就绪后通知（app 侧写 dbg.sr 供角标显示）
};
/** app.mjs 启动时接线。 */
export function configureAudio(deps) { D = Object.assign({}, D, deps); }

// ===== 状态（只读导出）=====
export let audioCtx = null;
export let stream = null;
export let analyser = null;             // 检测数据源：mic/播放两条总线都汇入它
export let analyserRms = null;          // 能量专用 analyser（底噪校准/音量读数）
export let ctxSr = 44100;
export let micSrc = null;               // MediaStreamSourceNode(mic)
export let micGain = null;              // mic 汇入 analyser 的增益(路由开关)
export let playGain = null;             // 播放源汇入 analyser 的增益(路由开关)
export let activeRoute = 'none';        // 'mic' | 'play' | 'none'
// mic 是否【正在喂 analyser】（= micGain 被开成 1 且 micSrc 已接上）。
// 与 activeRoute 的区别：停录/试听时 routeNow 没被调用，activeRoute 还留在 'mic'，
// 但 micGain 已被 stopLiveFeeding 关掉 —— 校准底噪这类"必须真的在采麦克风"的动作
// 只能信这个标志（否则会采到全零，报出一次假的校准成功）。2026-09-16 新增。
export let micFeeding = false;
export let pendingMic = null;           // 已授权未接线 mic stream
export let envBase = 0;                 // 环境RMS基线(绝对能量)。0=尚未校准，由 autoCalib 填充。
                                        // 注：原为写死的 0.002，使 startMicRoute 的 `envBase <= 1e-4`
                                        // 恒为假 → 自动校准从未真正触发过。改 0 后首次即校准。
export let playOutNode = null;          // 常驻共享播放主输出（→ destination，见 ensurePlayOut）
export let origPlayVol = 1;             // 原音频播放音量(钢琴块"钢琴声"模式对照听用)
// ⚠️ 恢复逻辑必须与声明同在：setOrigPlayVol 每次拖动都落盘，但若初始化不读回来，
// 启动时滑杆的首次 updVol() 会用默认值 1 反把存档覆盖掉（2026-09-15 实测：
// "刷新一下就回到默认 100%" —— 就是搬模块时把这行弄丢了）。
try {
  const v0 = parseFloat(globalThis.localStorage.getItem('ydyi_orig_vol'));
  if (Number.isFinite(v0)) origPlayVol = Math.max(0, Math.min(1, v0));
} catch (e) {}

let stopPlayFn = null;                  // 播放停止钩子。⚠️ 当前全工程【没有设置点】，
                                        // 只有 routeNow 里的清空——原样保留不删
                                        //（删除属于死代码清理，另行确认）。

async function requestMic() {
  const constraints = {
    audio: {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
    },
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
}

export async function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  ctxSr = audioCtx.sampleRate;
  D.onSampleRate(ctxSr);
  log.info('audio', '音频上下文已创建', { sampleRate: ctxSr });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = D.getCfgWindow();
  analyser.smoothingTimeConstant = 0;
  analyserRms = audioCtx.createAnalyser();
  analyserRms.fftSize = 1024;
  analyserRms.smoothingTimeConstant = 0.2;
  // mic 与播放两条总线都汇入 analyser(检测数据源)。输出不需接喇叭(避免实时 mic 啸叫)。
  micGain = audioCtx.createGain(); micGain.gain.value = 0;
  playGain = audioCtx.createGain(); playGain.gain.value = 0;
  micGain.connect(analyser); playGain.connect(analyser);
}

// 路由：把"谁喂 analyser"切到目标来源。
export function routeNow(target) {
  activeRoute = target;
  micFeeding = target === 'mic' && !!micSrc;   // 见 micFeeding 声明处的说明
  if (stopPlayFn) { const f = stopPlayFn; stopPlayFn = null; try { f(); } catch (e) {} }
  if (micGain) micGain.gain.setValueAtTime(target === 'mic' ? 1 : 0, audioCtx.currentTime);
}

// 开始 mic 实时检测：接线 + 校准底噪(只在需要时)
export async function startMicRoute() {
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!micSrc) {
    if (!pendingMic && !stream) { stream = await requestMic(); }
    const ms = pendingMic || stream;
    micSrc = audioCtx.createMediaStreamSource(ms);
    micSrc.connect(micGain); micSrc.connect(analyserRms);
  }
  routeNow('mic');
  if (envBase <= 1e-4) await autoCalib();
}

/** 需要 mic stream 的地方统一走这里：没申请过就申请，返回缓存的 stream。
 *  （把 startRecording 里"申请+缓存"两行收拢成一句。） */
export async function ensureMic() {
  if (!stream && !pendingMic) await requestMic();
  pendingMic = pendingMic || stream;
  return pendingMic || stream;
}

// 自动校准：采样 analyserRms 约 0.8s 环境能量，取均值作为底噪基线。
// 得到结果后同步到门控显示（自动模式门槛 = 底噪 + 3.5dB）。失败/无麦则忽略。
export function autoCalib() {
  return new Promise((resolve) => {
    if (!analyserRms) { resolve(); return; }
    const buf = new Float32Array(analyserRms.fftSize);
    const n = 20;
    let sum = 0, count = 0;
    const loop = () => {
      if (!analyserRms) { resolve(); return; }
      analyserRms.getFloatTimeDomainData(buf);
      let s = 0; for (let k = 0; k < buf.length; k++) s += buf[k] * buf[k];
      sum += Math.sqrt(s / buf.length);
      count++;
      if (count < n) setTimeout(loop, 40);
      else {
        envBase = Math.max(sum / Math.max(count, 1), 1e-5);
        log.info('gate', '底噪校准完成', { envRms: +envBase.toFixed(6), envDb: Math.round(dbOf(envBase)) });
        if (D.isGateAuto()) D.syncGateUI(); resolve();
      }
    };
    loop();
  });
}

export function stopLiveFeeding() {
  micFeeding = false;
  if (micGain) { try { micGain.gain.setValueAtTime(0, audioCtx.currentTime); } catch (e) {} }
}

export function ensurePlayOut() {
  if (!playOutNode) { playOutNode = audioCtx.createGain(); playOutNode.gain.value = origPlayVol; playOutNode.connect(audioCtx.destination); }
  return playOutNode;
}

/** 改原声音量：改值 + 落盘 + 同步 gain。 */
export function setOrigPlayVol(v) {
  origPlayVol = v;
  try { localStorage.setItem('ydyi_orig_vol', String(origPlayVol)); } catch (e) {}
  if (playOutNode) playOutNode.gain.value = origPlayVol;
}
