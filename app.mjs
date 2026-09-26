// ydyi 主应用 —— 采集 + 实时检测 + 录音/回放/导入 统一传输 + 动画模板驱动
import { freqToNote } from './dsp/core.mjs';
// 门控阈值公式、置信状态机、中值平滑统一由 dsp/detect.mjs 提供：
// 实时(本文件)与离线整段分析(dsp/analyze*.mjs 的 worker)共用同一份实现，
// 检测公式只有这一份实现（各处都从这里取，不各写一份——改口径时容易漏掉一边）。
import { createDetector, dbOf, gateThresh } from './dsp/detect.mjs';
import anim from './anim/registry.mjs';
import pitchOrb from './anim/pitchOrb.mjs';
import pitchTrail from './anim/pitchTrail.mjs';
import pianoBlocks, { segmentPoints, getBlockAlgo } from './anim/pianoBlocks.mjs';
import { analyzeOffline } from './dsp/analyze-pool.mjs';
import { parseSMF, writeSMF } from './dsp/smf.mjs';
import { computeEnv } from './dsp/envelope.mjs';
import { availableKernels, resolveKernel } from './dsp/kernels/index.mjs';
import * as proj from './proj/project.mjs';
import { patchWebmDuration } from './proj/webm-duration.mjs';
import { appendChunked, copyChunked } from './proj/pcm-chunks.mjs';
import { getAudioContext as pianoCtx, getOutputNode as pianoMaster, setPlayRate as setNotePlayRate } from './anim/piano-sound.mjs';
import log from './log.mjs';
// 域模块（① 状态收敛）：每个域的状态封在自己文件里，本文件只读 + 调具名函数。
import { echoOn, echoNotes, echoFallMs, echoFeed, setEchoEnabled, setEchoFall, configureEcho } from './app/echo.mjs';
import { capTick, bindCapture, configureCapture } from './app/capture.mjs';
import { configureFileStore, listArchives, getArchive, saveArchive, deleteArchive, renameArchive, migrateFromIdb } from './app/file-store.mjs';
import {
  toggleLibPanel, configureLibrary, libProjItem, libIsFav, libToggleFav, openLibGroupPicker,
} from './app/library.mjs';
import { logBind, configureLogPanel } from './app/logpanel.mjs';
import {
  pl, playInfo, appView, curClip, clipSeq, playRate, pitchTape,
  setView, adoptClip, resetClip, plPos, setPlayRate, setPitchTape,
  teardownPlay, playerPlay, playerPause, playerToggle, playerSeek, playerReplay, setPlayUI,
  configurePlayer,
} from './app/player.mjs';
import {
  projPanelVisible, projTogglePanel, projRefreshList, projSyncSaveCurBtn, bindProjPanel, configureProjPanel,
} from './app/proj-panel.mjs';
import {
  audioCtx, analyser, ctxSr, micSrc, playGain,
  envBase, playOutNode, origPlayVol, micFeeding,
  initAudio, routeNow, startMicRoute, autoCalib, ensureMic,
  stopLiveFeeding, ensurePlayOut, setOrigPlayVol, configureAudio,
} from './app/audio.mjs';
anim.register(pitchOrb);
anim.register(pitchTrail);
anim.register(pianoBlocks);

// ===== 配置（全可调，不写死）=====
const CFG = {
  fmin: 40, fmax: 8000,        // 检测范围（默认宽带；未来音域扩展无需改代码）
  windowSize: 4096,             // 峰追踪/YIN 窗长（93ms@44.1k）
  // 注：帧移(hop)与中值窗不在这里——它们的唯一实现是 dsp/kernels 与 dsp/detect.mjs
  //     （detect.mjs 的 smoothK() 随灵敏度动态算）。此处曾有三个从未被读取的副本
  //     （hopSize/smoothK/fpsSmooth），2026-09-22 删掉，免得改这里却毫无效果。
  voicing: 85,                  // YIN 家族内核的周期搜索阈值(%)，越低越宽松。⚠ 只对 yin-dual/pyin
                                // 生效（都按 1-voicing/100 当绝对门）；mpm 的 threshold 是另一个
                                // 量（NSDF 主峰相对高度门，固定 0.9），故调它 MPM 不会跟着变。
  noteHoldMs: 260,              // 音名显示保持时间
};

// ===== 灵敏度总开关（0 宽松 … 100 严格），联动门控阈值 =====
// 核心：音高检测必须剔除"有能量但不是音"的噪音(拍桌/响指/说话)。
// 判定是否"有音高"的最本质信号 = 周期性 pitch strength(YIN 的 cmMin 谷值 str)：
//   口哨/人声 → 强周期, str 谷值极低；拍桌/响指/宽带 → 无周期, str 谷值高。
// 故门控以 str 为主判据（各档都要求较强周期），purity/prom 仅作辅助。
const SENS = { val: 70 };                 // 默认适中偏严；由滑杆写入

// ===== 收音门槛（对标同类应用「最低收音分贝」）=====
// 能量门的本质：气音和环境底噪的共同点是能量低，一个音量门槛就能滤掉绝大部分。
//   auto=true  → 跟随 autoCalib() 学到的环境底噪（envBase * 1.5）
//   auto=false → 用户手动指定 GATE.db
// 换算：满量程 rms=1 记为 90dB，沿用「音量」读数既有标定，保证两处数字同一把尺子。
// dbOf 与检测器共用同一定义(dsp/detect.mjs)，避免两处标定各写一份。
const GATE = { auto: true, db: 40 };

// ===== 检测算法（内核）选择 =====
// 默认 YIN·频谱融合；工具条下拉可切换(kernelSel → setKernel)。切换后：
//   - 实时检测器 det 置空重建 → 录音/实时立即用新算法；
//   - 若处于播放工程，重跑离线整段分析(按新算法重算曲线)，保证实时/离线同源。
const KERNEL_DEFAULT = 'yin-dual';
let kernelId = (() => {
  try { const s = localStorage.getItem('ydyi_kernel'); return s || KERNEL_DEFAULT; } catch (e) { return KERNEL_DEFAULT; }
})();
if (!availableKernels().some(k => k.id === kernelId)) kernelId = KERNEL_DEFAULT;

// ===== 实时检测器（与离线整段分析共用 dsp/detect.mjs 的 createDetector）=====
// 音频上下文就绪后惰性创建：门控状态机/中值平滑/能量门全在检测器内部，
// 本文件只负责喂窗、更新读数 UI 与把状态同步给渲染层。
let det = null;
function ensureDetector() {
  if (det || !audioCtx) return det;
  det = createDetector({
    sampleRate: ctxSr, fmin: CFG.fmin, fmax: CFG.fmax,
    windowSize: CFG.windowSize, voicing: CFG.voicing, sens: SENS.val,
    kernel: kernelId,         // 检测算法（见 setKernel / 工具条下拉）
  });
  syncDetectorEnergy();
  return det;
}
// 能量门参数(自动/手动 + 底噪 envBase + 手动 dB)写入检测器。
// 门槛 UI 每次刷新(syncGateUI)都调一次，保证显示与判定同源。
function syncDetectorEnergy() {
  if (!det) return;
  det.setEnergy({ mode: GATE.auto ? 'auto' : 'manual', envRms: envBase, db: GATE.db });
}
// 当前生效阈值(供徽标/提示显示)：优先取检测器内的实例阈值
function gateNow() { return det ? det.gate : gateThresh(SENS.val); }

// ===== DOM =====
const $ = (s) => document.querySelector(s);
const canvas = $('#pitchCanvas');
const ctx = canvas.getContext('2d');
const canvasWrap = canvas.parentElement;                 // .canvas-wrap(尺寸基准)
const canvasGL = $('#pitchCanvasGL');                    // WebGL 模板专用(与2D互斥显隐)
// 高分屏适配：backing store = CSS 尺寸 × dpr，坐标系经 setTransform 缩放回 CSS 像素。
// 模板收到的 w/h 仍是 CSS 像素，绘制代码零改动；上限 3 防 4K 缩放怪值把像素量炸掉。
const DPR = () => Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
// round 后再赋值：dpr 为小数(1.25/1.5)时 canvas.width 会取整，若用未取整值比较会每帧误判"尺寸变了"
const backingSize = (w, h) => [Math.round(w * DPR()), Math.round(h * DPR())];
const noteEl = $('#noteDisplay'), centsEl = $('#centsDisplay'), hzEl = $('#hzDisplay');
// 画布内不重复画读数角标(#minVal/#maxVal/#ampVal)（会挡住钢琴）：
// 它的「最低/最高」与传输条右侧的「已测 – 」(lowStatEl/highStatEl)重复，读数只看那一处。
const lowStatEl = $('#lowStat'), highStatEl = $('#highStat'), fpsEl = $('#fpsBadge');
const overlay = $('#overlay'), btnPermit = $('#btnPermit'), btnSkipPermit = $('#btnSkipPermit');
// #app / #pureBar / #pbClock / #pbRec / #pbHint 归 app/capture.mjs 自持（域模块自己查 DOM）

// ===== 状态 =====
// audioCtx / stream / analyser / analyserRms / ctxSr / micSrc / micGain / playGain /
// activeRoute / pendingMic / envBase / playOutNode / origPlayVol 已搬到 app/audio.mjs
// （2026-09-15「① 状态收敛」第七域）——本文件只读（import 的只读绑定）。
let running = false;

// 显示状态（门控与平滑状态在检测器 det 内部，见 ensureDetector）
let curProm = 0;                     // 当前峰突出度(供渲染)
let lastGoodFreq = NaN;              // 平滑后用于显示(由检测器同步而来)
let noteShown = '--';
let noteHoldUntil = 0;
let seenAny = false;
let statsMin = NaN, statsMax = NaN;  // 实测音域（Hz，显示用）

let rafId = null;
let lastT = performance.now();
let fpsAcc = 0, fpsCnt = 0, fpsVal = 0;
const W = () => canvas.clientWidth, H = () => canvas.clientHeight;

// 诊断信息（渲染到 fpsBadge）
const dbg = { rms: 0, prom: 0, purity: 0, str: 1, conf: 0, voiced: false, fA: NaN, run: false, sr: 0 };

// 自动/口哨/人声 三档：**仍是占位、未实现**（全工程没有任何读取它的消费点，切了对检测零影响）。
// 2026-09-16 起在 index.html 里直接 disabled + title 写明"尚未实现"，不再给"能点、能高亮、
// 却什么都不会发生"的假象（若再打一条"切换到 XX 模式"的日志，看日志会误判成生效了）。
// 真要落地应据此调检测参数：口哨基频偏高、谐波纯（可抬高 fmin / 放宽 purity 要求）；
// 人声低音男声需要压低 fmin。实现时属于检测口径变更 → 必须真实素材实测校准，别凭猜改门控。

// ===== 音频路由（requestMic/initAudio/routeNow/startMicRoute/autoCalib/ensureMic）
// 已搬到 app/audio.mjs（2026-09-15「① 状态收敛」第七域）。本文件只读其状态 +
// 调具名函数；analyser/ctxSr/envBase 等的读引用全部零改动。

// 「校准底噪」按钮与手动「自动」勾选均触发此回调。
// 校准需要麦克风【真的在采集】：analyserRms 只有在 micSrc 接上且 micGain>0 时才有内容。
// 只查 analyserRms 是否存在是不够的 —— 只导入过音频(没录过音)时它也已被 initAudio 创建，
// 于是会采到全零 → envBase 落到地板 1e-5、状态栏却报"✓ 已重新校准底噪"。
// 这是假校准（真正的校准发生在下一次录音的 startMicRoute），会让人误判门槛已按现场调好
// ——2026-09-16 改用 audio 域的 micFeeding 判据，不满足就明说。
function onManualCalib() {
  if (!micFeeding) {
    setStatus('校准底噪需要麦克风在采集：请先点「● 开始录音」（录音中/暂停录音时校准最准；试听中不行）');
    if (GATE.auto) syncGateUI();
    return;
  }
  autoCalib().then(() => setStatus(GATE.auto ? '✓ 已重新校准底噪，收音门槛已跟随' : '✓ 已测定环境底噪'));
}

// ===== 块处理：从 analyser 拉一块 time-domain 做检测 =====
let lastTD = null;    // 最近一帧时域波形(供 waveform 类动画复用，免重复读 analyser)
function pullWaveform() {          // 只拉波形(工程回放模式：波形/音量用，不跑检测)
  if (!analyser) return;
  const n = analyser.fftSize;
  const td = new Float32Array(n);
  analyser.getFloatTimeDomainData(td);
  lastTD = td;
}
function processBlock() {          // 实时检测：拉窗 → 门控 → 平滑
  pullWaveform();
  // 录音中：把每窗时域 PCM 追加进累积缓冲（试听/暂停回拖的数据源；MediaRecorder 只有
  // stop 才有 blob，试听必须在录制时就攒一份可播放的 PCM）
  if (recState === 'rec' && lastTD) appendRecPcm(lastTD);
  // 异步内核钩子（供需要逐窗喂原始波形的内核使用）：不阻塞这里。
  // 第 3 参 = 本窗末样本的音频时钟时间：滑窗相邻两帧重叠 ~90%，内核必须靠它只取新增样本，
  // 否则重叠段重复进流，16k 时间轴按重叠倍数虚增（实测 5.57×）→ 取帧时间戳全废。
  const kn = activeKernel();
  if (kn && typeof kn.pushSample === 'function') { try { kn.pushSample(lastTD, ctxSr, recTimeSec()); } catch (e) {} }
  // 实时取帧也按【当前窗绝对时间】对齐缓存（内核 ring 与检测窗同起点=录音首窗）：
  // 内核可经 setWindowTime(tSec) 沿缓存逐帧前进，消除"每攒批 0.25s 推 29 帧、期间各窗复用同一
  // 最新帧"造成的阶梯/滞后感(与离线按窗时间取帧同一套机制)。零开销，仅一次赋值。
  if (kn && typeof kn.setWindowTime === 'function') { try { kn.setWindowTime(recTimeSec()); } catch (e) {} }
  processOneWindow(lastTD);
}
// 累积录音 PCM（按绝对样本位置对齐写入，避免滑窗重叠）：
// analyser 每次读回的是"最近 fftSize 样本"的滑动窗口，直接拼接会让同一段音频重复出现、
// 试听时长失真。正确做法：用累计时长推"窗口尾部应处样本位 tail=floor(recTimeSec*sr)"，
// recPcmLen 始终等于真实录音累计样本数，每次只补 tail 到 recPcmLen 之间"新产生"的样本
// （取自 lastTD 尾部——analyser 窗口尾部恰是最新时刻）。掉帧/暂停都不会重叠或漂移。
function appendRecPcm(td) {
  const sr = ctxSr || 44100;
  const tail = Math.floor(recTimeSec() * sr);        // 当前应累计到的样本位
  if (tail <= recPcmLen) return;                     // 无新样本(掉帧/冻结)
  const need = Math.min(td.length, tail - recPcmLen);
  recPcmLen = appendChunked(recPcmChunks, recPcmLen, td.subarray(td.length - need));
}
// 实时窗时间(秒)：
//   rec 录音中 = 累计时长（recBaseT + 本次续录增量），暂停/试听不会让它跳变；
//   暂停/试听 = 冻结的累计时长 recBaseT；
//   其他（播放兜底）= 播放位置(视图 nowPosSec)。
function recTimeSec() {
  if (recState === 'rec' && audioCtx) return recBaseT / 1000 + Math.max(0, audioCtx.currentTime - recActiveT0);
  if (recState === 'paused' || recState === 'listen') return recBaseT / 1000;
  return nowPosSec();
}
function recTimeMs() { return Math.round(recTimeSec() * 1000); }
function activeKernel() { try { return resolveKernel(kernelId); } catch (e) { return null; } }

// ---- 工程查表：当前播放位置 -> 最近帧 ----
// 试听(listen)不再切换播放器视图，播放头仍在 pl 上进行——这里放行 listen 态，
// 让 snapshot/拖动等在 live 视图也能拿到试听播放位置
function nowPosSec() {
  if (!pl.clip) return 0;
  if (appView !== 'play' && recState !== 'listen') return 0;
  return plPos();   // 播放头的推进（含倍速）唯一实现在播放器域，这里不重算
}
// 通用帧查表：在任意升序 frames 数组里定位 posSec 落点。
// ⚠ 返回的是"≤ 目标时间的最后一帧"（二分取 lo），**不是时间上最近的一帧**。
//   两种取法最多差一个 hop（约 23ms），观感上无差别，但别当"最近帧"用
//   （2026-09-22 核对：这里是"最近有效帧"的口径）。
// 录音活工程 recFrames 与离线分析 curProject.analysis.frames 共用同一实现，
// 保证录音中/暂停/试听/回放查表口径一致。
function frameAtFrames(frames, posSec) {
  if (!frames || !frames.length) return null;
  const tMs = posSec * 1000;
  let lo = 0, hi = frames.length - 1;
  if (tMs <= frames[0].t) return frames[0];
  if (tMs >= frames[hi].t) return frames[hi];
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= tMs) lo = mid; else hi = mid;
  }
  return frames[lo];
}
function frameAtProject(posSec) {
  return frameAtFrames(curProject && curProject.analysis && curProject.analysis.frames, posSec);
}

// 实时检测：把一窗数据喂给检测器(门控/状态机/平滑都在检测器内)，
// 再把结果同步到诊断信息与读数 UI。
// 录音中(running)还负责【录音帧沉淀】——对标同类应用：检测回调即工程帧生产者，
// 录完即工程，保存后跳过二次分析(消灭"实时曲线 vs 分析曲线"两套数据)。
function processOneWindow(windowData) {
  const d = ensureDetector();
  if (!d) return;
  const r = d.processWindow(windowData);
  curProm = r.prom;
  dbg.rms = r.rms; dbg.prom = r.prom; dbg.purity = r.purity;
  dbg.str = r.str; dbg.conf = r.conf; dbg.voiced = r.voiced;
  dbg.fA = r.fA;
  dbg.freq = r.freq;   // 当帧原始判定(非粘滞)：钢琴块实时分段依赖它(2026-09-07)
  lastGoodFreq = d.lastGoodFreq;        // 检测器维护的最近有效平滑频率(未发声时保留旧值)
  if (recState === 'rec' && recFrames) {
    recordRecFrame(d, r);
    // 细粒度包络积累：93ms 检测窗看不见 30-60ms 吐音气口，按 11.6ms 子窗补分辨率
    if (recEnv) {
      const sub = 512, step = 256, n = windowData.length;
      const w0 = tMsOfWindow(n);
      for (let k = 0; k + sub <= n; k += step) {
        let s = 0;
        for (let j = k; j < k + sub; j++) s += windowData[j] * windowData[j];
        recEnv.push({ t: Math.round(w0 + (k + sub / 2) / ctxSr * 1000), rms: Math.sqrt(s / sub) });
      }
    }
  }
  updateReadoutUI(r.freq, r.voiced, r.rms);
}

// —— 录音帧沉淀：与 dsp/analyze.mjs 的桥接语义一致(短气口保留最近有效频率作弱帧) ——
// 时间基准用 audioCtx 时钟(声卡采样时钟，比墙钟更贴近音频时间轴，回放查表才对得齐)。
const REC_BRIDGE_MS = 900;    // 与 pitchTrail GAP_MS 同源：超过视为长停，真正断开
function tMsOfWindow(n) {
  // 用累计录音时长而非墙钟差：暂停/续录后窗时间仍连续、不跳（与 recordRecFrame 同基准）
  return recTimeMs() - Math.round(n / ctxSr * 1000);
}

function recordRecFrame(det, r) {
  const tMs = recTimeMs();
  if (tMs - (recFrames.length ? recFrames[recFrames.length - 1].t : -1e9) < 30) return;  // 节流≥30ms
  let freq = 0;
  const voiced = !!r.voiced;
  if (voiced) {
    // 当帧判定优先：lastGoodFreq 是粘滞值，快变奏时短音会被记成上一音的频率
    // → 拼进旧块"不出块"(2026-09-07 实测确认)。lastGoodFreq 仅作兜底。
    freq = Number.isFinite(r.freq) && r.freq > 0 ? r.freq
      : (Number.isFinite(det.lastGoodFreq) && det.lastGoodFreq > 0 ? det.lastGoodFreq : 0);
    if (!(freq > 0)) { freq = 0; voiced = false; }
    else recLastVoicedT = tMs;
  } else if (Number.isFinite(det.lastGoodFreq) && det.lastGoodFreq > 0 && tMs - recLastVoicedT <= REC_BRIDGE_MS) {
    freq = det.lastGoodFreq;               // 短气口桥接帧(voiced=false 但 freq>0，画细灰线)
  }
  recFrames.push({
    t: tMs, freq, voiced,
    prom: Math.round(r.prom * 100) / 100,
    purity: Math.round(r.purity * 1000) / 1000,
    rms: Math.round(r.rms * 1e5) / 1e5,
    str: Math.round(r.str * 1000) / 1000,
  });
  // 已录音域增量维护（暂停/回拖时 HUD 显示已录整体范围；与离线 stats 同口径）
  if (freq > 0 && voiced) {
    if (freq < recMinHz || !Number.isFinite(recMinHz)) recMinHz = freq;
    if (freq > recMaxHz || !Number.isFinite(recMaxHz)) recMaxHz = freq;
  }
}

// —— 读数/音域统计 UI 更新（平滑与门控状态已由检测器完成）——
// skipStats=true：只刷音名/Hz 读数，不改音域统计（录音活工程查表用；已测音域=已录整体范围 recMin/Max，
// 而非回拖过程中看到的单帧，否则拖动时读数上下跳）
function updateReadoutUI(freq, voiced, rms, skipStats) {
  const now = performance.now();

  if (!voiced || !Number.isFinite(freq)) {
    if (now > noteHoldUntil) { noteShown = '--'; noteEl.textContent = '--'; centsEl.textContent=''; hzEl.textContent=''; }
    return;
  }
  // 实测音域统计（最低/最高）
  if (freq > 0 && !skipStats) {
    if (!seenAny) { seenAny = true; statsMin = statsMax = freq; }
    else { if (freq < statsMin) statsMin = freq; if (freq > statsMax) statsMax = freq; }
    updateRangeDisplay();
  }
  const nn = freqToNote(freq);
  // ⚠ 去重必须带八度。只比 nn.name（音名，不含八度）的话，C4→C5 / G5→G4 这类
  //   "同音名换八度"不满足 `nn.name !== noteShown`，而 noteHoldUntil 每帧都被刷新
  //   (`now > noteHoldUntil` 恒假) → 音名与 Hz 一直冻结在旧八度上，看着就像"音高降不下来"。
  const label = nn.name + nn.oct;
  if (label !== noteShown || now > noteHoldUntil) {
    noteShown = label;
    noteEl.textContent = label;
    const c = nn.cents;
    centsEl.innerHTML = (c > 5 ? '<span class="sharp">▲ +' + c.toFixed(0) + '¢</span>'
                       : c < -5 ? '<span class="flat">▼ ' + c.toFixed(0) + '¢</span>'
                       : '<span class="flat">● 0¢</span>');
    hzEl.textContent = freq.toFixed(1) + ' Hz';
  }
  noteHoldUntil = now + CFG.noteHoldMs;
}

function updateRangeDisplay() {
  const fnote = (f) => { const n = freqToNote(f); return n.name + n.oct; };
  if (Number.isFinite(statsMin) && Number.isFinite(statsMax)) {
    lowStatEl.textContent = fnote(statsMin);
    highStatEl.textContent = fnote(statsMax);
  }
}

// ===== 主循环 =====
// ===== 回声模式：已抽成 app/echo.mjs（2026-09-15「① 状态收敛」首域，
//       状态封进模块 → 写入点由 ESM 模块边界强制，app.mjs 只读+调具名函数）=====

function tick(now) {
  if (!running && !(playInfo && playInfo.on)) { rafId = null; return; }  // 空闲由 idleLoop 接管
  // 数据源：回放工程(非录音中) 或 试听(listen) → 只拉波形(查表由 snapshot 处理)；否则实时检测
  const projMode = isProjPlayback() || recState === 'listen';
  if (analyser) {
    try { projMode ? pullWaveform() : processBlock(); }
    catch (e) { console.error('process', e); }
  }
  // snapshot 若抛异常必须续排 RAF——否则渲染循环静默死亡，画布永久冻结(看似"不显示")。
  let d;
  try { d = snapshot(); } catch (e) { console.error('snapshot', e); rafId = requestAnimationFrame(tick); return; }
  renderTemplate(d, now);
  // 录制动画中：① 琴声桥接持续补挂（钢琴引擎可能是在录制开始之后才惰性创建的，见其注释）；
  //            ② 麦克风只在"真的在录人声/口哨"时并入视频——录音态没有别的声源，不并就是哑的；
  //               非录音态（回放工程）并进去只会是房间噪声。
  // 两者都在 app/capture.mjs 的 capTick() 里（capDest 为空时直接返回，零开销）。
  capTick();
  try { updateTransportUI(); } catch (e) {}
  const dt = now - lastT; lastT = now;
  if (echoOn) { try { echoFeed(d); } catch (e) { console.error('echo', e); } }
  if (dt > 0) { fpsAcc += 1000 / dt; fpsCnt++; if (fpsCnt >= 20) { fpsVal = fpsAcc / fpsCnt; fpsAcc = 0; fpsCnt = 0; } }
  updateDebugBadge();
  rafId = requestAnimationFrame(tick);
}
// playInfo / pl / appView / curClip / clipSeq 已搬到 app/player.mjs（① 第五域）
function ensureLoop() { if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(tick); } }

// 是否"回放工程"：播放器界面 + 有片段 + 工程分析就绪 + 非实时录音
function isProjPlayback() {
  if (recState !== 'idle' || !curClip) return false;
  if (appView !== 'play' || !curProject) return false;
  // MIDI 工程 / AI 转谱：音符事件查表(无 analysis.frames，钢琴块经 snapshot.midiNotes 直供)
  if (curProject.midiNotes && curProject.midiNotes.length) return true;
  if (!curProject.analysis || !curProject.analysis.frames || !curProject.analysis.frames.length) return false;
  // 打开存档 / MIDI 工程：buffer 是新建的静音时间轴（纯曲线存档则压根没音频），
  // 靠下一行的 bufferRef 引用判等放行 —— 所有打开路径都会把 curProject.bufferRef 与
  // 交给 loadClip 的 clip.buffer 设成同一个实例，故引用判等成立。
  // ⚠ 这里曾有一条 openedProjId/openedProjBufRef 白名单做兜底，2026-09-22 删除：
  //   它在 projOpenArchive 里刚赋值就被 loadClip 无条件清空 → 分支永不成立 = 死代码；
  //   留着它还会让人以为"有兜底"，比没有更危险。
  // 2026-09-06 定案(恢复工程查表为主，对标同类应用 zcp"固定曲线")：
  // 片段分析就绪并绑定当前 buffer → 回放一律查表渲染整段曲线(含真实音频)，
  // 拖动/回拉任意位置立即显示、曲线静态不丢，无需播放时重新检测。
  // 分析未就绪前(curProject=null/分析中)isProjPlayback=false → 播放走实时检测兜底。
  // 当年"播放曲线差"的根因(门控双实现、分析参数不跟随、帧横轴 i*hop)已分别修复，
  // 详见 dsp/detect.mjs 与 dsp/analyze.mjs 注释。
  return !!pl.clip && !!pl.clip.buffer && curProject.bufferRef === pl.clip.buffer;
}

function updateDebugBadge() {
  if (!fpsEl) return;
  const st = dbg.run ? 'RUN' : 'IDLE';
  const sr = dbg.sr ? Math.round(dbg.sr / 1000) + 'k' : '--';
  const v = dbg.voiced ? '✓发声' : '·静音';
  const fa = Number.isFinite(dbg.fA) && dbg.fA > 0 ? Math.round(dbg.fA) + 'Hz' : '--';
  const g = gateNow();   // 生效阈值(检测器实例；未创建时按当前灵敏度算出，同一份公式)
  fpsEl.textContent =
    `${st} ${sr} | 灵敏度${SENS.val} | 周期${(dbg.str * 100).toFixed(0)}%` +
    `(需<${(g.strMax * 100).toFixed(0)}) | 纯音${(dbg.purity * 100).toFixed(0)}%` +
    ` | 置信${dbg.conf.toFixed(2)}(需>${g.confOn.toFixed(2)}) | ${v} | A:${fa}`;
}

// ===== 动画模板驱动：算数据快照 -> 喂当前模板.frame() =====
// 绘制逻辑已拆到 anim/*.mjs，见 registry.mjs 接口注释。
let specBuf = null;          // analyser 频域幅度缓存(频谱类模板用)
let specFmax = 8000;
function ensureSpec() {
  if (analyser && analyser.frequencyBinCount) {
    const n = analyser.frequencyBinCount;
    if (!specBuf || specBuf.length !== n) specBuf = new Float32Array(n);
    specFmax = audioCtx ? audioCtx.sampleRate / 2 : 8000;
  }
}
// 构造每帧数据快照(结构见 registry.mjs)
function snapshot() {
  ensureSpec();
  // 是否活跃(录音或播放)：会影响实时 voiced 的判定(见下方 else 分支)
  const live = running || (playInfo && playInfo.on);
  // —— 音频游标 audioMs(ms)：心电图式模板(音高轨迹)的时间轴基准。
  // 录音(rec) = 累计录音时长(暂停/续录不跳)；暂停(paused) = 冻结位或 recSeek 拖动覆盖；
  // 试听(listen)/播放器 = 播放头真实位置(暂停/拖动也正确，见 nowPosSec)；
  // 两者皆无(空闲/未开始) = -1，模板画"就绪空态"。
  // 用音频时钟而非渲染帧时钟：掉帧只丢检测点密度，曲线与声音不错位。
  // ⚠ 这里曾有一条 `else if (running) audioMs = performance.now() - recStartT`（墙钟口径）：
  //   running=true 只在 recState='rec' 时出现（三处置位都紧跟 recState='rec'），
  //   故第一个分支永远先命中 → 该分支不可达且混入墙钟。2026-09-22 删。
  let audioMs = -1;
  if (recState === 'rec') audioMs = recTimeMs();
  else if (recState === 'paused') audioMs = recDragMs != null ? recDragMs : recBaseT;
  else if (recState === 'listen') audioMs = Math.round(nowPosSec() * 1000);
  else if (appView === 'play' && pl.clip) audioMs = Math.round(nowPosSec() * 1000);

  let voiced, freq, prom, rms, purity, str;
  const useProj = isProjPlayback();
  let projFrames = null;
  let midiNotes = null;
  // 录音活工程：录音/暂停/试听期间把 recFrames 当作"活工程"查表，曲线全量可回拖。
  // 与离线分析查表共用 drawProject 渲染与 frameAtFrames 二分，体验与"分析完成后的动画"一致。
  const liveRec = recState !== 'idle' && recFrames && recFrames.length > 0;

  if (liveRec) {
    // —— 录音活工程查表：位置 = rec 推进 / paused 冻结或拖拽 / listen 播放头 ——
    let posSec = audioMs / 1000;
    projFrames = recFrames;
    const f = frameAtFrames(recFrames, posSec);
    voiced = !!(f && f.voiced && f.freq > 0);
    freq = voiced ? f.freq : NaN;
    prom = f ? f.prom : 0;
    purity = f ? f.purity : 0;
    str = f ? f.str : 1;
    rms = f ? f.rms : 0;
    dbg.voiced = voiced; dbg.prom = prom; dbg.purity = purity;
    dbg.str = str; dbg.rms = rms;
    // 已录音域（增量维护，回拖/暂停时 HUD 显示已录整体范围）
    if (Number.isFinite(recMinHz)) statsMin = recMinHz;
    if (Number.isFinite(recMaxHz)) statsMax = recMaxHz;
    updateRangeDisplay();
    try { updateReadoutUI(freq, voiced, rms, true); } catch (e) {}
    // 回声模式：注入合成下落音符(钢琴块里 midiNotes 路径优先级最高 → 原生下落块
    // +落键弹奏，一行不改钢琴块)。
    // ⚠ 必须限定 recState==='rec'（2026-09-16 修）：本分支的 liveRec = recState!=='idle'，
    //   暂停/试听时也为 true，而回声模块自述"只在实时录音生效"(app/echo.mjs 头注释)。
    //   不限定的话，暂停回拖时间轴 / 试听回放时，上一段录音的"在途块"会重新下落，
    //   并由 pianoBlocks 的 spawnOnsets 弹出琴声（试听时明显乱入）。
    if (echoOn && recState === 'rec' && echoNotes.length) midiNotes = echoNotes;
  } else if (useProj && curProject && (curProject.midiNotes || curProject.analysis)) {
    // —— 工程查表：音频工程 / MIDI 工程 / 转谱后的音频工程 共用一段 ——
    // ① MIDI / AI转谱：音符事件表直供钢琴块(渲染+落键弹奏)；
    // ② analysis.frames：逐帧曲线（音高轨迹等模板 + 拖动查表）。
    // ⚠ 两者可以同时存在（音频工程转谱后如此）。"有 midiNotes 就只走 ① 并
    //   不填 projFrames"，于是转谱后曲线类模板整段曲线消失（frames 明明还在）——
    //   2026-09-16 修：两个数据源各自独立地给出去。
    if (curProject.midiNotes && curProject.midiNotes.length) midiNotes = curProject.midiNotes;
    if (curProject.analysis && curProject.analysis.frames && curProject.analysis.frames.length) {
      // —— 工程查表：播放位置 → 帧 ——
      const posSec = nowPosSec();
      projFrames = curProject.analysis.frames;
      const f = frameAtProject(posSec);
      voiced = !!(f && f.voiced && f.freq > 0);
      freq = voiced ? f.freq : NaN;
      prom = f ? f.prom : 0;
      purity = f ? f.purity : 0;
      str = f ? f.str : 1;
      rms = f ? f.rms : 0;
      // 同步诊断信息(徽标)：查表态没有实时检测帧，喂的是工程帧值
      dbg.voiced = voiced; dbg.prom = prom; dbg.purity = purity;
      dbg.str = str; dbg.rms = rms;
      // 工程播放态下 HUD 音域统计显示工程整体范围
      if (curProject.analysis.stats) {
        statsMin = curProject.analysis.stats.minHz || NaN;
        statsMax = curProject.analysis.stats.maxHz || NaN;
        try { updateRangeDisplay(); } catch (e) {}
      }
      // 顶部大读数(音名/音分/Hz)与「音量」也要跟着播放头走：不能只有实时检测与
      // 录音活工程会刷它，工程回放(查表)时它一直停在上一次的读数上，看着像"读数坏了"
      // （2026-09-16 修）。skipStats=true：音域用工程整体 stats，不是当前帧。
      try { updateReadoutUI(freq, voiced, rms, true); } catch (e) {}
    } else {
      // 纯 MIDI 工程：没有逐帧曲线，只有音符事件表
      voiced = false; freq = NaN; prom = 0; purity = 0; str = 1; rms = 0;
    }
  } else {
    // 空闲(既未录音也未播放)时视为静音冻结：voiced→false。
    // 否则 dbg.voiced 冻结在停止前的 true，idleLoop 每帧把陈旧发声当新发声喂给
    // 音高轨迹 → 表现为"停止/暂停后动画还在往前走"。
    // (live 已在函数开头计算)
    voiced = live ? dbg.voiced : false;
    freq = voiced && Number.isFinite(lastGoodFreq) && lastGoodFreq > 0 ? lastGoodFreq : NaN;
    prom = curProm; rms = dbg.rms;
    purity = dbg.purity; str = dbg.str;
  }

  // 频谱只在【真的音频在流(live)】时才喂给模板。
  // 暂停后麦克风仍接在 analyser 上(pauseRecording 只 pause 了 MediaRecorder，没断开输入)，
  // 无条件取频谱 → 「频谱分析」等模板会继续跟着现场噪声跳舞，直到点试听(stopLiveFeeding)
  // 才塌零。这与上面 voiced 的"静音冻结"是同一个坑，故共用 live 一个判据：
  //   录音中 / 试听播放中 / 工程回放中 = true；暂停、停止、播完、空闲 = false → 模板收到 null。
  let spec = null;
  if (live && analyser && specBuf) {
    try {
      analyser.getFloatFrequencyData(specBuf);   // 原始 dB(-Inf~0)
      // dB -> 视觉 0~1：[-100,0]dB 线性映射到 [0,1]
      for (let i = 0; i < specBuf.length; i++) {
        const db = specBuf[i];
        specBuf[i] = db <= -100 ? 0 : (db + 100) / 100;
      }
      spec = specBuf;
    } catch (e) { spec = null; }
  }
  const nn = freqToNote(freq);
  return {
    voiced,
    freq,
    midi: Number.isFinite(freq) ? 69 + 12 * Math.log2(freq / 440) : NaN,
    note: voiced && nn.name !== '--' ? nn.name + nn.oct : '--',
    cents: nn.cents, hz: freq,
    prom, rms, purity, str,
    live,                             // 此刻真的有音频在流(录音中/试听播放中/工程回放中)。
                                      // 暂停、停止、播完、空闲 = false。
                                      // ⚠️ 它只冻【由 audioMs 驱动】的内容：时间轴推进、游标、
                                      //    下落块位置、陈旧输入重绘。**不要**用它冻自由粒子/烟/尾焰
                                      //    ——那些有自然寿命，任何中断（暂停/停止/播完）都该飘完再消失
                                      //    （2026-09-20："中途暂停也让残留动画走完"）。
                                      //    粒子发射口仍看 live：中断后不吐新粒子，只收尾。
    spectrum: spec, specBins: spec ? spec.length : 0, specFmax,
    waveform: lastTD,                 // 最近一帧时域波形(±1)，波形类动画用；未运行=null
    seenAny, statsMin, statsMax,
    lastGoodFreq: Number.isFinite(freq) ? freq : lastGoodFreq,
    freqRaw: (Number.isFinite(dbg.freq) && dbg.freq > 0) ? dbg.freq : NaN,   // 当帧原始判定(钢琴块实时分段用)
    audioMs,                          // 音频游标 ms；-1=无活动时间轴
    resetKey: clipSeq,                // 片段代际(录音/导入/新建自增)，模板据此复位曲线
    // —— 工程模式信息(纯分析存档回放 / 录音活工程供音高轨迹画曲线) ——
    midiNotes,                         // MIDI 工程/AI转谱的音符事件(钢琴块直供)
    env: (useProj && curProject && curProject.env) || (liveRec && recEnv) || (running && recEnv) || null,   // 细粒度包络(分段气口切分线索)
    segAlgo: getBlockAlgo(),           // 出块算法档位(回声域据此决定谷切分口径；经 snapshot 注入，域间不互 import)
    projMode: useProj || liveRec,
    projFrames: (useProj || liveRec) ? projFrames : null,
    liveRecActive: liveRec,            // 录音活工程(录音/暂停/试听中)：pianoBlocks 据此走"实时点亮琴键"
                                       // 而非"音符事件查表"——录音中 recFrames 分段出的 notes 为空，琴键会不亮
  };
}
function renderTemplate(d, now) {
  const tmpl = anim.current();
  if (!tmpl) return;
  const cw = canvasWrap.clientWidth, ch = canvasWrap.clientHeight;
  if (cw === 0) return;
  const isGL = tmpl.renderer === 'gl';
  // 2D / GL 画布互斥：GL 模板占独立 canvas(叠在2D之上)，其余用原2D canvas
  canvas.style.display = isGL ? 'none' : 'block';
  if (canvasGL) canvasGL.style.display = isGL ? 'block' : 'none';
  const hostCanvas = isGL ? canvasGL : canvas;
  const hostW = hostCanvas.clientWidth || cw, hostH = hostCanvas.clientHeight || ch;
  const [bw, bh] = isGL ? [hostW, hostH] : backingSize(hostW, hostH);
  if (!isGL && initedTmpl === tmpl.id && (canvas.width !== bw || canvas.height !== bh)) {
    // 同模板仅尺寸变化：走 resize() 保留模板内部状态(如 pitchTrail 已采样曲线)，
    // 不重新 init——否则 recbar 状态文字换行等引起的高度抖动会瞬间清空曲线。
    canvas.width = bw; canvas.height = bh;
    ctx.setTransform(bw / hostW, 0, 0, bh / hostH, 0, 0);   // width 赋值会重置变换矩阵，必须重贴
    try { tmpl.resize ? tmpl.resize(hostW, hostH) : tmpl.init(ctx, hostW, hostH); } catch (e) { console.error('anim resize', e); }
  }
  if (!isGL && initedTmpl !== tmpl.id) {
    canvas.width = bw; canvas.height = bh;
    ctx.setTransform(bw / hostW, 0, 0, bh / hostH, 0, 0);
    initedTmpl = tmpl.id;
    try { tmpl.init(ctx, hostW, hostH); } catch (e) { console.error('anim init', e); }
  }
  if (isGL && initedTmpl !== tmpl.id) {
    initedTmpl = tmpl.id;
    try { tmpl.init(hostCanvas, hostW, hostH); } catch (e) { console.error('gl anim init', e); }
  }
  try { tmpl.frame(d, now); } catch (e) { console.error('anim frame', e); }
}
let initedTmpl = null;
let lastStageW = 0, lastStageH = 0;
function applyResize() {
  const cw = canvasWrap.clientWidth, ch = canvasWrap.clientHeight;
  if (!cw) return;
  const t = anim.current();
  const isGL = t && t.renderer === 'gl';
  canvas.style.display = isGL ? 'none' : 'block';
  if (canvasGL) canvasGL.style.display = isGL ? 'block' : 'none';
  if (t && t.renderer === 'gl') {
    if (cw === lastStageW && ch === lastStageH && initedTmpl === t.id) return;
    lastStageW = cw; lastStageH = ch;
    initedTmpl = t.id;
    try { t.init(canvasGL, cw, ch); } catch (e) { console.error('gl resize init', e); }
    return;
  }
  // 同模板仅尺寸变化 → resize() 保状态；模板切换/首次 → init()
  // backing store = CSS × dpr，坐标系缩放回 CSS 像素（模板代码无感）
  const [bw, bh] = backingSize(cw, ch);
  if (initedTmpl === t?.id && canvas.width === bw && canvas.height === bh) return;
  canvas.width = bw; canvas.height = bh;
  ctx.setTransform(bw / cw, 0, 0, bh / ch, 0, 0);
  if (t) {
    try {
      if (initedTmpl === t.id && t.resize) t.resize(cw, ch);
      else t.init(ctx, cw, ch);
    } catch (e) {}
  }
  initedTmpl = t ? t.id : null;
  // 空闲也立即渲染当前模板一帧：无声音/未运行时也先画出坐标网格与标尺，
  // 避免「音高轨迹」等模板整块黑屏、只在检测到声音时才出现内容。
  if (t) { try { renderTemplate(snapshot(), performance.now()); } catch (e) { console.error('idle render', e); } }
}
// 切换模板(工具条/新建时用)
function switchTemplate(id) {
  if (!anim.setCurrent(id)) return;
  log.debug('anim', '切换动画模板', { id });
  initedTmpl = null;
  lastStageW = lastStageH = 0;
  applyResize();          // 让新模板重建画布与内部缓冲
  refreshAnimBar();
}

// ===== 收音门槛滑杆（「最低收音分贝」手动模式）=====
// 阈值滑到 [20,70]dB；滑块每格 = dB。
// 统一有效门槛 gateEffDb()：自动 = 环境底噪 + 3.5dB(≈×1.5)；手动 = max(用户值, 环境底噪)。
// 手动也钳到环境底噪之上，避免把环境噪音一并放进来——判定与显示都走这一个值，保证一致。
function gateDbNow() {
  return envBase > 1e-5 ? Math.max(dbOf(envBase), -80) : -80; // 未校准前不硬设门槛
}
function gateEffDb() {
  const ambient = gateDbNow();
  return GATE.auto ? Math.max(ambient + 3.5, ambient) : Math.max(GATE.db, ambient);
}
function syncGateUI() {
  const sld = document.querySelector('#dbSlider'), chk = document.querySelector('#autoDb');
  const auto = GATE.auto = !chk ? GATE.auto : chk.checked;
  if (chk) chk.checked = auto;
  const eff = gateEffDb();
  const dbv = document.querySelector('#dbVal'), dbt = document.querySelector('#dbHint');
  if (auto) {
    if (sld) { sld.disabled = true; sld.value = GATE.db; }
    if (dbv) dbv.textContent = (envBase > 1e-5) ? `A${Math.round(eff)}` : '自动';
    if (dbt) dbt.textContent = `自动：底噪${Math.round(gateDbNow())}dB · 门槛 ${Math.round(eff)}dB`;
  } else {
    if (sld) { sld.disabled = false; sld.value = GATE.db; }
    if (dbv) dbv.textContent = (gateDbNow() > GATE.db) ? `M${GATE.db}(≥底噪${Math.round(gateDbNow())})` : `M${GATE.db}`;
    if (dbt) dbt.textContent = `最低收音 ${Math.round(eff)}dB（滤掉低于此音量的杂音与气音）`;
  }
  syncDetectorEnergy();   // 门槛显示与判定同源：UI 每次刷新都把参数写进检测器
}
function applyDb(v, fromUser) {
  GATE.db = Math.max(20, Math.min(70, Math.round(v)));
  if (fromUser && GATE.auto) { /* 用户拖动滑块时若为自动，则显式切到手动 */ GATE.auto = false; }
  try { localStorage.setItem('ydyi_gate', JSON.stringify({ auto: GATE.auto, db: GATE.db })); } catch (e) {}
  syncGateUI();
  log.debug('gate', '收音门槛调整', { auto: GATE.auto, db: GATE.db, fromUser: !!fromUser });
}

// ===== 门控口径变更 → 已分析工程按新口径重算 =====
// 灵敏度 / 收音门 / 自动 都会改门控判定，而工程曲线是"分析那一刻"算好的：不重算的话，
// 在播放视图里拖这两个滑杆就是"改了但屏幕不动"，用户只会以为控件坏了
// （只在切检测算法 setKernel 时才重算是不够的）。
// 只在滑杆松手(change)/勾选框切换时调用，不给 input 高频路径添负担；
// 无工程 / 纯 MIDI / 正在分析 → 静默跳过；连续调多个滑杆由 800ms 防抖收成一次。
let lastReanalyzeT = 0;
function reanalyzeIfProject(reason) {
  if (!curClip || !curProject || curProject.isMidi || analyzing) return false;
  const fr = curProject.analysis && curProject.analysis.frames;
  if (!fr || !fr.length) return false;
  const now = performance.now();
  if (now - lastReanalyzeT < 800) return false;
  lastReanalyzeT = now;
  log.info('gate', '门控参数变更 → 重算整段工程曲线', {
    reason, sens: SENS.val, gate: GATE.auto ? 'auto' : ('manual ' + GATE.db + 'dB'),
  });
  autoAnalyzeClip(curClip);
  setStatus('参数已变（' + reason + '），正在按新口径重算整段…');
  return true;
}

// ===== 灵敏度滑杆 =====
function applySens(v) {
  SENS.val = Math.max(0, Math.min(100, Math.round(v)));
  // 重算阈值并复位门控状态机(置信/丢失计数/平滑窗)——都在检测器内部完成
  if (det) det.setSens(SENS.val);
  const lab = SENS.val >= 80 ? '严格' : SENS.val >= 45 ? '适中' : '宽松';
  const sv = document.querySelector('#sensVal'), ss = document.querySelector('#sensSlider');
  if (sv) sv.textContent = lab + ' · ' + SENS.val;
  if (ss) ss.value = SENS.val;
  const tip = document.querySelector('#sensHint');
  if (tip) {
    const g = gateNow();
    tip.textContent = `周期需<${(g.strMax * 100).toFixed(0)}% · 纯音度>${(g.purityMin * 100).toFixed(0)}% · 置信>${g.confOn.toFixed(2)}`;
  }
  log.debug('gate', '灵敏度调整', { sens: SENS.val });
}

// ===== 检测算法（内核）切换 =====
const kernelsList = () => availableKernels();
const kernelNow = () => kernelsList().find(k => k.id === kernelId) || { id: kernelId, name: kernelId };
// 需要异步加载的内核（若某内核要预载模型/资源）→ 后台加载，失败自动回退同步兜底。
function ensureKernelLoaded() {
  const kn = activeKernel();
  if (!kn || typeof kn.load !== 'function') return;
  if (typeof kn.ready === 'function' && kn.ready()) return;
  const wantId = kernelId;
  setStatus('正在加载「' + (kn.name || kn.id) + '」（首次需初始化 WASM 推理）…');
  kn.load()
    .then(() => {
      if (kernelId !== wantId) return;              // 用户已切走，不误报
      log.info('kernel', '检测内核加载完成', { id: kernelId });
      setStatus('✓ 「' + (kn.name || kn.id) + '」已就绪（自动回退模式生效）');
    })
    .catch((e) => {
      if (kernelId !== wantId) return;
      const msg = (e && e.message) || String(e);
      log.error('kernel', '内核加载失败(将回退兜底算法)', { id: kernelId, err: msg });
      setStatus('⚠ 「' + (kn.name || kn.id) + '」加载失败：' + msg + '（已回退到同步兜底算法）');
    });
}
function setKernel(id) {
  const target = kernelsList().some(k => k.id === id) ? id : KERNEL_DEFAULT;
  if (target === kernelId) { syncKernelSel(); return; }
  kernelId = target;
  try { localStorage.setItem('ydyi_kernel', kernelId); } catch (e) {}
  det = null;                       // 重建实时检测器：下一次喂窗即用新算法（录音中也会顺带切换）
  log.info('kernel', '切换检测算法', { id: kernelId, name: (kernelsList().find(k => k.id === kernelId) || {}).name });
  syncKernelSel();
  ensureKernelLoaded();
  // 处于播放工程且已有非 MIDI 分析 → 按新算法重算离线曲线，否则拖动查到的是旧算法曲线
  if (curClip && curProject && !curProject.isMidi) {
    autoAnalyzeClip(curClip);
    setStatus('检测算法已切至「' + kernelNow().name + '」，正在重算整段…');
  }
}
function syncKernelSel() { const s = el('kernelSel'); if (s) s.value = kernelId; }
function fillKernelSel() {
  const sel = el('kernelSel'); if (!sel) return;
  sel.innerHTML = '';
  for (const k of kernelsList()) {
    const o = document.createElement('option'); o.value = k.id; o.textContent = k.name; sel.appendChild(o);
  }
  sel.value = kernelId;
  sel.addEventListener('change', () => setKernel(sel.value));
}

// ===== 统一传输模块（录音机 + 播放器）=====
const $els = {};
function el(id) { if (!$els[id]) $els[id] = document.querySelector('#' + id); return $els[id]; }

// ---- 音质预设 ----
const Q_MAP = [
  { id: 'std',  label: '标准', type: 'audio/webm;codecs=opus', bps: 96000 },
  { id: 'high', label: '高清', type: 'audio/webm;codecs=opus', bps: 192000 },
  { id: 'loss', label: '高保真', type: 'audio/webm;codecs=opus', bps: 512000 },
];
function pickQuality(id) { return Q_MAP.find(q => q.id === id) || Q_MAP[0]; }

let recorder = null;             // MediaRecorder
let recStartT = 0;               // 录音开始 wallclock(ms)（状态栏/日志用）
// —— 录音状态机（2026-09-11 录音机式重构）——
//   'idle'   未录音
//   'rec'    录音中（mic 采集 + MediaRecorder 收集 + 检测帧全量沉淀）
//   'paused' 暂停录音（MediaRecorder.pause + 时间冻结，可回拖查看已录曲线）
//   'listen' 试听已录内容（暂停录音 + 播放 recPcm，可随时切回 rec 续录）
// recording 保持旧语义 = recState!=='idle'（已开始录音且未停止保存），兼容现有 isProjPlayback 等判断。
// 注：曾有个 `const recRecording = () => recState !== 'idle'` 辅助函数，全工程无调用点（判断都直接写
//     recState 比较），2026-09-22 删。
let recState = 'idle';
// 录音会话代际：每次 startRecording 自增。跨 await 的收尾必须比对它 ——
// stopRecording 之后主按钮立刻回到「● 开始录音」，而 finishRecording 里要 await 解码，
// 这期间用户完全可能又录一段；没有这个令牌，上一段的收尾会清掉新会话的累积缓冲
// 并 loadClip→abortRecordSession 把新录音掐掉（静默丢一段，2026-09-18 修）。
let recSessionSeq = 0;
// —— 累计时长模型（替换旧的 recCtxT0 墙钟差；暂停/试听时 audioCtx 时钟照走，
//     必须把"已冻结累计时长"与"本次续录起点"拆开，否则时间会跳）——
let recBaseT = 0;                // 已冻结累计录音时长(ms)，暂停/试听期间不变
let recActiveT0 = 0;             // 最近一次"开始/继续录音"时的 audioCtx 时钟(无活跃段=0)
let recFrames = null;            // 录音帧沉淀(检测回调即工程帧生产者)；录音中作为"活工程"供曲线全量回拖，录完由 finishRecording 消费
let recEnv = null;               // 录音细粒度包络(11.6ms 窗 rms)：分段器吐音气口切分线索
let recLastVoicedT = -1e9;       // 最近发声帧时间(短气口桥接用)
// —— 录音 PCM 累积缓冲（媒体轨道数据源；MediaRecorder 只有 stop 才有 blob，
//     试听/暂停回拖必须有一份实时累积的样本才能播）——
// 录音 PCM 用【分块】累积（proj/pcm-chunks.mjs），不用"单个几何倍增缓冲"：
// 后者扩容要 new + 复制旧数据 → 新旧两块同时存在，峰值 ≈ 2×。按 176KB/s 算，
// 30 分钟录音（~317MB）那次扩容峰值约 950MB，足以让标签页直接崩、录音全丢。
// 分块后每次只分配一块、永不复制旧数据，额外占用 < 0.3MB。
let recPcmChunks = [];           // Float32Array[]（每块定长，见 CHUNK_SAMPLES）
let recPcmLen = 0;               // 已累计样本数（= 真实录音长度）
let recClip = null;              // 试听/暂停用的临时 AudioBuffer clip（从 recPcmChunks 构建）
let recMinHz = NaN, recMaxHz = NaN;  // 已录帧音域（增量更新，暂停回拖 HUD 显示）
let recDragMs = null;        // 暂停态下用户拖动 recSeek 查看历史的时间覆盖(null=跟随冻结位)

// ===== 音高工程(对标同类应用 .zcp)：导入/录完 → 离线整段分析 → 查表 =====
// curProject 存在时，播放/拖动不再实时检测(processBlock 跳过 YIN)，而是
// 按播放位置二分查工程帧序列 —— 拖到哪立刻显示哪，轨迹模板画整段曲线。
let curProject = null;           // {id,name,duration,analysis:{frames,stats},audioBlob,...}
let analyzing = false;           // 正在后台分析

// 播放器引擎状态（pl）已搬到 app/player.mjs
let seekDragging = false;   // 用户在拖动时间线时，暂停自动更新避免打架
let lastPlaySeekT = 0;      // 播放器走带条拖动的 playerSeek 节流(ms)，防止拖动时高频 teardown/start
let lastRecSeekT = 0;       // 录音走带条拖动的 playerSeek 节流(ms)(画布拖动寻址也共用)
let recSeekDragging = false;   // 用户在拖录音走带条(试听/回拖)时，RAF 不写滑块值，避免与手打架

function fmtDur(s) { if (!(s > 0)) return '0.0s'; return (s >= 60 ? Math.floor(s / 60) + 'm' : '') + (s % 60).toFixed(1) + 's'; }
function fmtClock(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = s - m * 60;
  const mm = m < 10 ? '0' + m : '' + m;
  return mm + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
}
function fmtBar(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = s - m * 60;
  return m + ':' + (sec < 10 ? '0' : '') + (s >= 10 ? sec.toFixed(0) : sec.toFixed(1));
}
// 复位"已测音域"读数（录音/导入/新建 时都必须调）。
// ⚠ 除了统计值，顶部大读数(音名/音分/Hz)也要一起清：它同样只在检测到声音时才会被改写，
// 不清就会出现"点了＋新建，屏幕上还留着上一段的音名与音域"（2026-09-16 修：
// newSession 必须调这个函数：snapshot 每帧会把工程 stats 写进 statsMin/Max，
// 于是新建后 HUD 仍在显示上一工程的音域）。
function resetStats() {
  seenAny = false; statsMin = NaN; statsMax = NaN;
  noteShown = '--'; noteHoldUntil = 0;
  if (noteEl) noteEl.textContent = '--';
  if (centsEl) centsEl.textContent = '';
  if (hzEl) hzEl.textContent = '';
  updateRangeDisplay();
}
function setStatus(t) { const s = el('recStatus'); if (s) s.textContent = t; }

// 分析结果的统一摘要（供日志打点）。排查时最常被问的就是"这次到底识别出东西没有"，
// 所以把发声帧占比和音域直接算出来写进日志，不用回头翻几万帧原始数据。
// 注意：帧数可能上万，极值用循环求而不用 Math.min(...arr)，避免 spread 爆调用栈。
function analysisSummary(analysis) {
  const fr = (analysis && analysis.frames) || [];
  let voiced = 0, mn = Infinity, mx = 0;
  for (const f of fr) {
    if (f.voiced === false || !Number.isFinite(f.freq) || !(f.freq > 0)) continue;
    voiced++;
    if (f.freq < mn) mn = f.freq;
    if (f.freq > mx) mx = f.freq;
  }
  const ok = voiced > 0;
  return {
    frames: fr.length,
    voiced,
    voicedPct: fr.length ? +(voiced / fr.length * 100).toFixed(1) : 0,
    minHz: ok ? Math.round(mn) : null,
    maxHz: ok ? Math.round(mx) : null,
    range: ok ? (fmtNote(mn) + '–' + fmtNote(mx)) : null,
  };
}

// ===== 录音机：录音机式状态机 rec ⇄ paused ⇄ listen（可随时互切） =====
//   rec    ：检测+MediaRecorder 收集+帧沉淀，时间累计推进
//   paused ：MediaRecorder.pause，时间冻结，可回拖查看已录曲线（recSeek）
//   listen ：暂停录音 + 播放已录 PCM(recClip) 试听，可拖动；播完/继续录音回到原地续录
async function startRecording() {
  if (recState !== 'idle') return;
  // 引导蒙层先收起（2026-09-16 修）：#overlay 是 z-index:50 的全屏遮罩，若只
  // "拿到麦克风之后"那一行才隐藏它 —— 用户点「拒绝授权」、或机器没有麦克风时，
  // 蒙层永不消失，导入音频/存档/日志按钮全部被它吃掉点击 = 整站不可用。
  // 先收蒙层：授权失败也会由 catch 写状态栏，其余功能照常可用。
  overlay.classList.add('hidden');
  try {
    const ms = await ensureMic();        // 没申请过就申请并缓存（audio 域，含缓存语义）
    if (!audioCtx) await initAudio();
    await startMicRoute();
    const q = pickQuality(el('recQ') && el('recQ').value);
    const mime = q.type, opts = { audioBitsPerSecond: q.bps };
    try {
      recorder = MediaRecorder.isTypeSupported(mime)
        ? new MediaRecorder(ms, { ...opts, mimeType: mime }) : new MediaRecorder(ms, opts);
    } catch (e) { recorder = new MediaRecorder(ms, opts); }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => { const blob = new Blob(chunks, { type: mime }); finishRecording(blob); };
    // 录音帧/包络/累积 PCM 初始化；时间轴从 0 累计（暂停/续录后仍连续）
    recSessionSeq++;                   // 新会话令牌：作废所有"上一段的跨 await 收尾"
    recFrames = [];
    recEnv = [];
    recLastVoicedT = -1e9;
    recBaseT = 0;
    recActiveT0 = audioCtx.currentTime;
    recPcmChunks = []; recPcmLen = 0;
    recClip = null;
    recMinHz = NaN; recMaxHz = NaN;
    recorder.start(250);
    recState = 'rec';
    recStartT = performance.now();
    running = true; dbg.run = true;
    ensureLoop();
    setView('live');
    updateTransportUI();
    setStatus('● 录音中… ⏸可暂停 · ⏯可试听 · ■停止并保存');
    // 录音参数与当时的门控口径一起记：日后看"这段为什么没测出音"，先看这里的灵敏/收音
    log.info('rec', '开始录音', {
      quality: q.id, bps: q.bps, mime, sampleRate: ctxSr,
      sens: SENS.val,
      gate: GATE.auto ? 'auto' : ('manual ' + GATE.db + 'dB'),
      envDb: envBase > 1e-5 ? Math.round(dbOf(envBase)) : null,
    });
  } catch (e) {
    // 明确告诉用户"只是麦克风这条路走不通"，其余功能照常（导入音频/MIDI、回放都还能用）
    setStatus('无法开始录音：' + (e.message || e) + '（麦克风不可用不影响导入音频/MIDI 与回放）');
    log.error('rec', '开始录音失败：' + (e.message || e), e);
  }
}
// 冻结录音时间：把当前活跃段的时长并入 recBaseT（暂停/试听前必须调用）
function freezeRecTime() {
  if (recState === 'rec' && audioCtx) {
    recBaseT += Math.max(0, Math.round((audioCtx.currentTime - recActiveT0) * 1000));
  }
  recActiveT0 = 0;
}
// ⏸ 暂停录音：MediaRecorder.pause + 时间冻结 + 停止检测(曲线停住，可回拖查看)
function pauseRecording() {
  if (recState !== 'rec') return;
  freezeRecTime();
  try { if (recorder && recorder.state === 'recording') recorder.pause(); } catch (e) {}
  recState = 'paused';
  running = false; dbg.run = false;   // 停 tick；idleLoop 兜底渲染，曲线冻结
  setView('live');
  updateTransportUI();
  setStatus('⏸ 已暂停 · 可 ⏯试听 / ▶继续录音 / ■停止并保存');
  log.debug('rec', '暂停录音', { baseMs: recBaseT });
}
// ▶ 继续录音：从冻结点接着录(时间从 recBaseT 继续，不重来)
function resumeRecording() {
  if (recState !== 'paused') return;
  recActiveT0 = audioCtx.currentTime;
  recDragMs = null;                        // 退出回拖查看态
  if (recorder) {
    try { if (recorder.state === 'paused') recorder.resume(); } catch (e) {}
  }
  recState = 'rec';
  running = true; dbg.run = true;
  ensureLoop();
  setView('live');
  updateTransportUI();
  setStatus('● 录音中… ⏸可暂停 · ⏯可试听 · ■停止并保存');
  log.debug('rec', '继续录音', { baseMs: recBaseT });
}
// 从 recPcm 构建试听用的 AudioBuffer clip（暂停/试听共用）
// recPcm 是增长式累积：续录的新样本会追加进来，缓存 clip 必须按"已累积样本数"判断是否过期，
// 否则第二次试听/续录后试听还是第一段旧音频(2026-09-11 实测)。
function buildRecClip() {
  if (!recPcmLen) return null;
  if (recClip && recClip.pcmLen >= recPcmLen) return recClip;   // 未新增样本：复用缓存
  try {
    const buf = audioCtx.createBuffer(1, recPcmLen, ctxSr);
    // 按块直接拷进声道缓冲，不做"先拼成一整块连续 Float32Array"的中间拷贝
    copyChunked(recPcmChunks, recPcmLen, buf.getChannelData(0));
    recClip = { name: '(试听·未保存)', buffer: buf, blob: null, dur: buf.duration, pcmLen: recPcmLen };
    return recClip;
  } catch (e) { console.error('buildRecClip', e); return null; }
}
// ⏯ 试听：暂停录音 → 在录音机界面内播放已录 PCM（起点=暂停态拖到的位置 recDragMs，未拖过则从头）。
// 不切换播放器视图：按钮不跳位，随时可"继续录音"回原处续录
function startListening() {
  if (recState !== 'rec' && recState !== 'paused') return;
  freezeRecTime();                       // 冻结到当前累计时长，回来从这里接续
  try { if (recorder && recorder.state === 'recording') recorder.pause(); } catch (e) {}
  const recClipC = buildRecClip();
  if (!recClipC) { setStatus('还没有可试听的内容'); recState = 'paused'; running = false; updateTransportUI(); return; }
  stopLiveFeeding();
  if (pl.src) teardownPlay();
  // 起点跟随：暂停态拖过 recSeek(recDragMs) → 从该位置试听；否则从头(0)
  const startSec = (recState === 'paused' && recDragMs != null)
    ? Math.max(0, Math.min(recClipC.dur, recDragMs / 1000)) : 0;
  pl.clip = recClipC; pl.playing = false; pl.pos = startSec; pl.dur = recClipC.dur;
  recState = 'listen';
  running = false; dbg.run = false;   // 试听=回放非检测；tick 由 playInfo.on(=playerPlay) 驱动
  setView('live');                     // 留在录音机视图，按钮不跳位
  playerPlay();
  updateTransportUI();
  setStatus('⏯ 试听中(录到 ' + fmtDur(recBaseT / 1000) + ')… ▶继续录音回原处 · ■保存');
  log.debug('rec', '进入试听', { baseMs: recBaseT, durSec: +recClipC.dur.toFixed(2), startSec: +startSec.toFixed(2) });
}
// 从试听/暂停回到录音：回到冻结点(recBaseT)接着录
function resumeFromListen() {
  freezeRecTime();                       // 保险：试听中可能有残余活跃段
  if (pl.src) teardownPlay();
  recActiveT0 = audioCtx.currentTime;
  recDragMs = null;
  if (recorder) {
    try { if (recorder.state === 'paused') recorder.resume(); } catch (e) {}
  }
  recState = 'rec'; running = true; dbg.run = true;
  routeNow('mic');                       // 恢复 mic 接入 analyser（试听时已 stopLiveFeeding）
  ensureLoop();
  setView('live');
  updateTransportUI();
  setStatus('● 录音中…(从 ' + fmtDur(recBaseT / 1000) + ' 续录) · ⏸暂停 · ⏯试听 · ■保存');
  log.debug('rec', '试听结束，回到录音原处续录', { baseMs: recBaseT });
}
function stopRecording() {
  if (!recorder || recState === 'idle') return;
  freezeRecTime();                       // 停止前并入最后一段时长
  if (pl.src) teardownPlay();            // 试听中停止 → 先停试听
  recState = 'idle';
  running = false; dbg.run = false;
  try { recorder.stop(); recorder = null; } catch (e) {}
  setStatus('保存中…');
  setView('live'); updateTransportUI();
  log.info('rec', '停止录音', { totalMs: recBaseT });
}
// 丢弃未保存的录音会话(录音/暂停/试听中载入新音频等场景)：
// 与 stopRecording 不同——不能触发 recorder.onstop 把当前录音存成片段，
// 而是摘掉 onstop 后静默 stop，并清空全部录音工程数据，把 recState 归位 idle，
// 否则 isProjPlayback/liveRec 会在新片段上误用旧录音的帧(实时算法曲线/拖动无完整前段)。
function abortRecordSession(silent) {
  if (recState === 'idle') return false;
  if (recorder) {
    const r = recorder; recorder = null;
    try { r.onstop = null; if (r.state !== 'inactive') r.stop(); } catch (e) {}
  }
  if (pl.src) teardownPlay();
  stopLiveFeeding();
  recState = 'idle';
  running = false; dbg.run = false;
  recFrames = null; recEnv = null; recPcmChunks = []; recPcmLen = 0;
  recClip = null; recMinHz = NaN; recMaxHz = NaN; recDragMs = null;
  recBaseT = 0; recActiveT0 = 0; recLastVoicedT = -1e9;
  if (!silent) log.warn('rec', '已丢弃未保存的录音会话', {});
  return true;
}
// 换内容会把未保存的录音丢掉 —— 这件事必须让用户【看见】，不能只写日志：
// loadClip 里置位，由调用方的 setStatus 拼上（在这里直接 setStatus 会被调用方后面的
// "✓ 已导入…" 覆盖掉，用户等于还是看不到）。
// ⚠ 为什么不是"读一次就清"：同一次操作里常常有两次状态写入（域内一条 + 调用方一条更具体的），
//   用户只看得到最后那条 → 提示必须在这几次同步写入里都带着。故等下一个宏任务再撤掉。
let recDiscardNote = '';
let recDiscardClear = 0;
function markRecDiscarded() {
  recDiscardNote = '（⚠ 已丢弃上一段未保存的录音）';
  if (recDiscardClear) clearTimeout(recDiscardClear);
  recDiscardClear = setTimeout(() => { recDiscardNote = ''; }, 0);
}
function discardNoteSuffix() { return recDiscardNote; }
// 工程挂细粒度包络(10ms 窗 rms)：分段器的吐音气口切分线索(93ms 检测窗看不见气口)
function attachEnv(proj, buf) {
  try { if (buf) proj.env = computeEnv(buf.getChannelData(0), buf.sampleRate); } catch (e) {}
}

async function finishRecording(blob) {
  const name = '录音 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const seq = recSessionSeq;          // 本段录音的会话令牌（下面 await 之后要复核）
  try {
    const buf = await decodeBuf(blob);
    // ⚠ 解码是 await，而 stopRecording 一返回按钮就变回「● 开始录音」——
    // 用户完全可能在这几十~几百毫秒里又录一段。无条件往下清累积缓冲（下面 nLive/nPcm
    // 那两行）再 loadClip → 清掉新会话的数据，并由 loadClip→abortRecordSession 把新录音
    // 静默掐掉（第二段没了，界面回到第一段）。2026-09-18 修：会话令牌对不上就整段收尾作废。
    if (seq !== recSessionSeq) {
      log.warn('rec', '保存期间已开新录音 —— 本次收尾作废，不碰新会话', { seq, now: recSessionSeq, name });
      return;
    }
    // 2026-09-08 定案：**录音结束 = 导入音频**，一律走离线整段分析(loadClip → autoAnalyzeClip)。
    //
    // 不要把录音期的实时检测帧 recFrames 经 recFramesToAnalysis() 直接当工程：
    // 数据(noAutoAnalyze:true)，理由是"零切换、回放曲线即录音所见"。代价是实时分段的
    // 每一个误判都被永久写进工程/回放/导出的 MIDI——块左右漂、前后合并分裂、快吐丢块
    // 全都源于此。实时侧还是每帧全量重分段，同一段音频每次读到的块都可能不同。
    //
    // 离线侧则相反：analyzeOffline 一次算完 + ensureProjNotes 命中缓存永不重算，
    // 实测 5 个真实录音各跑两次 segmentPoints 结果 JSON 全等(块不可能变)，
    // 且分析速度 8-10 倍实时(单线程)，4 worker 并行后 1 分钟录音约 2-3 秒，等待可接受。
    //
    // 注：recFrames/recEnv 暂仍采集(录音期的琴键发光与音域读数在用)，本步不再消费它们。
    const nLive = recFrames ? recFrames.length : 0;
    const nPcm = recPcmLen;
    recFrames = null; recEnv = null; recPcmChunks = []; recPcmLen = 0; recClip = null;
    recMinHz = NaN; recMaxHz = NaN; recDragMs = null;
    // 先记日志再 loadClip：loadClip 会同步触发 autoAnalyzeClip 的打点，
    // 顺序反了会出现"分析完成在前、录音已保存在后"的时序倒挂
    log.info('rec', '录音已保存，转入离线整段分析(结果摘要见 analyze 打点)', {
      name, durationSec: +buf.duration.toFixed(2), sampleRate: buf.sampleRate,
      liveFrames: nLive, pcmSamples: nPcm,
    });
    if (!nLive) log.warn('rec', '录音期间一个实时检测帧都没有(多半全程没够到收音门槛)', { name });
    // 自动存档：录音跟导入音频同语义，录完即入库，不必手动点「存工程」。
    // 真正的落库动作放在 autoAnalyzeClip 里（那里才有确定的工程 id + 音频指纹），
    // 这里只把"待归档的那段"记下来，供它识别。
    projAutoArchivePending = { name, blob, buf, source: proj.SOURCE_REC };
    loadClip({ name, buffer: buf, blob });   // 不传 noAutoAnalyze → 触发后台整段分析
    try { renderTemplate(snapshot(), performance.now()); } catch (e) {}
  } catch (e) {
    setStatus('录音保存失败：' + (e.message || e));
    log.error('rec', '录音保存失败：' + (e.message || e), e);
  }
}
// ===== 解码 & 导入 =====
async function decodeBuf(src) {
  const ab = src instanceof ArrayBuffer ? src : (src.arrayBuffer ? await src.arrayBuffer() : src);
  if (!audioCtx) await initAudio();
  return audioCtx.decodeAudioData(ab);
}
// 「导入即播」唯一读点（2026-09-19 修"勾了也无效"）：导入音频与 MIDI 都要读它，
// 导入 MIDI / 曲库点歌走 importMidiNotes 时不传 autoplay → 永远不自动播，
// 勾选框在整条 MIDI 链路上形同虚设。现在三条导入路共用这一个口径。
// （打开存档仍不自动播——那是"打开"不是"导入"，先让用户看整段曲线。）
function autoPlayWanted() {
  const c = el('autoPlayOnImport');
  return !(c && !c.checked);
}
function importAudio(file) {
  if (!file) return;
  log.info('import', '开始导入音频', { name: file.name, sizeKB: Math.round(file.size / 1024), type: file.type || null });
  decodeBuf(file).then((buf) => {
    const name = (file.name || '导入音频').replace(/\.[^.]+$/, '');
    // 导入音频与录音同语义自动存档。blob 必须带上原始 file——
    // 不带的话 curProject.audioBlob 是 null，存档就只有曲线没有声音，
    // 而"以后能反复打开播放"正是存档的意义（2026-09-14）。
    projAutoArchivePending = { name, blob: file, buf, source: proj.SOURCE_IMPORT };
    const ap = autoPlayWanted();
    loadClip({ name, buffer: buf, blob: file }, { autoplay: ap });
    // 文案必须跟实际一致：没勾「导入即播」时 loadClip 压根没播（不能无条件写"正在播放"）
    setStatus('✓ 已导入 ' + name + ' · ' + fmtDur(buf.duration)
      + (ap ? '，正在播放' : '，已就绪（点 ▶ 播放）') + discardNoteSuffix());
    log.info('import', '音频导入成功', {
      name, durationSec: +buf.duration.toFixed(2), sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels, sizeKB: Math.round(file.size / 1024),
    });
  }).catch((err) => {
    setStatus('导入失败(不支持的格式?)：' + (err.message || err));
    log.error('import', '音频导入失败：' + (err.message || err), { name: file.name, sizeKB: Math.round(file.size / 1024) });
  });
}

// ===== MIDI 导入(纯 MIDI 工程) 与 导出 =====
// 静音 buffer 当播放时间轴：复用整套传输(播放/暂停/拖动/查表)，
// 钢琴块按 midiNotes 音符事件渲染+自动弹奏(Salamander)。

// 同音高时间重叠的音符合并成一个(时间取并集、力度取最大)。
// 东方多轨 MIDI 里"Bass L/R 镜像轨、长垫+同音短吐、双乐器同音齐奏"是常态
// (实测曲库每首 307~2954 对)；不去重则钢琴块同色胶囊叠画 + bloom 加法混合
// → 重叠区通道削顶发白(2026-09-13 截图定案)，且重复触发琴声。
function mergeSamePitchNotes(notes) {
  const byMidi = new Map();
  for (const n of notes) {
    if (!byMidi.has(n.midi)) byMidi.set(n.midi, []);
    byMidi.get(n.midi).push(n);
  }
  const out = [];
  for (const [, arr] of byMidi) {
    arr.sort((a, b) => a.t0 - b.t0);
    let cur = null;
    for (const n of arr) {
      if (cur && n.t0 <= cur.t1) {                     // 重叠或相接 → 并入当前块
        if (n.t1 > cur.t1) cur.t1 = n.t1;
        if ((n.vel || 0) > (cur.vel || 0)) cur.vel = n.vel;
      } else {
        if (cur) out.push(cur);
        cur = { ...n };
      }
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

async function importMIDI(file, opts) {
  if (!file) return;
  try {
    const parsed = parseSMF(await file.arrayBuffer());
    const notes = [];
    for (const tr of parsed.tracks) { if (tr.isPercussion) continue; for (const n of tr.notes) notes.push(n); }
    notes.sort((a, b) => a.t0 - b.t0);
    const merged = mergeSamePitchNotes(notes);
    if (!merged.length) {
      setStatus('该 MIDI 没有可用的音符(可能全是打击乐轨)');
      log.warn('midi', 'MIDI 无可用音符（可能全是打击乐轨）', { name: file.name, tracks: parsed.tracks.length });
      return;
    }
    log.info('midi', 'MIDI 导入成功', { name: file.name, notes: merged.length, rawNotes: notes.length, tracks: parsed.tracks.length });
    importMidiNotes(merged, file.name, opts);
  } catch (err) {
    setStatus('MIDI 解析失败：' + (err.message || err));
    log.error('midi', 'MIDI 解析失败：' + (err.message || err), { name: file.name });
  }
}

function importMidiNotes(notes, name, { archive = true } = {}) {
  if (!audioCtx) initAudio();
  const durMs = notes.reduce((m, n) => Math.max(m, n.t1), 0) + 1200;
  const buf = audioCtx.createBuffer(1, Math.ceil(durMs / 1000 * audioCtx.sampleRate), audioCtx.sampleRate);   // 静音时间轴
  const nm = (name || 'MIDI').replace(/\.[^.]+$/, '') + ' · 钢琴块';
  curProject = { id: proj.makeId(), name: nm, isMidi: true, kind: proj.KIND_MIDI,
    source: proj.SOURCE_MIDI,
    midiNotes: notes, bufferRef: buf, duration: durMs / 1000, createdAt: Date.now(),
    audioName: name || '', audioMime: 'audio/midi', auto: false };
  // 「导入即播」对 MIDI 同样生效（2026-09-19 修，唯一读点 autoPlayWanted）：
  // 勾选（默认）→ 装载后立即开始播放，钢琴块直接开弹；取消勾选 → 停在播放视图等用户点。
  const ap = autoPlayWanted();
  loadClip({ name: nm, buffer: buf, silent: true }, { noAutoAnalyze: true, autoplay: ap });   // silent：静音时间轴，非真实音频
  if (audioCtx.state === 'suspended') audioCtx.resume();
  // MIDI 导入的意义就是看自动弹奏：自动切钢琴块模板并开钢琴声(用户可再关)
  try { localStorage.setItem('ydyi_piano_sound', '1'); } catch (e) {}
  if (anim.current() && anim.current().id !== 'pianoBlocks') switchTemplate('pianoBlocks');
  const pb = anim.get('pianoBlocks');
  if (pb && pb.setSoundEnabled) pb.setSoundEnabled(true);
  // 自动存档：导入的 MIDI 立刻进存档库（只存音符表，几 KB，不占空间）。
  // ⚠ 曲库点开的内置 demo 曲不入档：内置曲永远在曲库里，
  //   抄一份进「我的存档」只是噪音；{archive:false} 由 library 域传入。
  if (archive) projAutoArchive(curProject, proj.SOURCE_MIDI, '导入 MIDI');
  setStatus('✓ 已导入 MIDI：' + notes.length + ' 个音符 · ' + (ap ? '正在自动弹奏' : '按播放即看钢琴自动弹奏') + discardNoteSuffix());
  projSetCurrentUI();
}

// ===== 曲库：已抽成 app/library.mjs（2026-09-15「① 状态收敛」第三域）=====
//   app 侧唯一接触点：
//   - configureLibrary({ setStatus, importMIDI })  启动时注入
//   - 工具条上的「曲库」按钮调 toggleLibPanel()

// ===== AI 转谱：Spotify Basic Pitch 浏览器推理，音频→复调音符事件 =====
// 全本地：tfjs(UMD) 与 basic-pitch 的补丁源文件/模型权重均已入库（.gitignore 白名单放行），
// clone 后开箱即用，不需要 npm install。
// 万一这几个文件被删，用下面的命令按原版本从 CDN 重下：
//   mkdir -p vendor/tfjs vendor/basic-pitch/model
//   curl -sL -o vendor/tfjs/tf.min.js https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js
//   curl -sL -o vendor/basic-pitch/model/model.json https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json
//   curl -sL -o vendor/basic-pitch/model/group1-shard1of1.bin https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/group1-shard1of1.bin
//   for f in index inference matchers toMidi; do curl -sL -o vendor/basic-pitch/$f.js https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/esm/$f.js; done
//   (然后 sed 把 inference.js 的 '@tensorflow/tfjs' 指到 ../../dsp/bp-tf-proxy.mjs)
let aiBusy = false;
async function aiTranscribe() {
  if (aiBusy) return;
  if (!hasTranscribableAudio()) { setStatus('AI转谱只对音频工程有效：MIDI 工程/无音频存档没有真实音频'); return; }
  const buf = curProject && curProject.bufferRef;
  if (!buf || !(buf.duration > 0)) { setStatus('AI转谱需要音频工程(先导入音频)'); return; }
  if (buf.duration > 600) { setStatus('音频超过 10 分钟，浏览器推理太慢，建议截短后再转'); return; }
  aiBusy = true;
  const t0 = Date.now();
  log.info('ai', '开始 AI 转谱', { name: curProject && curProject.name, durationSec: +buf.duration.toFixed(2) });
  try {
    if (!window.__bpMod) {
      setStatus('AI转谱：加载本地 AI 模型(约 900KB)…');
      window.__bpMod = await import('./vendor/basic-pitch/index.js');
    }
    const bp = window.__bpMod;
    setStatus('AI转谱：重采样到 22050Hz 单声道…');
    // Basic Pitch 硬性要求 22050Hz 单声道 AudioBuffer(否则内部直接抛错)，先降混重采样
    const oc = new OfflineAudioContext(1, Math.ceil(buf.duration * 22050), 22050);
    const srcN = oc.createBufferSource(); srcN.buffer = buf; srcN.connect(oc.destination); srcN.start();
    const mono = await oc.startRendering();
    setStatus('AI转谱：推理中…(WebGL 加速，一首歌约几十秒)');
    let frames = [], onsets = [], contours = [];
    await new bp.BasicPitch('./vendor/basic-pitch/model/model.json')
      .evaluateModel(mono,
        (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
        (p) => setStatus('AI转谱：推理中 ' + Math.round(p * 100) + '%'));
    const events = bp.noteFramesToTime(bp.addPitchBendsToNoteEvents(contours, bp.outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)));
    const notes = events
      .map(n => ({
        midi: Math.round(n.pitchMidi),
        t0: Math.round(n.startTimeSeconds * 1000),
        t1: Math.round((n.startTimeSeconds + n.durationSeconds) * 1000),
        vel: Math.max(0.1, Math.min(1, n.amplitude ?? 0.8)),
      }))
      .filter(n => n.t1 > n.t0 && n.midi >= 21 && n.midi <= 108)
      .sort((a, b) => a.t0 - b.t0);
    if (!notes.length) {
      setStatus('AI转谱完成：未检出音符');
      log.warn('ai', 'AI 转谱未检出音符', { costSec: Math.round((Date.now() - t0) / 1000) });
      return;
    }
    // ⚠ 上面这些 await 加起来可能几十秒（模型导入 / 重采样 / 推理）。期间用户完全可能
    // 切到别的片段、点「＋新建」或打开存档 —— 必须确认"还是当初那个工程、那段音频"：
    // 否则音符会挂到别的工程上；curProject 为 null 时这行还会抛 TypeError，
    // 被下面的 catch 报成"AI转谱失败（检查 vendor/ 目录是否完整）"，把真因盖掉。
    // buf 就是 1229 行抓下来的 bufferRef，直接比引用即可。2026-09-18 修。
    if (!curProject || curProject.bufferRef !== buf) {
      setStatus('AI转谱完成，但工程已被切换 —— 结果已丢弃（回到原工程再转一次即可）');
      log.warn('ai', 'AI 转谱结果作废：推理期间工程/片段已被切换', {
        notes: notes.length, costSec: Math.round((Date.now() - t0) / 1000),
      });
      return;
    }
    curProject.midiNotes = notes;
    setStatus('✓ AI转谱完成：' + notes.length + ' 音符 / 用时 ' + Math.round((Date.now() - t0) / 1000) + 's · 钢琴块已切换为转谱结果，可「存MIDI」导出');
    log.info('ai', 'AI 转谱完成', { notes: notes.length, costSec: Math.round((Date.now() - t0) / 1000) });
    projSetCurrentUI();
  } catch (e) {
    setStatus('AI转谱失败：' + (e.message || e) + '(检查 vendor/ 目录是否完整)');
    log.error('ai', 'AI 转谱失败：' + (e.message || e), e);
  } finally { aiBusy = false; }
}

// 导出当前工程音符为 .mid：MIDI 工程/存MIDI按钮(AI转谱)共用
function downloadMidi(notes, baseName) {
  log.info('midi', '导出 MIDI 文件', { notes: notes.length, file: (baseName || 'audio') + '.mid' });
  const ab = writeSMF(notes.map(n => ({ midi: n.midi, t0: n.t0, t1: n.t1, vel: n.vel })));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ab], { type: 'audio/midi' }));
  a.download = (baseName || 'audio') + '.mid';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 「存MIDI」按钮（主界面 #playCtrls，2026-09-19 从钢琴块面板搬来）：
// MIDI 工程=音符表直出；音频工程=用检测分段现算。与模板无关，故属全局。
function exportProjectMidi() {
  let notes = null;
  if (curProject && curProject.midiNotes) notes = curProject.midiNotes;
  else if (curProject && curProject.analysis && curProject.analysis.frames) {
    notes = segmentPoints(curProject.analysis.frames
      .filter(f => f.voiced !== false && Number.isFinite(f.freq) && f.freq > 0)
      .map(f => ({ t: f.t, f: f.freq, rms: f.rms, prom: f.prom, purity: f.purity })), curProject.env);
  }
  if (!notes || !notes.length) { setStatus('当前工程没有可导出的音符(先播放/分析或转谱)'); return; }
  downloadMidi(notes, curProject.name || 'ydyi');
  setStatus('✓ 已导出 ' + notes.length + ' 个音符为 .mid');
}

// 载入片段并切到播放器界面
function loadClip(clip, { autoplay = false, noAnalyze = false, noAutoAnalyze = false } = {}) {
  // ⚠ 换片段 = 作废在途的整段分析（放在最前，所有入口共用）：
  //   分析回调只以 analyzeSeq 为凭据，不作废的话它几秒后会把 curProject 写成"上一个片段"的
  //   工程，而 pl.clip 已是新 buffer → isProjPlayback 判 false → 回放退回实时检测，
  //   曲线与音符凭空消失（打开存档走的是 noAnalyze 路径，不推进 seq 就会这样）。
  //   analyzing 也要跟着复位，否则状态栏永久停在"正在分析"（与 newSession 同一根因）。
  //   2026-09-18 修。
  analyzeSeq++;
  analyzing = false;
  // 录音/暂停/试听中导入新音频 → 丢弃未保存的录音会话(recState 归 idle)，
  // 否则 isProjPlayback=false→ liveRec 误用旧录音帧，离线分析曲线/拖动全不对。
  // 录音保存路径(finishRecording)此时 recState 已是 idle，此处为空操作。
  // ⚠ 丢弃就是真丢（不保存），故把"丢了"记进提示，由调用方的 setStatus 带出去。
  if (abortRecordSession(false)) markRecDiscarded(); else recDiscardNote = '';
  if (pl.src) teardownPlay();
  stopLiveFeeding();
  running = false; dbg.run = false;   // 停止实时 mic 检测(回放由播放驱动)
  adoptClip(clip);                    // 自增片段代际 + 写 curClip/pl —— player 域的唯一装载入口
                                      // （"clipSeq++"与"curClip/pl 赋值"必须写在一处，散在两处漏改一处就静默不同步）
  resetStats();
  setView('play');
  updateTransportUI();
  if (noAnalyze) {
    // 打开存档：直接用存档分析(若绑定了 buffer 则查表立即可用)
    if (curProject && curProject.bufferRef !== clip.buffer) curProject = null;
  } else if (!noAutoAnalyze) {
    autoAnalyzeClip(clip);   // 后台整段分析 → 工程(可拖动查表/画整段曲线)
  } // noAutoAnalyze: 录音保存路径——工程由录音帧沉淀，随后在 finishRecording 中挂载
  if (autoplay) playerPlay();
}

// ---- 离线整段分析(对标同类应用"音频文件音高识别") ----
// 抽单声道 PCM，worker 并行分析。完成后建 curProject，播放/拖动转为查表。
let analyzeSeq = 0;
async function autoAnalyzeClip(clip) {
  const seq = ++analyzeSeq;
  // 重算前先记下"同一段 buffer 已有工程"的 AI 转谱结果：音符表由音频本身决定，
  // 与灵敏度/内核无关，重算不该把它丢掉（切内核或在播放视图调灵敏重算后，
  // 转谱结果会静默消失，钢琴块又变回曲线分段）——2026-09-16 修。
  const prev = (curProject && clip && curProject.bufferRef === clip.buffer) ? curProject : null;
  const keepNotes = (prev && prev.midiNotes && prev.midiNotes.length) ? prev.midiNotes : null;
  curProject = null;                    // 旧工程失效(新片段未就绪前走实时)
  if (!clip || !clip.buffer) return;
  const buf = clip.buffer;
  const pcm = buf.getChannelData(0);    // 单声道(干声场景 ch0 足够；多声道混合会引入反相风险)
  analyzing = true;
  setStatus('正在分析整段音高… 稍候即可拖动时间线查看曲线');
  const t0 = performance.now();
  const onProgress = (r, label) => {
    if (analyzeSeq !== seq) return;     // 已切换到别段
    setStatus('正在分析音高 ' + Math.round(r * 100) + '% …（本次不需静等播放）');
  };
  // 跟随实时口径分析：sens 用当前灵敏度；能量门带现场底噪/手动 dB
  // (自动但从未校准过 → 不传 energy，让离线按文件内容自适应)。
  // 这样离线曲线与录音/实时检测同源，查表回放曲线才不会和录音对不上。
  const opt = {
    hopSize: 1024,
    // 大文件用硬件并发；短音频 worker 开销大，≤8s 直接单线程
    workerCount: buf.duration > 8 ? 0 : 1,
    sens: SENS.val,
    kernel: kernelId,           // 离线重算用与实时一致的内核，保证两条曲线同源
  };
  if (!GATE.auto || envBase > 1e-5) {
    opt.energy = { mode: GATE.auto ? 'auto' : 'manual', envRms: envBase, db: GATE.db };
  }
  // 分析入口参数入日志：曲线画歪时，第一件事就是核对当时用的是哪套灵敏/收音口径
  log.info('analyze', '开始离线整段分析', {
    name: clip.name, durationSec: +buf.duration.toFixed(2), sampleRate: buf.sampleRate, ...opt,
  });
  analyzeOffline(pcm, buf.sampleRate, opt, { onProgress })
    .then((analysis) => {
      if (analyzeSeq !== seq) return;   // 过期(用户已切走/新建)
      analyzing = false;
      const dt = ((performance.now() - t0) / 1000).toFixed(0);
      const pend = (projAutoArchivePending && projAutoArchivePending.buf === clip.buffer)
        ? projAutoArchivePending : null;
      curProject = {
        id: proj.makeId(),
        name: clip.name, createdAt: Date.now(),
        bufferRef: clip.buffer,          // 绑定当前 buffer(查表生效判据)
        audioName: clip.name,
        // 来源：录音 / 导入音频在 loadClip 前就写进了 pending。万一没有（老路径直接调
        // loadClip、没设 pending），只能退回"导入音频"这个保守值 —— 纯曲线/无 blob 的工程
        // 也走这里。⚠ 2026-09-22 核对：原写作 `(clip.blob ? SOURCE_IMPORT : SOURCE_IMPORT)`
        // 两分支同值，与注释"按内容猜"不符；这里只是把代码写成它实际的样子（值不变）。
        // 真要按内容判定得改用 inferSource()，那是会变存档分类的行为变更，另行决策。
        source: (pend && pend.source) || proj.SOURCE_IMPORT,
        duration: buf.duration,
        analysis,
        env: computeEnv(buf.getChannelData(0), buf.sampleRate),
        audioBlob: clip.blob || null,
        // 同一段 buffer 之前转过的谱：带上，重算(换内核/调门控)不该让转谱结果消失。
        // 注意它是"音频本身的属性"，故只在 bufferRef 相同(见函数头的 prev)时继承。
        midiNotes: keepNotes || null,
        auto: true,
      };
      // 音频指纹（projectToFile / projectSave / 存档字段都带 audioHash；不算的话 →
      // 恒为空串，而 autoArchive 的注释却写着"此时指纹已齐"。这里补上，供日后
      // "同一个工程"的粗校验；算不出也不影响主流程。
      try { curProject.audioHash = proj.audioHashFromBuffer(buf); } catch (e) {}
      const st = analysis.stats || {};
      const n = st.minHz && st.maxHz
        ? fmtNote(st.minHz) + '–' + fmtNote(st.maxHz) : '';
      setStatus('✓ 已分析 ' + fmtDur(buf.duration) + '(' + dt + 's)· 音域 ' + n + ' · 拖动时间线即查曲线');
      log.info('analyze', '分析完成', {
        name: clip.name, costSec: +dt, durationSec: +buf.duration.toFixed(2),
        ...analysisSummary(analysis),
      });
      projSetCurrentUI();
      // 自动存档（录音 / 导入音频）：分析完成时一次性落库——此时工程 id、音频指纹、
      // 分析帧、细粒度包络全都齐了，不必"先存一次再补写"。MIDI 走 importMidiNotes 自己的落库，
      // 不进这条路径（pend 只会被录音/导入音频设置）。
      if (projAutoArchivePending && projAutoArchivePending.buf === clip.buffer) {
        // 来源在 pending 里就定好了（录音 / 导入音频），落库那一刻写死，
        // 不能靠名字事后倒推——那正是"录音被标成导入音频"的根因。
        const src = projAutoArchivePending.source || proj.inferSource(curProject);
        if (src) curProject.source = src;
        projAutoArchivePending = null;
        projAutoArchive(curProject, src);
      }
      // 分析完成立即渲染一帧，让整段曲线马上出现(否则要等下个空闲/idle 渲染周期)
      try { renderTemplate(snapshot(), performance.now()); } catch (e) {}
    })
    .catch((err) => {
      if (analyzeSeq !== seq) return;
      analyzing = false;
      setStatus('分析失败：' + (err && err.message || err));
      log.error('analyze', '分析失败：' + (err && err.message || err), { name: clip.name, ...opt });
    });
}
function fmtNote(hz) {
  const n = freqToNote(hz);
  return n.name === '--' ? '' : n.name + n.oct;
}
// 回到录音机界面（不删已录内容，仅复位视图，可重新录音）
function newSession() {
  if (pl.src) teardownPlay();
  stopLiveFeeding();
  running = false; dbg.run = false;
  resetClip();                            // 自增代际 + 清零 pl（与 loadClip 的 adoptClip 同一语义）
  analyzeSeq++;                    // 作废进行中的分析
  // ⚠ 必须一并复位 analyzing：作废后 autoAnalyzeClip 的 then/catch 都以 `analyzeSeq !== seq`
  // 提前 return，那个 `analyzing = false` 永远执行不到 → 状态栏（projSetCurrentUI）会永久停在
  // "⚙ 正在分析整段音高…"、reanalyzeIfProject 恒 false（改灵敏/收音不再重算整段）。
  // 2026-09-18 修（导入长音频→点「＋新建」即复现；打开存档走 noAnalyze 路径不会自愈）。
  analyzing = false;
  curProject = null;
  resetStats();                    // 清音域统计 + 顶部大读数（否则残留上一工程，2026-09-16 修）
  setView('live');
  updateTransportUI();
  setStatus('就绪。● 开始=实时检测+录音，■停止=保存。可 📂导入 试听。');
  projSetCurrentUI();
}

// 播放器引擎（teardownPlay / playerPlay / playerPause / playerToggle / playerSeek /
// playerReplay / setPlayUI）已搬到 app/player.mjs（① 状态收敛第五域）。
// 这里只剩音频输出侧的两件小事（playOutNode / stopLiveFeeding 属音频路由）。
// stopLiveFeeding / playOutNode / ensurePlayOut 已搬到 app/audio.mjs（与 micGain 同域）
function updateTransportUI() {
  if (appView === 'live') {
    const t = el('recClock');
    if (t) {
      // 试听态显示试听播放头，其余显示录音累计时长
      const secs = recState === 'listen' ? nowPosSec() : (recState !== 'idle' ? recTimeSec() : 0);
      t.textContent = '⏺ ' + fmtClock(secs);
      t.classList.toggle('on', recState === 'rec');
    }
    // 主按钮四态：●开始 → ⏸暂停 → ▶继续 → ●继续录音(试听态回原处续录)
    const recB = el('btnRec');
    if (recB) {
      if (recState === 'idle') { recB.textContent = '● 开始录音'; recB.classList.remove('rec-stop'); }
      else if (recState === 'rec') { recB.textContent = '⏸ 暂停录音'; recB.classList.add('rec-stop'); }
      else if (recState === 'paused') { recB.textContent = '▶ 继续录音'; recB.classList.remove('rec-stop'); }
      else { recB.textContent = '● 回到录音续录'; recB.classList.remove('rec-stop'); }  // listen
    }
    // 试听按钮：rec/paused 显示"⏯ 试听"；listen 显示 播放/暂停
    const aud = el('btnAud');
    if (aud) {
      if (recState === 'rec' || recState === 'paused') { aud.style.display = ''; aud.textContent = '⏯ 试听'; }
      else if (recState === 'listen') { aud.style.display = ''; aud.textContent = pl.playing ? '⏸ 暂停试听' : '▶ 继续试听'; }
      else aud.style.display = 'none';
    }
    // 停止并保存小按钮：任何录音/试听状态都出现
    const sv = el('btnSaveRec');
    if (sv) sv.style.display = recState === 'idle' ? 'none' : '';
    // 走带条：暂停=回看；试听=选播放位置；rec 隐藏（录音中无需拖动）
    const showSeek = recState === 'paused' || recState === 'listen';
    const rs = el('recSeek');
    const rst = el('recSeekT');
    if (rs) {
      rs.style.display = showSeek ? '' : 'none';
      if (recState === 'paused' && recBaseT > 0) {
        const pos = recDragMs != null ? recDragMs : recBaseT;
        rs.value = String(Math.round(Math.max(0, Math.min(1000, pos / recBaseT * 1000))));
      } else if (recState === 'listen' && pl.clip) {
        // 试听：走带条跟随实时播放头(nowPosSec)，拖动中不覆盖用户手的位置
        const pos = nowPosSec();
        if (!recSeekDragging) {
          rs.value = pl.dur ? String(Math.round(Math.max(0, Math.min(1000, pos / pl.dur * 1000)))) : '0';
        }
      }
    }
    if (rst) {
      rst.style.display = showSeek ? '' : 'none';
      if (recState === 'paused') {
        const pos = recDragMs != null ? recDragMs : recBaseT;
        rst.textContent = fmtBar(pos / 1000) + '/' + fmtBar(recBaseT / 1000);
      } else if (recState === 'listen' && pl.clip) {
        // 试听：用实时推进位置(pl 播放头+已播音程)，不用冻结的 pl.pos——否则走带条不动/乱跳
        const pos = nowPosSec();
        if (!recSeekDragging) {
          rst.textContent = fmtBar(pos) + '/' + fmtBar(pl.dur);
        }
      }
    }
  }
  if (appView === 'play' && pl.clip) {
    const pos = plPos();                     // 播放头（含倍速推进）唯一实现见播放器域
    const cur = el('pCur'), tot = el('pTot'), bar = el('pSeek');
    if (cur && !seekDragging) cur.textContent = fmtBar(pos);   // 拖动中不覆盖用户手的位置
    if (tot) tot.textContent = fmtBar(pl.dur);
    if (bar && !seekDragging) bar.value = pl.dur ? (pos / pl.dur) * 1000 : 0;
  }
  syncRateUI();
  // 录音态变了 → 钢琴块面板里"录音中才显示"的控件（回声/落速）跟着显隐
  try { syncAnimBarDeps(); } catch (e) {}
  // RVC 变声控件：播放视图 **且有真实音频** 才显示（2026-09-16 修）。
  // 只看 appView==='play' 不够 → MIDI 工程 / 纯曲线存档（buffer 是新建的静音时间轴）
  // 也照样显示变声/模型/索引/key，点下去是把静音编码成 wav 送给本地桥，结果毫无意义。
  const showRvc = appView === 'play' && !!curClip && !curClip.silent;
  const rvcSel = el('rvcModel'), rvcKeyEl = el('rvcKey'), rvcBtn = el('btnRvc');
  const rvcIdxEl = el('rvcIndex'), rvcRateEl = el('rvcIdxRate');
  const rvcVisible = showRvc && rvcReady;
  if (rvcSel) rvcSel.style.display = rvcVisible ? '' : 'none';
  if (rvcIdxEl) rvcIdxEl.style.display = rvcVisible ? '' : 'none';
  if (rvcRateEl) rvcRateEl.style.display = rvcVisible ? '' : 'none';
  if (rvcKeyEl) rvcKeyEl.style.display = rvcVisible ? '' : 'none';
  if (rvcBtn) rvcBtn.style.display = rvcVisible ? '' : 'none';
  const rvcRe = el('btnRvcRestore');
  if (rvcRe) rvcRe.style.display = showRvc && preRvcClip ? '' : 'none';
  // 导出：同一口径 —— 静音时间轴没有声音可导出（点了只会拿到一个静音 wav），置灰并说明
  const bExp = el('btnExport');
  if (bExp) {
    const silent = appView === 'play' && !!curClip && !!curClip.silent;
    bExp.disabled = silent;
    bExp.title = silent ? 'MIDI 工程/无音频存档是静音时间轴，没有声音可导出；用「存MIDI」导出音符'
                        : '导出此段为音频文件';
  }
}

// ===== 倍速控件（播放器视图与录音试听共用一份，#rateCluster）=====
// 显隐按「控件作用域」约定：只有"有东西可放"的传输态才出现——播放器视图，或录音机的
// 暂停/试听态（暂停时不发声，但点「⏯ 试听」马上要用它）。录音中不出现，与走带条
// recSeek 的显隐规则同源（"录音中无需拖动"）。
function syncRateUI() {
  const wrap = el('rateCluster');
  if (!wrap) return;
  const show = (appView === 'play' && !!pl.clip) || recState === 'paused' || recState === 'listen';
  wrap.style.display = show ? '' : 'none';
  if (!show) return;
  const sel = el('playRate');
  // 只在真的不一致时才写：这个函数每帧都被 updateTransportUI 调到，无条件写 value
  // 会在用户展开下拉列表时跟浏览器抢状态（同值重写虽不改选中项，仍会重置弹出项高亮）
  if (sel && sel.value !== String(playRate)) sel.value = String(playRate);
  // 「变调」只对真音频有意义：MIDI 工程/无音频存档的 buffer 是静音时间轴，声音由琴声
  // 模块按音符合成（固定音高）→ 勾不勾听感都一样。不给"能点却没效果"的假象。
  const silent = !!curClip && !!curClip.silent;
  const tw = el('playTapeWrap'), tc = el('playTape');
  if (tw) tw.style.display = silent ? 'none' : '';
  if (tc && tc.checked !== pitchTape) tc.checked = pitchTape;
}
// ===== RVC 离线变声（可选功能：对接本地桥，默认 127.0.0.1:7865；桥不在本仓库内） =====
// 录音/导入的音频一键转音色：当前 AudioBuffer 编码 wav POST 给本地桥，
// 桥调官方 vc_single(GPU) 返回变声 wav → decodeAudioData → loadClip 重走导入
// 管线（自动整段重分析，曲线/钢琴块/音域统计 = 变声后版本）。
// 原始音频留在 preRvcClip，「↩ 还原」一键回变声前（同样重走分析）。
// 桥未启动时按钮自动隐藏，不影响其余功能（桥不在本仓库内，属可选外部依赖）。
const RVC_PORT = 7865;
let rvcReady = false, rvcBusy = false, preRvcClip = null;
let rvcModels = [];          // [{id,name,index,hasIndex}]，index 为该模型自动匹配的默认索引
const rvcUrl = (p) => `http://127.0.0.1:${RVC_PORT}${p}`;
async function rvcInit() {
  const sel = el('rvcModel'), idxSel = el('rvcIndex');
  if (!sel) return;
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 2500);   // 桥没启动时别让页面等
    const r = await fetch(rvcUrl('/models'), { signal: ctl.signal });
    clearTimeout(tid);
    const j = await r.json();
    if (!j.models || !j.models.length) throw new Error('无模型');
    rvcModels = j.models;
    sel.innerHTML = rvcModels.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    if (idxSel) {
      idxSel.innerHTML = '<option value="none">无索引</option>' +
        (j.indexes || []).map((p) => `<option value="${p}">${p.split('/').slice(-2).join('/')}</option>`).join('');
      rvcSyncIndex();
    }
    rvcReady = true;
    log.info('rvc', '本地桥就绪', { models: rvcModels.map((m) => m.id), indexes: j.indexes });
    updateTransportUI();
  } catch (e) {
    rvcReady = false;
    log.info('rvc', '未检测到本地变声桥，相关控件已隐藏', {});
  }
}
// 模型切换时把索引框预选为该模型的自动匹配结果（用户仍可手改成无索引/其他索引）
function rvcSyncIndex() {
  const idxSel = el('rvcIndex');
  if (!idxSel) return;
  const m = rvcModels.find((x) => x.id === (el('rvcModel') || {}).value);
  idxSel.value = m && m.index ? m.index : 'none';
}
async function rvcConvert() {
  if (rvcBusy) return;
  if (!curClip || !curClip.buffer) { setStatus('没有可变声的音频'); return; }
  if (curClip.silent) { setStatus('这段是静音时间轴（MIDI 工程/无音频存档），没有声音可变声——请先录音或导入音频'); return; }
  const model = el('rvcModel') && el('rvcModel').value;
  if (!rvcReady || !model) { setStatus('变声功能不可用：未检测到本地桥'); return; }
  rvcBusy = true;
  const btn = el('btnRvc');
  if (btn) { btn.disabled = true; btn.textContent = '变声中…'; }
  setStatus('RVC 变声中…（首次使用该模型需加载，稍候）');
  const t0 = performance.now();
  try {
    const wav = await bufferToWav(curClip.buffer).arrayBuffer();
    const q = new URLSearchParams({
      model,
      index: el('rvcIndex') ? el('rvcIndex').value : 'none',
      index_rate: String(+el('rvcIdxRate')?.value || 0),
      key: String(Math.round(+el('rvcKey').value || 0)),
      ext: '.wav',
    });
    const r = await fetch(rvcUrl('/convert?' + q), { method: 'POST', body: wav });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + r.status));
    }
    const ab = await r.arrayBuffer();
    const buf = await decodeBuf(ab);
    if (!preRvcClip) preRvcClip = { name: curClip.name, buffer: curClip.buffer, blob: curClip.blob || null };
    loadClip({ name: curClip.name + '·变声', buffer: buf }, { autoplay: false });
    setStatus('✓ 变声完成 ' + fmtDur(buf.duration) + '（耗时 ' + ((performance.now() - t0) / 1000).toFixed(1) + 's），正在重新分析音高');
    log.info('rvc', '变声完成', { model, index: q.get('index'), idxRate: q.get('index_rate'), key: q.get('key'), durSec: +buf.duration.toFixed(2) });
  } catch (e) {
    setStatus('RVC 变声失败：' + (e.message || e));
    log.error('rvc', '变声失败：' + (e.message || e), { model });
  } finally {
    rvcBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '变声'; }
  }
}
function rvcRestore() {
  if (!preRvcClip) return;
  const orig = preRvcClip;
  preRvcClip = null;
  loadClip(orig, { autoplay: false });
  setStatus('✓ 已还原原始音频，正在重新分析');
  log.info('rvc', '还原原始音频', { name: orig.name });
}

// setView 已搬到 app/player.mjs（与 appView 同域；它是 appView 的唯一写入口）

// ===== 导出当前片段 =====
function exportClip() {
  if (!curClip) { setStatus('没有可导出的片段'); return; }
  if (curClip.silent) { setStatus('MIDI 工程/无音频存档是静音时间轴，没有声音可导出；音符可用「存MIDI」导出'); return; }
  if (curClip.blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(curClip.blob);
    a.download = curClip.name + (curClip.blob.type.includes('webm') ? '.webm' : '.wav');
    a.click(); URL.revokeObjectURL(a.href);
  } else {
    const wav = bufferToWav(curClip.buffer);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(wav);
    a.download = curClip.name + '.wav';
    a.click(); URL.revokeObjectURL(a.href);
  }
  setStatus('已导出 ' + curClip.name);
}
function bufferToWav(buffer) {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate, len = buffer.length;
  const bytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(bytes), dv = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * numCh * 2, true); dv.setUint16(32, numCh * 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, len * numCh * 2, true);
  const chans = []; for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < numCh; c++) {
    const s = Math.max(-1, Math.min(1, chans[c][i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ============================================================
// 曲线导出（2026-09-15）
//   纯净模式 + 录屏导出已抽成 app/capture.mjs（2026-09-15「① 状态收敛」第二域）
// ============================================================

// ---- 通用下载 ----
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 纯净模式 / 录屏 / 画布内角标同步：已抽成 app/capture.mjs
//   （2026-09-15「① 状态收敛」第二域）。app 侧只剩三处接触点：
//   - configureCapture(...)  启动时注入跨域依赖
//   - bindCapture()          绑定本域全部事件
//   - capTick()              tick 每帧调（琴声桥接补挂 + 麦克风增益门）

// ---- 曲线导出 CSV ----
// 曲线 CSV 导出已下线（界面按钮「⭳ 曲线CSV」与 exportCurveCsv 一并删除；
// CSV 生成函数保留在 proj/exporters.mjs，capture 域与 test/exporters.mjs 仍在用 stampName 等）。

// ===== 控件接线 =====
function bindControls() {
  const bRec = el('btnRec'), bPP = el('btnPP'), bReplay = el('btnReplay'),
        bNew = el('btnNew'), bExport = el('btnExport'), bImport = el('btnImport'),
        fileIn = el('fileAudio'), seek = el('pSeek');
  if (bRec) bRec.addEventListener('click', () => {
    // 主按钮四态：●开始 → ⏸暂停 → ▶继续 → ●回到录音续录(试听态)
    if (recState === 'idle') startRecording();
    else if (recState === 'rec') pauseRecording();
    else if (recState === 'paused') resumeRecording();
    else resumeFromListen();             // listen
  });
  const bAud = el('btnAud'), bSave = el('btnSaveRec');
  if (bAud) bAud.addEventListener('click', () => {
    if (recState === 'listen') playerToggle();   // 试听中：播放/暂停
    else startListening();                        // rec/paused：进入试听
  });
  if (bSave) bSave.addEventListener('click', stopRecording);
  // 走带条：暂停=回拖查看；试听=拖动播放位置（45ms 节流，避免播放器高频重入）
  const recSeek = el('recSeek');
  if (recSeek) {
    recSeek.addEventListener('pointerdown', () => { recSeekDragging = true; });
    recSeek.addEventListener('input', () => {
      const frac = (recSeek.value - recSeek.min) / Math.max(1, recSeek.max - recSeek.min);
      if (recState === 'paused' && recFrames && recFrames.length) {
        recDragMs = Math.round(frac * recBaseT);
        try { renderTemplate(snapshot(), performance.now()); } catch (e) {}
        const c = el('recSeekT');
        if (c) c.textContent = fmtBar(recDragMs / 1000) + '/' + fmtBar(recBaseT / 1000);
      } else if (recState === 'listen' && pl.clip) {
        // 拖动即寻址（试听播放走 pl 引擎）；节流防高频 teardown/start
        const now = performance.now();
        if (now - lastRecSeekT >= 45) {
          lastRecSeekT = now;
          playerSeek(frac * pl.dur);
        }
        const c = el('recSeekT');
        if (c) c.textContent = fmtBar(frac * pl.dur) + '/' + fmtBar(pl.dur);
        // 没在播放时(试听完/暂停) RAF 已停：每动一下滑块就补画一帧，曲线才跟手
        if (!pl.playing) { try { renderTemplate(snapshot(), performance.now()); } catch (e) {} }
      }
    });
    const commit = () => {
      recSeekDragging = false;
      lastRecSeekT = 0;
    };
    recSeek.addEventListener('change', commit);
    recSeek.addEventListener('pointerup', commit);
    recSeek.addEventListener('keyup', commit);
  }
  if (bPP) bPP.addEventListener('click', playerToggle);
  if (bReplay) bReplay.addEventListener('click', playerReplay);
  // 倍速 + 「变调」：播放器视图与录音试听共用一份控件（#rateCluster），改了就地续播
  const rateSel = el('playRate');
  if (rateSel) rateSel.addEventListener('change', () => setPlayRate(parseFloat(rateSel.value)));
  const tapeCb = el('playTape');
  if (tapeCb) tapeCb.addEventListener('change', () => setPitchTape(!!tapeCb.checked));
  if (bNew) bNew.addEventListener('click', newSession);
  if (bExport) bExport.addEventListener('click', exportClip);
  const bRvc = el('btnRvc'), bRvcRe = el('btnRvcRestore');
  if (bRvc) bRvc.addEventListener('click', rvcConvert);
  if (bRvcRe) bRvcRe.addEventListener('click', rvcRestore);
  const rvcModelSel = el('rvcModel');
  if (rvcModelSel) rvcModelSel.addEventListener('change', rvcSyncIndex);
  if (bImport && fileIn) bImport.addEventListener('click', () => fileIn.click());
  if (fileIn) fileIn.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importAudio(f); e.target.value = ''; });
  const bImportMidi = el('btnImportMidi'), fileMidi = el('fileMidi');
  if (bImportMidi && fileMidi) bImportMidi.addEventListener('click', () => fileMidi.click());
  if (fileMidi) fileMidi.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importMIDI(f); e.target.value = ''; });
  if (seek) {
    seek.addEventListener('pointerdown', () => { seekDragging = true; });
    seek.addEventListener('input', () => {
      if (pl.clip) {
        const t = (seek.value / 1000) * pl.dur;
        const c = el('pCur');
        if (c) c.textContent = fmtBar(t);
        // 拖动即寻址：播放器走带条和录音机走带条一致——拖动时实时驱动曲线
        const now = performance.now();
        if (now - lastPlaySeekT >= 45) {
          lastPlaySeekT = now;
          playerSeek(t);
        }
        // 未在播放时 RAF 已停，每动一下滑块补画一帧曲线才跟手
        if (!pl.playing) { try { renderTemplate(snapshot(), performance.now()); } catch (e) {} }
      }
    });
    const commit = () => {
      if (seekDragging && pl.clip) { const t = (seek.value / 1000) * pl.dur; playerSeek(t); }
      seekDragging = false;
    };
    seek.addEventListener('change', commit);
    seek.addEventListener('pointerup', commit);
    seek.addEventListener('keyup', commit);
  }
  // 曲线导出 CSV 按钮已下线
  // 纯净模式 / 录屏：按钮 + 悬浮条 + document 级监听（pointer/Esc/全屏变化）全归 capture 域
  bindCapture();
  if (btnPermit) btnPermit.addEventListener('click', () => startRecording());
  // 「先不录音」(2026-09-19)：只收引导蒙层，不申请麦克风。
  // 实时视图有 idleLoop 兜底渲染，进来就是完整界面；
  // 之后点「● 开始录音」或「导入音频」随时可用，无需引导层再来一次。
  if (btnSkipPermit) btnSkipPermit.addEventListener('click', () => {
    overlay.classList.add('hidden');
    setView('live');
    setStatus('已进入（未开麦克风）。随时点「● 开始录音」开始，或「导入音频」直接分析');
    log.info('boot', '跳过引导蒙层（未申请麦克风）');
  });
}

// ===== 画布拖动：按住鼠标拖动 =====
// 交互约定(2026-09-11 定版)：
//   - 单击(无位移) = 播放/暂停切换
//   - 垂直主导拖动(|dy|>|dx|) = 纵轴平移：上下拖动查看窗口外(±1 八度)的音高曲线，任意状态可用
//   - 水平主导拖动 = 时间寻址(拉纸带式)：右拖=回退，左拖=前进，仅在有可拖时间轴时生效
//   - 灵敏度固定：拖满一个画布宽度 = 固定 SCRUB_WINDOW_MS(10s，约一屏)，与音频时长无关
// 仅在存在"可拖时间轴"时启用水平寻址：播放器视图(有片段)、录音机暂停/试听态。
const SCRUB_WINDOW_MS = 10000;   // 画布拖动的固定时间窗口：拖满画布 = 走 10 秒(一屏)，不随音频时长变
const SCRUB_TAP_DX = 6;         // 指针位移 < 6px 视为"单击"而非拖动
let canvasScrub = null;          // { c:活动画布, startX, startY, startT(基准时间s), t(当前时间s), vertical:null|bool, dragging }
let canvasScrubMode = null;      // 拖动寻址模式：'play'|'paused'|'listen'（null=仅垂直平移）
function canvasScrubX(e, c) {
  const r = c.getBoundingClientRect();
  if (!(r.width > 0)) return 0;
  return e.clientX - r.left;
}
function canvasScrubY(e, c) {
  const r = c.getBoundingClientRect();
  return e.clientY - r.top;
}
function canvasScrubStart(e) {
  // 水平寻址模式（可 null：rec 录音中无时间轴 → 仅允许垂直平移查看窗外曲线）
  if (appView === 'play' && pl.clip) canvasScrubMode = 'play';
  else if (appView === 'live' && recState === 'paused' && recBaseT > 0) canvasScrubMode = 'paused';
  else if (appView === 'live' && recState === 'listen' && pl.clip) canvasScrubMode = 'listen';
  else canvasScrubMode = null;
  const c = e.currentTarget;
  const startT = (canvasScrubMode === 'paused')
    ? ((recDragMs != null ? recDragMs : recBaseT) / 1000)
    : nowPosSec();
  canvasScrub = { c, startX: canvasScrubX(e, c), startY: canvasScrubY(e, c), lastY: canvasScrubY(e, c), startT, t: startT, vertical: null, freezeFollow: false, dragging: true, pointerId: e.pointerId, tpl: anim.current() };
  recSeekDragging = canvasScrubMode === 'paused' || canvasScrubMode === 'listen';
  seekDragging = canvasScrubMode === 'play';
  // 注意：此处不冻结 pitchTrail 自动跟随——只有判定为垂直拖动后才冻结；
  // 否则左右拖动(时间寻址)期间视角也被钉死，松开才弹回(2026-09-11)
  try { c.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
}
function canvasScrubT(e) {
  // 相对位移(拉纸带式)：向右拖(dx>0)=把波形往右拉=看到更早内容=时间回退；向左拖=时间前进。
  // 灵敏度固定：px→ms 比例 = SCRUB_WINDOW_MS/画布宽，与音频时长(dur)无关——长音频拖动也细腻。
  const c = canvasScrub.c, r = c.getBoundingClientRect();
  if (!(r.width > 0)) return canvasScrub.t;
  const dx = canvasScrubX(e, c) - canvasScrub.startX;
  const maxSec = (canvasScrubMode === 'paused') ? (recBaseT / 1000) : pl.dur;
  if (!(maxSec > 0)) return canvasScrub.startT;
  // 整画布宽 = 固定 SCRUB_WINDOW_MS 毫秒；位移方向取反(右拖=回退)
  const dSec = dx * (SCRUB_WINDOW_MS / 1000 / r.width);
  return Math.max(0, Math.min(maxSec, canvasScrub.startT - dSec));
}
function canvasScrubMove(e) {
  if (!canvasScrub || !canvasScrub.dragging) return;
  // 方向判定（只看一次位移方向，之后不再翻转）
  if (canvasScrub.vertical === null) {
    const dx = canvasScrubX(e, canvasScrub.c) - canvasScrub.startX;
    const dy = canvasScrubY(e, canvasScrub.c) - canvasScrub.startY;
    canvasScrub.vertical = Math.abs(dy) > Math.abs(dx);
    if (canvasScrub.vertical && !canvasScrub.freezeFollow && canvasScrub.tpl
        && typeof canvasScrub.tpl.setUserPanning === 'function') {
      canvasScrub.freezeFollow = true;
      canvasScrub.tpl.setUserPanning(true);   // 确认垂直拖动才冻结自动跟随
    }
  }
  if (canvasScrub.vertical) {
    // 增量位移：每帧用"本次相对上次"的 dy，方向实时跟随手（上下反复都有反应）
    const yNow = canvasScrubY(e, canvasScrub.c);
    const dY = yNow - canvasScrub.lastY;
    canvasScrub.lastY = yNow;
    const tpl = canvasScrub.tpl;
    if (tpl && typeof tpl.panY === 'function') tpl.panY(dY);
    // 平移后补一帧让窗口立刻生效(RAF 停着时)；RAF 运行时每帧也会重绘
    if (!(running || (playInfo && playInfo.on))) {
      try { renderTemplate(snapshot(), performance.now()); } catch (err) {}
    }
    return;
  }
  // —— 水平寻址 ——
  if (canvasScrubMode === null) return;
  canvasScrub.t = canvasScrubT(e);
  const t = canvasScrub.t;
  if (canvasScrubMode === 'play') {
    const c = el('pCur'); if (c) c.textContent = fmtBar(t);
    const bar = el('pSeek'); if (bar) bar.value = Math.round((pl.dur ? t / pl.dur : 0) * 1000);
    const now = performance.now();
    if (now - lastPlaySeekT >= 45) { lastPlaySeekT = now; playerSeek(t); }
    if (!pl.playing) { try { renderTemplate(snapshot(), performance.now()); } catch (e) {} }
  } else if (canvasScrubMode === 'paused') {
    recDragMs = Math.round(t * 1000);
    const bar = el('recSeek'); if (bar) bar.value = Math.round((recBaseT ? t * 1000 / recBaseT : 0) * 1000);
    try { renderTemplate(snapshot(), performance.now()); } catch (e) {}
    const c = el('recSeekT');
    if (c) c.textContent = fmtBar(recDragMs / 1000) + '/' + fmtBar(recBaseT / 1000);
  } else if (canvasScrubMode === 'listen') {
    const c = el('recSeekT');
    if (c) c.textContent = fmtBar(t) + '/' + fmtBar(pl.dur);
    const bar = el('recSeek'); if (bar) bar.value = Math.round((pl.dur ? t / pl.dur : 0) * 1000);
    const now = performance.now();
    if (now - lastRecSeekT >= 45) { lastRecSeekT = now; playerSeek(t); }
    if (!pl.playing) { try { renderTemplate(snapshot(), performance.now()); } catch (e) {} }
  }
}
function canvasScrubEnd(e) {
  if (!canvasScrub || !canvasScrub.dragging) return;
  canvasScrub.dragging = false;
  const moved = Math.max(
    Math.abs(canvasScrubX(e, canvasScrub.c) - canvasScrub.startX),
    Math.abs(canvasScrubY(e, canvasScrub.c) - canvasScrub.startY)
  ) > SCRUB_TAP_DX;
  if (!moved) {
    canvasScrubTap();
  } else if (canvasScrub.vertical) {
    // 垂直平移结束：无需落定播放位置；自动跟随在 setUserPanning(false) 后恢复
  } else {
    const t = canvasScrub.t;
    if (canvasScrubMode === 'play' && pl.clip) playerSeek(t);   // 落定最终位置
  }
  recSeekDragging = false;
  seekDragging = false;
  if (canvasScrub.freezeFollow && canvasScrub.tpl && typeof canvasScrub.tpl.setUserPanning === 'function') {
    canvasScrub.tpl.setUserPanning(false);   // 仅垂直拖动冻结过才恢复
  }
  try { canvasScrub.c.releasePointerCapture(canvasScrub.pointerId); } catch (err) {}
  canvasScrub = null;
  canvasScrubMode = null;
}
// 单击画布 = 播放/暂停切换（播放器回放 / 试听回放共用；暂停态则开始试听）
function canvasScrubTap() {
  if (recState === 'listen' && pl.clip) { playerToggle(); return; }
  if (appView === 'play' && pl.clip) { playerToggle(); return; }
  if (recState === 'paused') {
    // 暂停态一律走 startListening(与"试听"按钮同行为)：
    // 它内部 buildRecClip 按 pcmLen 判缓存过期并重建→再录的新音频也能播；
    // 不能 playerToggle 残留的旧 pl.clip(第一次试听后未重建设，播的会是旧段)
    startListening();
    return;
  }
}
// 只绑 2D 画布：音高轨迹等曲线图才有"时间轴拖动"语义；GL 模板(钢琴3D等)拖动是视角旋转，不能抢
if (canvas) {
  canvas.addEventListener('pointerdown', canvasScrubStart);
  canvas.addEventListener('pointermove', canvasScrubMove);
  canvas.addEventListener('pointerup', canvasScrubEnd);
  canvas.addEventListener('pointercancel', canvasScrubEnd);
}

// 灵敏度滑杆
const sensSlider = document.querySelector('#sensSlider');
if (sensSlider) {
  sensSlider.addEventListener('input', () => applySens(sensSlider.value));
  // 松手才重算：input 期间只管实时检测器（高频），change 时才动已分析工程
  sensSlider.addEventListener('change', () => reanalyzeIfProject('灵敏度'));
  sensSlider.value = SENS.val;
}
applySens(SENS.val);

// 收音门槛：手动滑杆 / 「自动」勾选 / 「校准底噪」按钮
const dbSlider = document.querySelector('#dbSlider');
if (dbSlider) dbSlider.addEventListener('input', () => applyDb(dbSlider.value, true));
if (dbSlider) dbSlider.addEventListener('change', () => reanalyzeIfProject('收音门'));
const autoDb = document.querySelector('#autoDb');
if (autoDb) autoDb.addEventListener('change', () => {
  const beforeEff = gateEffDb();              // 只有"生效门槛真的变了"才值得重算
  GATE.auto = autoDb.checked;
  log.info('gate', GATE.auto ? '收音门切到自动（跟随底噪）' : '收音门切到手动', { db: GATE.db });
  try { localStorage.setItem('ydyi_gate', JSON.stringify({ auto: GATE.auto, db: GATE.db })); } catch (e) {}
  if (GATE.auto && !(envBase > 1e-5)) onManualCalib(); else syncGateUI();
  if (Math.abs(gateEffDb() - beforeEff) > 0.01) reanalyzeIfProject('收音门 自动/手动');
});
const btnCalib = document.querySelector('#btnCalib');
if (btnCalib) btnCalib.addEventListener('click', onManualCalib);

// 原音频播放音量(钢琴块"钢琴声"模式对照听用)已搬到 app/audio.mjs：
// origPlayVol 只读导出（滑杆初始化读它），改写走 setOrigPlayVol（改值+落盘+同步 gain）。
// 恢复上次的收音门槛设置（自动/手动 + 手动分贝值）
try {
  const saved = JSON.parse(localStorage.getItem('ydyi_gate') || 'null');
  if (saved && typeof saved.auto === 'boolean') { GATE.auto = saved.auto; GATE.db = Math.max(20, Math.min(70, Math.round(saved.db) || 40)); }
} catch (e) {}
syncGateUI();

// ===== 全局次级控件：原声（原始音频播放音量）=====
// 2026-09-16 从「钢琴块面板」搬出来：它改的是 app/audio.mjs 的 playOutNode.gain，
// 那是**所有播放（工程回放 / 试听）的总输出**，与模板无关；只建在钢琴块模板的
// 工具条面板里出现 → 在钢琴块里把它拉到 0（静音）后切到音高轨迹/频谱，播放全程没声音
// 且界面上找不到任何音量控件（值还落盘持久化），是典型的"选项作用域错配"。
// 现在与「检测/灵敏/收音」同簇常驻，任何时候都看得到当前值。
function buildGlobalControls() {
  const host = document.querySelector('.side-cluster');
  if (!host) return;
  const ov = document.createElement('label');
  ov.className = 'auto';
  ov.title = '原音频播放音量（全局生效）：调小或静音，以便听清钢琴自动弹奏';
  // 用 textContent 而不是 createTextNode：本函数在**启动路径**上，
  // 而 smoke/cap-record 那两个极简 document 桩没实现 createTextNode（它们不是自建就是子集），
  // 启动路径上多用一个 DOM API 就会把整条测试链弄红。同理也别在这里加新 API。
  ov.textContent = '原声 ';
  const vs = document.createElement('input');
  vs.type = 'range'; vs.min = '0'; vs.max = '100'; vs.step = '1';
  vs.style.cssText = 'width:72px;accent-color:var(--accent)';
  const vlab = document.createElement('span');
  vlab.className = 'sval';
  const updVol = () => {
    const pct = +vs.value;
    vlab.textContent = pct === 0 ? '静音' : pct + '%';
    setOrigPlayVol(pct / 100);          // 改值+落盘+同步 gain，一个入口（audio 域）
  };
  vs.value = String(Math.round(origPlayVol * 100));   // origPlayVol 已在 audio 域从 localStorage 恢复
  vs.addEventListener('input', updVol);
  ov.appendChild(vs); ov.appendChild(vlab);
  const anchor = el('btnImport');
  if (anchor) host.insertBefore(ov, anchor); else host.appendChild(ov);
  updVol();

  // 「存MIDI」/「AI转谱」（2026-09-19 从钢琴块模板面板搬来）：按钮本体在 index.html
  // #playCtrls 里（导出音频旁），这里只接线。它们操作的是**当前工程**（导出音符 /
  // 音频转音符），与动画模板无关 → 属主界面。AI转谱显隐由 syncAnimBarDeps 按工程补刷。
  // ⚠ 本函数在启动路径上：只用 textContent/addEventListener，别用 createTextNode（极简桩没有）。
  const smBtn = el('btnSaveMidi');
  if (smBtn) smBtn.addEventListener('click', exportProjectMidi);
  const aiBtnG = el('btnAiTrans');
  if (aiBtnG) {
    aiBtnG.addEventListener('click', aiTranscribe);
    animAiBtn = aiBtnG;               // 显隐唯一实现仍在 syncAnimBarDeps
  }
}

// ===== 动画模板工具条（含"随工程变化"的控件显隐）=====
// 面板只在切模板/启动时重建（refreshAnimBar），而 curProject 是随时会变的
// （录音完成/导入/开存档/新建都不会重建面板）→ 凡"取决于当前工程"的控件，
// 必须由工程变化的那条路径（projSetCurrentUI）回调 syncAnimBarDeps 补刷，
// 否则会出现"对静音时间轴的 MIDI 工程点 AI转谱"，或反向的"该有的按钮不见了"。
let animAiBtn = null;                 // 「AI转谱」按钮（2026-09-19 起在主界面 #playCtrls，随工程显隐）
let animEchoLbl = null;               // 钢琴块面板的「回声」勾选（录音中才显示，见下）
let animFallLbl = null;               // 钢琴块面板的「落速」滑杆（同上）
/** 当前是否有"可转谱的真实音频"：MIDI 工程 / 无音频存档的 buffer 是静音时间轴，转谱必然无结果 */
function hasTranscribableAudio() {
  return !!(curProject && curProject.bufferRef && !curProject.isMidi
    && curClip && !curClip.silent);
}
function syncAnimBarDeps() {
  if (animAiBtn) animAiBtn.style.display = hasTranscribableAudio() ? '' : 'none';
  // 回声/落速只对"正在录音"有意义（echoFeed 的注入守卫就是 recState==='rec'）：
  // 暂停/试听/回放时亮着纯属误导（2026-09-19）。updateTransportUI 在每次
  // 录音态变化时都会跑 → 录音开始/停止时这两件控件会跟着出现/收起。
  const recNow = recState === 'rec';
  if (animEchoLbl) animEchoLbl.style.display = recNow ? '' : 'none';
  if (animFallLbl) animFallLbl.style.display = recNow ? '' : 'none';
}
function refreshAnimBar() {
  const bar = el('animBar');
  if (!bar) return;
  bar.innerHTML = '';
  const cur = anim.current();
  for (const t of anim.list()) {
    const b = document.createElement('button');
    b.className = 'anim-btn' + (cur && cur.id === t.id ? ' active' : '');
    b.textContent = t.name;
    b.addEventListener('click', () => switchTemplate(t.id));
    bar.appendChild(b);
  }
  // 钢琴块专属面板：琴声(音量/音色)/出块算法/曲库/导调试/诊断 + 录音中的回声/落速
  // (面板构建若抛异常，绝不能连模板按钮一起陪葬——捕获并亮状态栏)
  try {
  if (cur && cur.id === 'pianoBlocks') {
    // 琴声开关勾选框（2026-09-19 删除）：这一栏本身就叫"钢琴块"，进了这个
    // 面板落键出声天经地义，故不单独设"钢琴声"开关；要静音把下面「琴声」音量拉到 0。
    // 面板每次重建都把引擎置为可用（存量设置里"关过琴声"的也一并唤醒）。
    if (cur.setSoundEnabled) cur.setSoundEnabled(true);

    // 出块算法(2026-09-15 四档 → 2026-09-19 收敛两档 → 同日新增 HMM 档)：
    // 颗粒=谷切精细分块(默认)；经典=纯音高(最初算法，快吐同音连一块)；
    // HMM序列=序列级最优解码(整段 Viterbi，起止与音高联合决定)。**只作用于录音回声**：
    // 钢琴块自身分段与 MIDI/转谱工程仍走颗粒行为（'hmm' 只在 echo 域分岔）。
    const bsl = document.createElement('label');
    bsl.className = 'auto';
    bsl.title = '出块算法：颗粒=谷切精细分块(快吐每音成块,可能有碎块)；' +
      '经典=纯音高分段(最初算法,快吐同音连一块)；' +
      'HMM序列=序列级最优解码(回声专用：颤音不碎块、尾音不多切，代价是完整块出现略晚)。MIDI/转谱工程不经此算法';
    const bsSel = document.createElement('select');
    for (const [val, label] of [['grain', '颗粒'], ['classic', '经典'], ['hmm', 'HMM序列']]) {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      bsSel.appendChild(opt);
    }
    try {
      const saved = localStorage.getItem('ydyi_block_algo');
      // 未知档位值一律回退颗粒（旧键 ydyi_osc_merge 已不读取）
      bsSel.value = ['grain', 'classic', 'hmm'].includes(saved) ? saved : 'grain';
    } catch (e) {}
    bsSel.addEventListener('change', () => { if (cur.setBlockAlgo) cur.setBlockAlgo(bsSel.value); });
    bsl.appendChild(document.createTextNode('出块'));
    bsl.appendChild(bsSel);
    bar.appendChild(bsl);
    if (cur.setBlockAlgo) cur.setBlockAlgo(bsSel.value);   // 按存档初始化档位

    // 特效品质三档（2026-09-20，性能亲民化）：低=只琴键点亮；中=珠链+命中+泛光(无粒子)；
    // 高=全开(默认)。烟/火花是大尺寸精灵 overdraw 大户，核显/集显可降档。
    const fxl = document.createElement('label');
    fxl.className = 'auto';
    fxl.title = '特效档位：高=烟+火花+珠链+泛光全开；中=珠链与命中特效(无烟/火花)；' +
      '低=只琴键点亮(性能最省)';
    const fxSel = document.createElement('select');
    for (const [val, label] of [['high', '高'], ['mid', '中'], ['low', '低']]) {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      fxSel.appendChild(opt);
    }
    try {
      const savedFx = localStorage.getItem('ydyi_fx_quality');
      fxSel.value = ['high', 'mid', 'low'].includes(savedFx) ? savedFx : 'high';
    } catch (e) {}
    fxSel.addEventListener('change', () => {
      try { localStorage.setItem('ydyi_fx_quality', fxSel.value); } catch (e) {}
      if (cur.setFxQuality) cur.setFxQuality(fxSel.value);
    });
    fxl.appendChild(document.createTextNode('特效'));
    fxl.appendChild(fxSel);
    bar.appendChild(fxl);
    if (cur.setFxQuality) cur.setFxQuality(fxSel.value);   // 按存档初始化档位

    // 「存MIDI」/「AI转谱」（2026-09-19 已搬主界面 #playCtrls，见 buildGlobalControls）：
    // 它们操作的是**当前工程**，与选了哪个动画模板无关——藏在钢琴块面板里的话，
    // 切到音高轨迹/频谱就找不到入口，是典型的"选项作用域错配"（与「原声」同病）。
    // AI转谱的显隐仍由 syncAnimBarDeps 按工程补刷，只是按钮换了住处。

    // 导调试：导出实时管线黑匣子(帧级追踪/采样点/冻结音符)——离线验尸实时 bug
    const dbgBtn = document.createElement('button');
    dbgBtn.className = 'btn-mini';
    dbgBtn.textContent = '导调试';
    dbgBtn.title = '导出录音时实时管线的内部状态(帧级追踪+采样点+冻结音符)为 JSON，供排查实时块问题';
    dbgBtn.addEventListener('click', () => {
      if (!cur.__dbgDump) { setStatus('当前模板无调试导出'); return; }
      const dump = cur.__dbgDump();
      const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'live-debug.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      setStatus('✓ 已导出 live-debug.json（轨迹 ' + dump.trace.length + ' 帧 · 采样点 ' + dump.hist.length + '）');
    });
    bar.appendChild(dbgBtn);

    // 诊断：当前工程跑一遍分段管线，帧数→块数亮到状态栏
    // (区分"数据层没切分"与"显示层问题"——避免黑箱排查)
    const diag = document.createElement('button');
    diag.className = 'btn-mini';
    diag.textContent = '诊断';
    diag.title = '统计当前工程的分段管线：发声帧数→切分块数→最长块时长';
    diag.addEventListener('click', () => {
      if (!curProject) { setStatus('诊断：无工程'); return; }
      if (curProject.midiNotes) { setStatus(`诊断：音符事件工程，${curProject.midiNotes.length} 个音符直供(不经分段)`); return; }
      if (!curProject.analysis || !curProject.analysis.frames) { setStatus('诊断：工程无分析帧'); return; }
      const pts = curProject.analysis.frames
        .filter(f => f.voiced !== false && Number.isFinite(f.freq) && f.freq > 0)
        .map(f => ({ t: f.t, f: f.freq, rms: f.rms, prom: f.prom, purity: f.purity }));
      if (!pts.length) { setStatus('诊断：无发声帧'); return; }
      const notes = segmentPoints(pts, curProject.env);
      const longest = notes.reduce((m, n) => Math.max(m, n.t1 - n.t0), 0);
      const shortCnt = notes.filter(n => n.t1 - n.t0 < 150).length;
      setStatus(`诊断: 发声帧 ${pts.length} → 块 ${notes.length} 个 · 最长块 ${Math.round(longest)}ms · 短块(<150ms) ${shortCnt} 个`);
    });
    bar.appendChild(diag);

    // 琴声音量(0-150%，钢琴声主增益)
    const pv = document.createElement('label');
    pv.className = 'auto';
    pv.title = '钢琴声音量';
    pv.appendChild(document.createTextNode(' 琴声'));
    const ps = document.createElement('input');
    ps.type = 'range'; ps.min = '0'; ps.max = '150'; ps.step = '5';
    let pvol = 0.9;
    try { const pv0 = parseFloat(localStorage.getItem('ydyi_piano_vol')); if (Number.isFinite(pv0)) pvol = pv0; } catch (e) {}
    ps.value = String(Math.round(pvol * 100));
    const plab = document.createElement('span');
    const updPV = () => {
      const pct = +ps.value;
      plab.textContent = pct === 0 ? '静音' : pct + '%';
      if (cur.setPianoVolume) cur.setPianoVolume(pct / 100);
    };
    ps.addEventListener('input', updPV);
    updPV();
    pv.appendChild(ps);
    pv.appendChild(plab);
    bar.appendChild(pv);

    // 音色（声源多元化，2026-09-13）：下拉单选。采样型首次选中才从 CDN 加载该音色
    // (~20-30 张 mp3)，切回已加载过的音色零等待；「内置合成器」不联网。
    // 引擎在 anim/piano-sound.mjs，选择存 localStorage 'ydyi_piano_timbre'。
    if (cur.listTimbres) {
      const ttip = '琴声音色（声源）。采样型首次选择时才联网加载；切回已加载过的音色零等待；「内置合成器」不联网。';
      const tl = document.createElement('label');
      tl.className = 'auto';
      tl.title = ttip;
      tl.appendChild(document.createTextNode(' 音色'));
      const ts = document.createElement('select');
      ts.title = ttip;
      // animBar 不在 .recbar 内，取不到那条 select 样式 → 就地复制同一套观感
      ts.style.cssText = 'background:var(--surface);color:var(--ink);border:1px solid var(--hair);'
        + 'padding:4px 6px;border-radius:5px;font-size:12px;outline:none;max-width:190px';
      let lastGroup = null, og = null;
      for (const t of cur.listTimbres()) {
        if (t.group !== lastGroup) {
          lastGroup = t.group;
          og = document.createElement('optgroup'); og.label = t.group; ts.appendChild(og);
        }
        const o = document.createElement('option'); o.value = t.id; o.textContent = t.label;
        (og || ts).appendChild(o);
      }
      ts.value = cur.getTimbre ? cur.getTimbre() : 'salamander';
      ts.addEventListener('change', () => {
        if (cur.setTimbre) cur.setTimbre(ts.value);
        // 琴声恒开（2026-09-19 删开关）：换音色必然立刻能听到，无需再补开
      });
      tl.appendChild(ts);
      bar.appendChild(tl);
    }

    // 曲库（2026-09-13）：内置 demo/ 东方名曲 + 可浏览本地 MIDI 文件夹（如东方 MIDI 合集）
    // 点一首 → 走既有 importMIDI 管线（自动切钢琴块+开琴声），配「音色」下拉换声源
    const libBtn = document.createElement('button');
    libBtn.className = 'btn-mini';
    libBtn.textContent = '曲库';
    libBtn.title = '曲库=我的歌单：收藏（☆）与自建分组（像内置的东方/古典那样）都在这里；'
      + '也可打开本地 MIDI 文件夹。点一首即钢琴块自动弹奏，「音色」下拉可换声源。';
    libBtn.addEventListener('click', () => toggleLibPanel());
    bar.appendChild(libBtn);

    // 回声模式：吹一个音，检测到即从屏幕顶生成对应下落块，落到键盘线弹同音高钢琴声
    // (观感与工程回放下落块完全一致；出声走钢琴块原生"落键弹奏")。
    // 只在**录音中**显示（2026-09-19）：暂停/试听/回放时它不起任何作用
    // （echoFeed 注入守卫就是 recState==='rec'），亮着纯属误导；显隐补刷在 syncAnimBarDeps。
    const ecl = document.createElement('label');
    ecl.className = 'auto';
    ecl.title = '录音时吹一个音，实时从屏幕顶落下对应钢琴块，落到键盘线那一刻弹出同音高钢琴声。建议戴耳机：外放钢琴声可能被麦克风拾入造成误检';
    const echoCb = document.createElement('input');
    echoCb.type = 'checkbox';
    echoCb.checked = echoOn;      // 单一真相源：面板读域模块的状态，不再自己读 localStorage
    echoCb.addEventListener('change', () => setEchoEnabled(echoCb.checked));
    ecl.appendChild(echoCb);
    ecl.appendChild(document.createTextNode(' 回声'));
    bar.appendChild(ecl);
    animEchoLbl = ecl;

    // 落速：块从出现到落到键盘线的时长(=吹响到钢琴声落下的延迟)，自由可调
    const fsl = document.createElement('label');
    fsl.className = 'sens';
    fsl.title = '回声延迟=块下落时长。4200ms 时块正好从屏幕顶出现(与工程回放下落同速)；调小则块从半空出现、更早听到钢琴声；范围 0.3–8 秒';
    fsl.appendChild(Object.assign(document.createElement('span'), { className: 'slab', textContent: '落速' }));
    const fsr = document.createElement('input');
    fsr.type = 'range'; fsr.min = '300'; fsr.max = '8000'; fsr.step = '100';
    fsr.value = String(echoFallMs);
    const flab = document.createElement('span');
    const updFall = () => { flab.textContent = (echoFallMs / 1000).toFixed(1) + 's'; };
    fsr.addEventListener('input', () => { setEchoFall(+fsr.value); updFall(); });
    updFall();
    fsl.appendChild(fsr);
    fsl.appendChild(flab);
    bar.appendChild(fsl);
    animFallLbl = fsl;              // 与「回声」同口径：录音中才显示（syncAnimBarDeps 补刷）
    // 面板建好即按当前录音态/工程校一遍显隐（回声/落速 + 主界面的 AI转谱）
    syncAnimBarDeps();

    // ⚠「原声」（原始音频播放音量）是全局控件，见 buildGlobalControls。
    // 原因：它改的是 playOutNode.gain，也就是【所有播放】的总音量，不是钢琴块专属；
    // 藏在模板面板里会导致"在钢琴块里拉成静音 → 切别的模板后播放全哑、且无处可调"。
  }
  // 音高轨迹专属面板：趋势/画线聚合/曲线样式/淡连/端点圆点
  // 这些设置只对音高曲线有意义，故只在本模板选中时出现在工具条
  if (cur && cur.id === 'pitchTrail') {
    // 趋势折线
    const tr = document.createElement('label');
    tr.className = 'auto';
    tr.title = '在音高轨迹下方显示浅色趋势折线(音高走向简化图)';
    const trc = document.createElement('input');
    trc.type = 'checkbox';
    try { trc.checked = localStorage.getItem('ydyi_trend') !== '0'; } catch (e) {}
    trc.addEventListener('change', () => { if (cur.setTrendEnabled) cur.setTrendEnabled(trc.checked); });
    tr.appendChild(trc);
    tr.appendChild(document.createTextNode(' 趋势'));
    bar.appendChild(tr);
    // 画线聚合
    const ag = document.createElement('label');
    ag.className = 'sens';
    ag.title = '曲线显示聚合：把一段时间内的帧压缩成一个代表点(组内中位数)，噪点越聚越少';
    ag.appendChild(Object.assign(document.createElement('span'), { className: 'slab', textContent: '画线' }));
    const ags = document.createElement('select');
    ags.className = 'kernsel';
    for (const [v, t] of [[0, '逐帧(原始)'], [60, '60ms(≈3帧)'], [125, '125ms(≈5帧)'], [250, '250ms(≈11帧)'], [500, '500ms(半秒)'], [1000, '1秒(最净)']]) {
      const o = document.createElement('option'); o.value = String(v); o.textContent = t; ags.appendChild(o);
    }
    try { const v = parseInt(localStorage.getItem('ydyi_agg') || '0', 10); ags.value = String(v > 0 ? v : 0); } catch (e) {}
    ags.addEventListener('change', () => { if (cur.setAggMode) cur.setAggMode(parseInt(ags.value, 10) || 0); });
    ag.appendChild(ags);
    bar.appendChild(ag);
    // 曲线样式：经典（存量档）+ 废案（2026-09-20 新增）
    const st = document.createElement('label');
    st.className = 'sens';
    st.title = '曲线样式：经典=亮青发丝曲线+白芯；废案=荧光绿粗实线';
    st.appendChild(Object.assign(document.createElement('span'), { className: 'slab', textContent: '样式' }));
    const sts = document.createElement('select');
    sts.className = 'kernsel';
    const stOpts = [['classic', '经典'], ['feian', '废案']];
    for (const [v, t] of stOpts) { const o = document.createElement('option'); o.value = v; o.textContent = t; sts.appendChild(o); }
    // 老值（accuracy/neon/particles/depth）已废除 → 一律显示 classic（模板侧同样回落）
    try { const s = localStorage.getItem('ydyi_trail_style'); sts.value = stOpts.some(([v]) => v === s) ? s : 'classic'; } catch (e) {}
    sts.addEventListener('change', () => { if (cur.setStyle) cur.setStyle(sts.value); syncStyleDeps(); });
    st.appendChild(sts);
    bar.appendChild(st);
    // 曲线平滑（One Euro Filter）：抹掉逐帧检测抖动，同时不拖延迟、不吃真颤音。始终显示。
    const sm = document.createElement('label');
    sm.className = 'auto';
    sm.title = '曲线平滑（One Euro Filter）：抹平逐帧检测抖动；慢速长音强滤、快颤音几乎不滤，所以不会拖慢响应';
    const smc = document.createElement('input');
    smc.type = 'checkbox';
    try { smc.checked = localStorage.getItem('ydyi_trail_smooth') !== '0'; } catch (e) {}
    smc.addEventListener('change', () => { if (cur.setSmooth) cur.setSmooth(smc.checked); });
    sm.appendChild(smc);
    sm.appendChild(document.createTextNode(' 平滑'));
    bar.appendChild(sm);
    // 视觉特效（trailFx，仅废案样式生效）：彗星头/起音涟漪/转音火花/律动背景
    // 串档修复（2026-09-22）：这 10 个勾选框只对废案档有行为，此前是无条件构建，
    // 选「经典」时照样显示（勾了也没效果）→ 收进 styleDeps，随样式下拉显隐。
    const styleDeps = [];
    for (const [k, label, tip] of [
      ['head', '彗星头', '当前演唱点叠多层光晕（仅废案样式生效）'],
      ['ripple', '涟漪', '发声时从当前演唱点节拍式泛出涟漪环（仅废案样式生效）'],
      ['spark', '火花', '发声时当前点持续溅出火星，快速转音时加量（仅废案样式生效）'],
      ['bars', '律动背景', '曲线后方随音量起伏的淡色能量柱（仅废案样式生效）'],
    ]) {
      const fx = document.createElement('label');
      fx.className = 'auto';
      fx.title = tip;
      const fxc = document.createElement('input');
      fxc.type = 'checkbox';
      try { fxc.checked = localStorage.getItem('ydyi_fx_' + k) !== '0'; } catch (e) {}
      fxc.addEventListener('change', () => { if (cur.setFx) cur.setFx(k, fxc.checked); });
      fx.appendChild(fxc);
      fx.appendChild(document.createTextNode(' ' + label));
      bar.appendChild(fx);
      styleDeps.push(fx);
    }
    // 曲线本体渲染开关（仅废案样式；默认全关 = 废案一比一观感，ydyi_fa_* 持久化）
    for (const [k, label, tip] of [
      ['ribbon', '色带', '曲线下缘垫渐隐面积，实体感最强（仅废案样式）'],
      ['glow', '辉光', '曲线外圈柔光晕（仅废案样式）'],
      ['breath', '呼吸', '线宽随音量粗细起伏 0.75~1.35×（仅废案样式）'],
      ['shadow', '落影', '曲线下方软投影，浮起立体感（仅废案样式）'],
      ['smooth', '废案平滑', '废案档也喂 One Euro 平滑（原版为逐帧原始值，默认关）'],
      ['hue', '八度色相', '不同八度绿得不一样，实验性（仅废案样式）'],
    ]) {
      const zb = document.createElement('label');
      zb.className = 'auto';
      zb.title = tip;
      const zbc = document.createElement('input');
      zbc.type = 'checkbox';
      try { zbc.checked = localStorage.getItem('ydyi_fa_' + k) === '1'; } catch (e) {}
      zbc.addEventListener('change', () => { if (cur.setFaBody) cur.setFaBody(k, zbc.checked); });
      zb.appendChild(zbc);
      zb.appendChild(document.createTextNode(' ' + label));
      bar.appendChild(zb);
      styleDeps.push(zb);
    }
    // 仅废案样式显示：面板构建时先按当前样式收一次，切样式时由 sts 的 change 监听补刷
    function syncStyleDeps() {
      const on = sts.value === 'feian';
      for (const e of styleDeps) e.style.display = on ? '' : 'none';
    }
    syncStyleDeps();
  }
  } catch (e) { console.error('animBar 面板构建失败:', e); try { setStatus('⚠ 动画面板构建失败：' + (e.message || e)); } catch (e2) {} }
}

window.addEventListener('resize', applyResize);

// ============================================================
// 工程存档 UI（对标同类应用 .zcp 存档列表）
// ============================================================
function projStatusEl() { return el('projStatus'); }

// 刷新状态行：分析中 / 就绪(帧数+音域) / MIDI(音符数) / 实时
function projSetCurrentUI() {
  // 工程一变，动画面板里"依赖工程"的控件也得跟着变（面板本身不会重建）——唯一补刷点
  syncAnimBarDeps();
  // 「存当前」的可用性同理：面板开着时工程"从无变有/从有变无"，按钮必须跟着变。
  // 只在 projTogglePanel 打开面板那一刻刷一次的话 → 面板开着时录完一段，按钮还是灰的。
  projSyncSaveCurBtn();
  const st = projStatusEl();
  if (!st) return;
  if (analyzing) {
    st.textContent = '⚙ 正在分析整段音高…';
    st.className = 'busy';
    return;
  }
  // MIDI 工程没有 analysis（只有音符表），旧判断会让状态栏一直空着，
  // 看着像"工程没就绪、存不了档"——单独一档显示。
  // ⚠ 判据不能用"有 midiNotes"：音频工程做过 AI 转谱后也会挂 midiNotes，那时它仍是
  //   音频工程（有帧、有曲线），显示成"MIDI 工程"会误导（2026-09-16 修）。
  const isMidiProj = !!(curProject && (curProject.isMidi || curProject.kind === proj.KIND_MIDI));
  if (isMidiProj && curProject.midiNotes && curProject.midiNotes.length) {
    st.textContent = 'MIDI 工程 · ' + curProject.midiNotes.length + ' 个音符';
    st.className = '';
    return;
  }
  if (curProject && curProject.analysis) {
    const a = curProject.analysis;
    const n = (a.frames || []).length;
    const s = a.stats || {};
    const rng = (s.minHz && s.maxHz) ? ` · ${fmtNote(s.minHz)}–${fmtNote(s.maxHz)}` : '';
    // 音频工程转谱后仍是音频工程：帧+音域照常显示，转谱结果只作后缀提示
    const tr = (curProject.midiNotes && curProject.midiNotes.length)
      ? ` · 已转谱 ${curProject.midiNotes.length} 音符` : '';
    st.textContent = `工程就绪 · ${n} 帧${rng}${tr}`;
    st.className = '';
  } else {
    st.textContent = '';
    st.className = '';
  }
}

// projPanelVisible / projTogglePanel / projSyncSaveCurBtn / projRefreshList /
// projRefreshTabs / projRow / projRefreshFoot / projTabOf / fmtAgo
// 已搬到 app/proj-panel.mjs（2026-09-15「① 状态收敛」第六域）——面板只读 curProject，
// 通过 getProject() 拿，不从 app.mjs 反向依赖。
function projEmptyClip(duration) {
  // 打开"纯分析存档"(无音频)时给一个静音 clip：能驱动播放时间轴/查表画曲线，不出声
  // (isProjPlayback 现在按 bufferRef 绑定判断，有音频/无音频统一走工程查表)
  // silent=true：这个 buffer 是静音时间轴，不是真实音频 —— 「变声」「导出」等
  // 需要真实声音的控件据此隐藏/置灰（2026-09-16）。
  if (!audioCtx) initAudio();   // 首次就开存档(没点过录音)也可能走到这里，需先有 ctx
  const buf = audioCtx.createBuffer(1, Math.max(1, Math.floor(duration * audioCtx.sampleRate)), audioCtx.sampleRate);
  return { name: '(无音频 · 仅曲线)', buffer: buf, blob: null, silent: true };
}

// 存档存储（2026-09-19 定版）：真相源 = 工作目录 archives/ 文件夹，
// 存档只落在服务端文件里；浏览器 IndexedDB 中的旧数据由 file-store.migrateFromIdb 在启动时一次性迁出并删库。
configureFileStore({ log });

// 存当前工程(命名后可存为 .ydyi 存档)
function projSaveCurrent() {
  const kind = curProject ? proj.inferKind(curProject) : null;
  const hasNotes = !!(curProject && curProject.midiNotes && curProject.midiNotes.length);
  const hasFrames = !!(curProject && curProject.analysis && curProject.analysis.frames && curProject.analysis.frames.length);
  if (!curProject || (!hasNotes && !hasFrames)) {
    // MIDI 工程没有 analysis.frames（只有音符表）——旧判断把它一并拒了，
    // 表现为"导入了 MIDI 却存不了档"。这里按 kind 分派。
    setStatus('当前没有可存的工程。请先播放/导入一段音频或 MIDI。');
    return;
  }
  const cur = curProject;
  const nm = prompt('存档名称：', cur.auto ? cur.name : cur.name || (kind === proj.KIND_MIDI ? 'MIDI' : '我的工程'));
  if (nm === null) return;
  // 来源跟随当前工程（2026-09-14 口径）：正在看的是录音就存成「录音」，
  // 是导入音频就存成「导入音频」。手动存档只是"再存一份"，不改变它是什么。
  const rec = projBuildRecord(cur, nm, cur.source);
  cur.auto = false; cur.name = rec.name; cur.source = rec.source;
  log.info('proj', '保存工程存档', { id: rec.id, name: rec.name, kind: rec.kind, source: rec.source,
    frames: rec.analysis ? rec.analysis.frames.length : 0,
    notes: rec.midiNotes ? rec.midiNotes.length : 0, withAudio: !!rec.audioBlob });
  saveArchive(rec).then((ok) => {
    if (!ok) {
      setStatus('存档失败：本机存档服务不可用（请用 start-ydyi.bat 启动）。内容未丢，仍可试听/导出。');
      log.error('proj', '存档失败：本机存档服务不可用', { id: rec.id, name: rec.name });
      return;
    }
    setStatus('✓ 已存档「' + rec.name + '」');
    if (projPanelVisible()) projRefreshList();
  }).catch((e) => {
    setStatus('保存失败：' + (e.message || e));
    log.error('proj', '工程保存失败：' + (e.message || e), { id: rec.id, name: rec.name });
  });
}

// 由当前工程对象组装 IDB 记录（手动存档 / 自动存档共用一份字段映射，
// 免得两处各写一遍、日后加字段只改一处）。audioBlob 有就带、没有就纯曲线/纯 MIDI。
// src：来源。显式传入优先（落库方最清楚这段音频是哪来的）；
//      不传时退回 cur.source，再退回 inferSource 按内容猜（打开的老存档没有 source 时走这条）。
function projBuildRecord(cur, name, src) {
  const source = src || cur.source || proj.inferSource(cur);
  const rec = {
    id: cur.id || proj.makeId(), name: name || cur.name || '未命名',
    createdAt: cur.createdAt || Date.now(),
    kind: proj.inferKind(cur),
    source,
    audioName: cur.audioName || cur.name || '', audioMime: cur.audioMime || '',
    duration: cur.duration || 0, audioHash: cur.audioHash || '',
    analysis: cur.analysis || null,
    // ⚠ 细粒度包络必须一起存（2026-09-20 修）：它是分段器看检测窗(93ms)看不见的吐音气口
    // 的唯一线索（segmentPoints 的包络谷切分 / 回声气口）。这份字段映射漏了它的话，
    // 而老 IDB 路径 proj/project.mjs:projectSave 与 projectToFile 都带 env →
    // 结果是"录完当场看分段细一档，重开存档粗一档"（实测 9 个存档 env 全为 null）。
    // 漏字段的根源是"字段映射有两份拷贝"，故 test/project-archive.mjs 有一条守卫盯着这里。
    env: cur.env || null,
  };
  if (Array.isArray(cur.midiNotes) && cur.midiNotes.length) rec.midiNotes = cur.midiNotes;
  if (cur.audioBlob) { rec.audioBlob = cur.audioBlob; rec.audioMime = cur.audioBlob.type || rec.audioMime; }
  return rec;
}

// ⚠ 这里曾有一对 openedProjId / openedProjBufRef：打开存档时给 isProjPlayback 一个显式旁路，
//   理由是"MIDI/纯曲线工程的 buffer 与存档里的 bufferRef 永不相等"。
//   2026-09-22 核对后删除 —— 它从来没能生效：projOpenArchive 里刚赋值，紧接着 loadClip
//   就把它们清成 null（且所有打开路径都会把 curProject.bufferRef 设成同一个 clip.buffer，
//   引用判等本来就成立）。留着它只会让人以为"有兜底"。
let projAutoArchivePending = null;

// 自动存档（录音/导入音频在分析完成时、MIDI 在导入瞬间落库，用户不必再点「存工程」）。
// 命名沿用 cur.name（录音是"录音 HH:MM:SS"，MIDI 是原曲名），后续可在面板里改名。
// src：真实来源（proj.SOURCE_REC / SOURCE_IMPORT / SOURCE_MIDI），落库那一刻写死，
//     不能靠名字事后倒推（那正是"录音被标成导入音频"的根因）。
function projAutoArchive(cur, src, label) {
  if (!cur) return null;
  const rec = projBuildRecord(cur, cur.name, src);
  cur.id = rec.id;
  cur.source = rec.source;
  saveArchive(rec).then((ok) => {
    if (!ok) {
      // 自动存档失败不能打扰主流程，只记日志 + 状态栏轻提示
      setStatus('⚠ 自动存档失败（本机存档服务不可用，请用 start-ydyi.bat 启动），可在「📚 存档」里手动再存');
      log.warn('proj', '自动存档失败：本机存档服务不可用', { id: rec.id, kind: rec.kind });
      return;
    }
    log.info('proj', '已自动存档(' + (label || src) + ')', { id: rec.id, name: rec.name, kind: rec.kind, source: rec.source });
    if (projPanelVisible()) projRefreshList();
  }).catch((e) => {
    // 自动存档失败不能打扰主流程（很可能只是配额满），只记日志 + 状态栏轻提示
    setStatus('⚠ 自动存档失败(' + (e && e.name === 'QuotaExceededError' ? '存储空间不足' : (e.message || e)) + ')，可在「📚 存档」里手动再存或删旧档');
    log.warn('proj', '自动存档失败：' + (e.message || e), { id: rec.id, kind: rec.kind });
  });
  return rec.id;
}

// 打开一个存档：有音频→解码；无音频→静音 clip；使用存档的分析结果
function projOpenArchive(id) {
  getArchive(id).then(async (rec) => {
    if (!rec) { setStatus('存档不存在'); return; }
    const kind = proj.inferKind(rec);
    try {
      let clip;
      if (rec.audioBlob) {
        const buf = await decodeBuf(rec.audioBlob);
        clip = { name: rec.name, buffer: buf, blob: rec.audioBlob };
      } else {
        clip = projEmptyClip(projRecordDuration(rec));
      }
      // 直接把存档分析挂到当前工程，跳过重新分析
      // ⚠ env（细粒度包络）兜底（2026-09-20 修）：早于本次修复存下的存档里 env 恒为 null
      // （写入侧漏字段）。env 只依赖音频、是纯 DSP（computeEnv），故这里有音频就现算一份，
      // 免得"重开老存档 → 钢琴块分段比录完当场粗一档"。带 env 的存档不会走这条。
      let env = rec.env || null;
      if (!env && clip.buffer) {
        try {
          env = computeEnv(clip.buffer.getChannelData(0), clip.buffer.sampleRate);
          log.info('proj', '存档缺 env（老存档），已按音频现算兜底', { id: rec.id, points: env.length });
        } catch (e) { log.warn('proj', '存档 env 兜底重算失败（分段将少一档气口线索）', { id: rec.id, err: String(e && e.message || e) }); }
      }
      curProject = {
        id: rec.id, name: rec.name, createdAt: rec.createdAt, auto: false,
        kind,
        // source 必须一起带回来：打开存档后再点「存当前」，来源要保持不变
        // （否则会退化成按内容/名字重新猜，录音又被错标成导入音频）。
        source: rec.source || proj.inferSource(rec),
        bufferRef: clip.buffer, audioName: rec.audioName || rec.name,
        audioMime: rec.audioMime || '', duration: clip.buffer.duration,
        audioHash: rec.audioHash || '',
        analysis: rec.analysis || null,
        // 细粒度包络：回放分段的气口线索（缺失时上面已兜底重算）
        env,
        midiNotes: Array.isArray(rec.midiNotes) && rec.midiNotes.length ? rec.midiNotes : null,
        audioBlob: rec.audioBlob || null,
      };
      loadClip(clip, { noAnalyze: true });   // 不自动播放：先让用户看到整段曲线
      if (kind === proj.KIND_MIDI && !rec.audioBlob) {
        // MIDI 存档：看得见就要能弹——切钢琴块 + 开琴声，与导入 MIDI 同一条路。
        // ⚠ 只对"没有音频的存档"这么做：音频工程做过 AI 转谱后也会挂 midiNotes，
        //   但它的主数据是逐帧曲线，打开时强行换模板会顶掉用户自己的模板选择（2026-09-16 修）。
        try { localStorage.setItem('ydyi_piano_sound', '1'); } catch (e) {}
        if (anim.current() && anim.current().id !== 'pianoBlocks') switchTemplate('pianoBlocks');
        const pb = anim.get('pianoBlocks');
        if (pb && pb.setSoundEnabled) pb.setSoundEnabled(true);
      }
      const nm = (curProject.midiNotes || []).length;
      setStatus('✓ 已打开「' + rec.name + '」' + (kind === proj.KIND_MIDI
        ? ' · ' + nm + ' 个音符 · 按播放即看钢琴自动弹奏'
        : (rec.audioBlob ? ' · 拖动时间线查整段曲线' : ' · 无音频，仅查看整段曲线')) + discardNoteSuffix());
      log.info('proj', '打开存档', { id, name: rec.name, kind, withAudio: !!rec.audioBlob,
        frames: ((rec.analysis && rec.analysis.frames) || []).length, notes: nm });
      projSetCurrentUI();   // 状态行/面板控件随新工程刷新
    } catch (e) {
      curProject = null;
      setStatus('打开失败：' + (e.message || e));
      log.error('proj', '打开存档失败：' + (e.message || e), { id });
    }
  }).catch((e) => {
    // getArchive() 自身失败（本机存档服务不可用 / HTTP 错）时，上面那个 try 包不住它。
    // 没有这个 catch → 点存档行"毫无反应"，外加一条未处理的 Promise 拒绝；
    // 与 file-store 头注"不做静默降级、明确提示服务不可用"的承诺相悖。2026-09-22 补。
    const msg = (e && e.message) || String(e);
    setStatus('打开失败：' + msg);
    log.warn('proj', '读取存档失败：' + msg, { id });
  });
}

// 存档时长：音频工程用 duration(秒)；MIDI 工程 duration 常常没填(0)，
// 用最后一个音符的结束时间兜底，否则静音时间轴长度 1 秒、拖动条全是死的。
function projRecordDuration(rec) {
  const d = rec && rec.duration;
  if (d > 0) return d;
  const notes = (rec && rec.midiNotes) || [];
  if (notes.length) return Math.max(1, notes.reduce((m, n) => Math.max(m, n.t1), 0) / 1000 + 1.2);
  return 1;
}

function projDeleteArchive(id) {
  if (!confirm('删除这个存档？archives\\ 文件夹里的 .ydyi 文件会被一并删除，无法恢复。')) return;
  deleteArchive(id).then((ok) => {
    projRefreshList();
    setStatus(ok ? '已删除存档' : '删除失败：本机存档服务不可用（文件未被删除）');
  }).catch((e) => {
    setStatus('删除失败：' + ((e && e.message) || e));
    log.warn('proj', '删除存档失败：' + ((e && e.message) || e), { id });
  });
}
function projRenameArchive(id) {
  getArchive(id).then((rec) => {
    if (!rec) return;
    const nm = prompt('重命名：', rec.name);
    if (nm === null || !nm.trim()) return;
    // 文件存储：改名 = 按 id 删旧文件 + 按新名重写（rec 是完整记录，含音频可重新序列化）
    renameArchive(id, rec, nm.trim()).then((ok) => {
      if (!ok) { setStatus('重命名失败：本机存档服务不可用（旧文件未被改动）'); return; }
      if (curProject && curProject.id === id) curProject.name = nm.trim();
      projRefreshList();
    });
  }).catch((e) => {
    // getArchive() 自身失败（服务不可用 / HTTP 错）时上面那个 then 收不到 ——
    // 没有这个 catch，改名会整体静默失败（连一句提示都没有）。
    const msg = (e && e.message) || String(e);
    setStatus('重命名失败：' + msg);
    log.warn('proj', '读取存档失败（改名）：' + msg, { id });
  });
}

function projExportY() {
  const hasNotes = !!(curProject && curProject.midiNotes && curProject.midiNotes.length);
  const hasFrames = !!(curProject && curProject.analysis && curProject.analysis.frames && curProject.analysis.frames.length);
  if (!curProject || (!hasNotes && !hasFrames)) { setStatus('没有可导出的内容'); return; }
  // 文件名先取下来：回调里再读 curProject 可能已被换掉
  const expName = curProject.name || '工程';
  proj.projectToFile(curProject, { includeAudio: !!curProject.audioBlob }).then((text) => {
    const safe = expName.replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = safe + '.ydyi';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus('✓ 已导出 ' + safe + '.ydyi');
  }).catch((e) => {
    // projectToFile 会在 FileReader 失败时 reject（proj/project.mjs 的 fr.onerror）——
    // 没有这个 catch，用户点了导出没任何反应。
    setStatus('导出失败：' + ((e && e.message) || e));
    log.warn('proj', '导出工程失败：' + ((e && e.message) || e), {});
  });
}
function projImportFile(file) {
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const { proj: p, includeAudio } = proj.parseProjectFile(fr.result);
      const kind = proj.inferKind(p);
      const open = () => {
        if (includeAudio && p.audioBlob) projOpenImport(p);
        else if (kind === proj.KIND_MIDI) {
          // 纯 MIDI 的 .ydyi（不含音频）：用音符表直接起一个 MIDI 工程
          importMidiNotes(p.midiNotes, p.name);
          setStatus('✓ 已导入「' + p.name + '」· ' + p.midiNotes.length + ' 个音符' + discardNoteSuffix());
        } else {
          // 纯分析导入：给静音 clip
          const clip = projEmptyClip(p.duration || 1);
          curProject = { ...p, id: p.id || proj.makeId(), kind,
            bufferRef: clip.buffer, analysis: p.analysis, audioBlob: null };
          loadClip(clip, { noAnalyze: true });
          setStatus('✓ 已导入 .ydyi（不含音频，仅查看曲线）' + discardNoteSuffix());
          projSetCurrentUI();   // 状态行/面板控件随新工程刷新
        }
      };
      open();
    } catch (e) { setStatus('导入失败：' + (e.message || e)); }
  };
  fr.onerror = () => setStatus('读取文件失败');
  fr.readAsText(file);
}
async function projOpenImport(p) {
  try {
    const buf = await decodeBuf(p.audioBlob);
    const clip = { name: p.name || '导入工程', buffer: buf, blob: p.audioBlob };
    p.bufferRef = clip.buffer;
    p.kind = proj.inferKind(p);
    curProject = p;
    loadClip(clip, { noAnalyze: true, autoplay: false });
    // ⚠ 这里**不**按 kind===MIDI 去强切钢琴块模板：本函数只在"含音频的 .ydyi"路径被调用，
    // 而真正的 MIDI 工程从不带音频；能被判成 MIDI 的只有"音频工程 + AI转谱"那种，
    // 强切就会顶掉用户的模板选择（2026-09-16 修，同 projOpenArchive）。
    const nn = (p.midiNotes || []).length;
    setStatus('✓ 已导入「' + (p.name || '') + '」' + (nn
      ? ' · ' + nn + ' 个音符（含音频）· 曲线与钢琴块都在'
      : ' · 整段曲线就绪，拖动时间线查看'));
    projSetCurrentUI();   // 状态行/面板控件随新工程刷新
  } catch (e) { setStatus('导入音频解码失败：' + (e.message || e)); }
}

// ===== 存档面板的列表/分类 tab/搜索/用量提示：已搬到 app/proj-panel.mjs =====
// （2026-09-15「① 状态收敛」第六域。projQuery / projTab / PROJ_TABS 随之搬走，
//   面板状态集中在 proj-panel 域里。）

function projBind() {
  // 「⭱ 存工程」按钮已下线：与面板「⭱ 存当前」同函数重复，
  // 且录音/导入/MIDI/转谱本就自动落库。手动存档只留面板里的「存当前」一个入口。
  const bList = el('btnProjList'); if (bList) bList.addEventListener('click', () => projTogglePanel());
  const cClose = el('ppClose'); if (cClose) cClose.addEventListener('click', () => projTogglePanel(false));
  const bSaveCur = el('ppSaveCur'); if (bSaveCur) bSaveCur.addEventListener('click', projSaveCurrent);
  const iY = el('fileYdyi');
  const bImpY = el('ppImportY'); if (bImpY) bImpY.addEventListener('click', () => iY && iY.click());
  if (iY) iY.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) projImportFile(f); e.target.value = ''; });
  const bExpY = el('ppExportY'); if (bExpY) bExpY.addEventListener('click', projExportY);
  // 搜索框：只过滤不重查库（列表已在内存，projectList 每次是全表 getAll）。
  // 绑定与 projQuery 都归 proj-panel 域。
  bindProjPanel();
  // 绑定自检：缺元素 = index.html 与 app.mjs 版本不匹配（常见于浏览器缓存了旧页面），
  // 表现是"按钮点了没反应"，但控制台不报错。这条日志能一眼看出是缺哪个元素。
  const miss = ['btnProjList', 'projPanel', 'ppList', 'ppTabs', 'ppClose', 'ppSaveCur', 'ppSearch', 'ppFoot']
    .filter((id) => !el(id));
  log.info('proj', '存档面板已绑定' + (miss.length ? '（缺元素：' + miss.join(', ') + '）' : ''), { missing: miss });
}

// projRefreshFoot 已搬到 app/proj-panel.mjs

// ===== 调试日志面板：已抽成 app/logpanel.mjs（2026-09-15「① 状态收敛」第四域）=====
//   app 侧唯一接触点：configureLogPanel({ fmtClock, setStatus }) 注入 + 启动时 logBind()。

// ===== 域模块接线 =====
// 域模块不反向 import 别的域（域间会成环），跨域依赖一律由本文件显式注入。
// 传的是**惰性 getter**：被引用的绑定此前已完成初始化，且 getter 只在真正调用时
// 才求值，故无 TDZ 问题（放在这里是为了让所有接线集中一处、一目了然）。
configureEcho({ getRecState: () => recState });
configureCapture({
  canvas,
  getAudioCtx: () => audioCtx,
  getPlayOutNode: () => playOutNode,
  ensurePlayOut,                    // 函数声明，已提升
  getMicSrc: () => micSrc,
  getRecState: () => recState,
  getProject: () => curProject,
  setStatus,
  applyResize,
  downloadBlob,
});
configureLibrary({
  setStatus,
  importMIDI,
  // 曲库=我的歌单（2026-09-16）：点歌单里的存档条目 = 存档面板里点「打开」；
  // 清单用来显示"名字 + 来源"并识别"存档已被删除"。
  openArchive: projOpenArchive,          // 函数声明，已提升
  archiveList: () => listArchives(),
});
configureLogPanel({ fmtClock, setStatus });
configurePlayer({
  getAudioCtx: () => audioCtx,
  getPlayGain: () => playGain,
  ensurePlayOut,                    // 以下都是函数声明（已提升），直接传引用
  routeNow,
  stopLiveFeeding,
  ensureLoop,
  setStatus,
  updateTransportUI,
  setNoteRate: setNotePlayRate,     // 倍速转告琴声模块（琴声在钢琴块里按时间轴触发）
  snapshot,
  renderTemplate,
  getRecState: () => recState,
  isProjPlayback,
});
configureAudio({
  getCfgWindow: () => CFG.windowSize,   // analyser.fftSize 必须与检测窗长一致
  isGateAuto: () => GATE.auto,
  syncGateUI,
  onSampleRate: (sr) => { dbg.sr = sr; },   // 角标显示采样率用
});
configureProjPanel({
  listArchives,               // 列表 = archives/ 文件夹（经 /api/archives-meta）
  getProject: () => curProject,
  openArchive: projOpenArchive,
  renameArchive: projRenameArchive,
  deleteArchive: projDeleteArchive,
  setStatus,
  fmtDur,
  // 存档行上的曲库入口（☆ 收藏 / ＋歌单）：面板不 import 别的域，由这里注入
  libProjItem,
  libIsFav,
  libToggleFav,
  libPickGroup: (item, name) => openLibGroupPicker(item, name, () => setStatus('✓ 曲库歌单已更新')),
});

// 初始化视图
setView('live');
// UI 刷新崩了就崩了，绝不能挡住控件绑定（否则"开始录音"等按钮全部失效，页面看似死机）
try { updateTransportUI(); } catch (e) { console.error('init UI', e); }
bindControls();
fillKernelSel();
buildGlobalControls();   // 全局次级控件（原声音量）——与视图/模板无关，构建一次常驻
ensureKernelLoaded();
projBind();
rvcInit();   // 探测 RVC 本地桥(2.5s 超时)，没启动则静默禁用变声功能
logBind();
anim.initDefault();
applyResize();
refreshAnimBar();
projSetCurrentUI();

// 一次性迁移：浏览器 IndexedDB 里的旧存档 → archives/ 文件夹，然后删库。
// 服务没起（-1）时旧数据原样保留，下次带服务启动再迁。迁完刷新列表。
migrateFromIdb().then((n) => {
  if (n > 0) {
    setStatus('✓ 已把浏览器里的 ' + n + ' 条旧存档迁移到 archives 文件夹');
    if (projPanelVisible()) projRefreshList();
  }
}).catch(() => {});

// PWA：注册 Service Worker（可安装 + 外壳离线）。仅 secure context 有效——
// localhost 算，局域网 IP 不算（浏览器规定）。file:// 打开时静默跳过。
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(
    () => log.info('pwa', 'Service Worker 已注册'),
    (e) => log.warn('pwa', 'Service Worker 注册失败：' + (e.message || e)));
}

// 启动日志：新会话的第一条，标记环境与生效参数（排查一切问题的起点）
log.info('boot', 'ydyi 会话启动', {
  ua: navigator.userAgent,
  view: 'live',
  sens: SENS.val,
  gate: GATE.auto ? 'auto' : ('manual ' + GATE.db + 'dB'),
  kernel: kernelId,
  secure: window.isSecureContext,
});

// ---- 空闲渲染循环 ----
// 主循环 tick 只在录音/播放(running 或 playInfo.on)时运行；未录音/未播放/分析完成前
// 都不会驱动模板绘图 → 「音高轨迹」在没检测到声音时整块无内容(黑屏/只有淡网格)。
// 这里用独立低频循环兜底：空闲时也持续渲染当前模板的参照背景，
// 若停留在播放视图且有已分析工程(snapshot 的 projMode=true)，会直接画出整段音高曲线。
let idleTimer = null;
function idleLoop() {
  const busy = running || (playInfo && playInfo.on);
  if (!busy && anim.current()) {
    try { renderTemplate(snapshot(), performance.now()); } catch (e) {}
  }
  idleTimer = setTimeout(idleLoop, 33);
}
idleTimer = setTimeout(idleLoop, 33);
