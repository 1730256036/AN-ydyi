// ============================================================
// dsp/analyze.mjs —— 离线整段分析（导入音频 / 录音转工程用）
// 把一段 PCM 切成窗逐窗跑 createDetector，产出带时间戳的帧序列。
// 纯数据模块：不碰 DOM，node / Web Worker / 主线程都能跑。
// 与实时检测共用同一套门控（dsp/detect.mjs），保证离线/实时口径一致。
//
// 帧 = { t(ms), freq(Hz 发声), voiced, prom, purity, rms, str }
// 输出 { sr, windowSize, hopMs, frames:[...], stats:{min,max}, params:{kernel,sens,voicing,hopMs,energy} }
//   ⚠ `sr` = 分析时【解码缓冲】的采样率（decodeAudioData 会重采样到 AudioContext 的采样率，
//     随环境变），**不是存档那份音频自身的采样率**。复现/重算要认 hopMs(毫秒)；
//     拿存档音频重算时帧移按 hopMs×当前 sr 求，别拿 sr 当音频音频率（2026-09-20 澄清）。
//   params = 口径留痕（曲线依赖 sens/能量门/内核，不记就没法复现、没法解释"重算后怎么变了"）。
// ============================================================
import { createDetector } from './detect.mjs';
import { resolveKernel } from './kernels/index.mjs';

export const DEF = {
  fmin: 40, fmax: 8000,
  windowSize: 4096,          // 与实时一致
  hopSize: 1024,             // 帧移（≈23ms @44.1k，比实时更细，供平滑曲线）
  voicing: 85,
  sens: 70,                  // 默认灵敏度（跟随实时口径时可被 opt.sens 覆盖）
};

// 整段分析（同步阻塞版；Worker 内直接调用）。
// pcm: Float32Array(单声道, -1~1)  sr: 采样率  opt: 覆盖 DEF
// opt.energy?: 跟随【实时能量门口径】(createDetector 同款)，使离线帧与实时检测
//               对同一音频判出一致的 voiced/freq（查表回放与录音曲线同源的前提）：
//   { mode: 'auto'|'manual', envRms: 环境底噪rms(auto 时 rms>envRms*1.5),
//     db: 手动 dB 门槛(manual 时 dbOf(rms)>=max(db, 底噪dB)) }
//   不传 → 用自适应策略(全段 RMS 10% 分位 ×1.5 与中位 ×0.5 取小)兜底，
//   适合"无现场底噪可参考的任意文件"(导入素材/测试)。
// onTick({done,total}) 每 256 窗回调一次（Worker 用它回传进度）
export function analyzePCM(pcm, sr, opt = {}, onTick = null) {
  const cfg = { ...DEF, ...opt };
  const N = cfg.windowSize, hop = cfg.hopSize;
  const nFrames = Math.max(0, Math.floor((pcm.length - N) / hop) + 1);
  const det = createDetector({ sampleRate: sr, ...cfg });
  // 口径留痕：这条曲线究竟用什么参数算的。只记 sr/windowSize/hopMs 不够，
  // 而 sens / 能量门 / 内核同样决定结果 → 存档里的曲线不可复现、不可解释（也不可能判断
  // "为什么重算后变了"）。这里把真正喂给检测器的口径记下来，随 analysis 一起落盘。
  // ⚠ 只在两个分支各记一次，保持"记的就是实际用的"。
  let energyRec;
  if (cfg.energy) {
    // 实时口径：直接按实时参数设置，保证离线/实时对同一音频判同(见 detect.mjs energyOkOf)
    const em = cfg.energy.mode || 'auto';
    energyRec = { mode: em, envRms: cfg.energy.envRms || 0, db: cfg.energy.db };
    det.setEnergy(energyRec);
  } else {
    // 自适应兜底：离线没有"校准底噪"交互。
    // 取文件前 ~93ms 作底噪的话——若音频开头即发声(导入的歌曲/合成音/开口就唱的录音)，
    // 门槛被设为声音本身 ×1.5，整段被滤成 0 发声帧(工程曲线全空)。
    // 改为：全段按窗统计 RMS，取 10% 分位作底噪(正常录音的气口/静音段才是真底噪)，
    // 并用中位数 ×0.5 兜底上限——保证"全程有声"的音频也能通过能量门。
    let floorRms = 2e-4;
    if (nFrames > 0) {
      const step = Math.max(1, Math.floor(nFrames / 400));   // 最多抽 ~400 窗，开销可忽略
      const rmsList = [];
      for (let i = 0; i < nFrames; i += step) {
        const p = i * hop;
        const end = Math.min(p + N, pcm.length);
        let s = 0;
        for (let k = p; k < end; k++) s += pcm[k] * pcm[k];
        rmsList.push(Math.sqrt(s / (end - p)));
      }
      rmsList.sort((a, b) => a - b);
      const q = (r) => rmsList[Math.min(rmsList.length - 1, Math.floor(r * rmsList.length))];
      floorRms = Math.min(q(0.10) * 1.5, q(0.50) * 0.5) + 2e-4;
    }
    energyRec = { mode: 'auto', floorRms };        // 记录实际用的自适应底噪（可复现的关键项）
    det.setEnergy(energyRec);
  }
  if (cfg.sens !== undefined) det.setSens(cfg.sens);

  // 同一内核单例供 setWindowTime：resolveKernel 返回与 createDetector 内部同一对象实例。
  // 离线逐窗把当前窗绝对时间喂给路由内核 → route.frame 经 primary.atTime 精确取 SwiftF0 帧
  //（实时模式无人调用 setWindowTime，route 自动走 latestF0 缓存，两路互不干扰）。
  const kernelT = resolveKernel(cfg.kernel);

  const frames = [];
  let t = 0;                       // 当前窗起始时间 ms
  const hopMs = hop / sr * 1000;
  const win = new Float32Array(N);
  let lastDone = 0;
  // 短气口桥接（与实时 pitchTrail 的 BRIDGE_MS 语义一致）：
  // 离线分析若不保存非 voiced 帧的频率，播放/工程曲线会因少量弱帧判定而断断续续("闪闪")。
  // 故距最后一次发声在桥接窗内且有最近有效频率的帧，也保留该频率(画细线)，长停才真正断开。
  const bridgeMs = cfg.bridgeMs ?? 900;
  const bridgeFrames = Math.max(1, Math.round(bridgeMs / Math.max(0.1, hopMs)));
  let lastVoicedI = -Infinity;

  for (let i = 0; i < nFrames; i++) {
    const p = i * hop;
    win.set(pcm.subarray(p, p + N));
    t = i * hopMs;
    // 喂给路由内核的必须是**整段绝对时间**：分片 Worker 时各片音频起点不同，
    // 由主线程在 opt.tOffsetSec 里带上本片在整段里的起点（单线程路径为 0）。
    // 只喂片内相对时间不够：route 拿它去查**整段** SwiftF0 帧表，
    // 于是第 2 片起取到的是"开头"那段的音高（>8s 素材 + route-swift-yin 内核即中）。
    const tAbs = t / 1000 + (cfg.tOffsetSec || 0);
    if (kernelT && typeof kernelT.setWindowTime === 'function') kernelT.setWindowTime(tAbs);
    const r = det.processWindow(win);
    const voiced = r.voiced;
    let freq = 0;
    if (voiced && Number.isFinite(r.freq) && r.freq > 0) { freq = r.freq; lastVoicedI = i; }
    // 桥接用检测器跨帧保留的最近有效频率(det.lastGoodFreq)，非 voiced 帧也能拿到
    else if (Number.isFinite(det.lastGoodFreq) && det.lastGoodFreq > 0 && i - lastVoicedI <= bridgeFrames) { freq = det.lastGoodFreq; }
    frames.push({
      t: Math.round(t),
      freq,
      voiced,
      prom: Math.round(r.prom * 100) / 100,
      purity: Math.round(r.purity * 1000) / 1000,
      rms: Math.round(r.rms * 1e5) / 1e5,
      str: Math.round(r.str * 1000) / 1000,
    });
    if (onTick && i - lastDone >= 256) { lastDone = i; onTick({ done: i + 1, total: nFrames }); }
  }
  if (onTick) onTick({ done: nFrames, total: nFrames });

  // 统计发声帧的音域
  let min = NaN, max = NaN;
  for (const f of frames) {
    if (f.voiced && f.freq > 0) {
      if (!(min > 0) || f.freq < min) min = f.freq;
      if (!(max > 0) || f.freq > max) max = f.freq;
    }
  }
  const stats = {
    minHz: Number.isFinite(min) ? Math.round(min * 10) / 10 : 0,
    maxHz: Number.isFinite(max) ? Math.round(max * 10) / 10 : 0,
  };
  // params = 这条曲线的口径留痕（与 frames 一起进工程/存档）。
  // 读法约定（#1 语义澄清）：`sr` 是【分析时解码缓冲】的采样率，**不是存档那份音频自身的**
  // （浏览器 decodeAudioData 会重采样到 AudioContext 的采样率，且随环境变）。
  // 复现栅格要认 `hopMs`(毫秒，权威) 与 `windowSize/sr`(窗长≈秒)，别把 sr 当成音频音频率
  // —— 拿存档音频重算时按 hopMs×当前 sr 求帧移，时间轴才对得齐（2026-09-20 补）。
  const params = {
    kernel: kernelT ? kernelT.id : null,
    sens: cfg.sens ?? 70,
    voicing: cfg.voicing ?? 85,
    hopMs: Math.round(hopMs * 100) / 100,
    energy: energyRec,
  };
  return { sr, windowSize: N, hopMs: params.hopMs, frames, stats, params };
}

// 整段分析·异步版（Worker / 无 Worker 的 node 路径用）：
// 离线链路中 SwiftF0 是异步 ONNX 推理。两种取帧方式（二选一，见 autoAnalyzeClip）：
//   A. 主线程预推理：调用方在 cfg.swiftFrames 传入帧表（主线程 session 已确认可用），
//      这里直接 _injectOffline，绕开 worker 内建 session/推理的不稳定。
//   B. 本地推理：无帧表时在当前环境(worker/主线程/单线程)先整段/分块跑一次。
// 均失败自动回退纯 YIN，但失败原因会打日志（不再静默吞掉，便于定位）。
export async function analyzePCMAsync(pcm, sr, opt = {}, onTick = null) {
  const cfg = { ...DEF, ...opt };
  const kernel = resolveKernel(cfg.kernel);
  if (kernel && typeof kernel.runOffline === 'function') {
    // A: 主线程预推理帧表（推荐；worker 无需碰 onnx）
    if (Array.isArray(cfg.swiftFrames) && cfg.swiftFrames.length) {
      try {
        kernel._injectOffline(cfg.swiftFrames);
        console.info(`[analyze] SwiftF0 注入离线帧表 ${cfg.swiftFrames.length} 帧（主线程预推理）`);
      } catch (e) { console.warn('[analyze] SwiftF0 帧表注入失败:', e && e.message || e); }
    } else {
      // B: 本地推理兜底
      try {
        if (!kernel.ready()) { try { await kernel.load(); } catch (e) { console.warn('[analyze] SwiftF0 加载失败(将回退纯 YIN):', e && e.message || e); } }
        if (kernel.ready()) {
          const n = await kernel.runOffline(pcm, sr, onTick);
          console.info(`[analyze] SwiftF0 本地整段推理 ${n ? n.length : 0} 帧`, n ? `(conf平均 ${(n.reduce((a, x) => a + (x.conf || 0), 0) / n.length).toFixed(3)})` : '');
        } else console.warn('[analyze] SwiftF0 未就绪，本次离线回退纯 YIN');
      } catch (e) { console.error('[analyze] SwiftF0 离线推理异常(回退纯 YIN):', e && e.message || e); }
    }
  }
  try {
    return analyzePCM(pcm, sr, opt, onTick);
  } finally {
    try {
      if (kernel && typeof kernel.getStats === 'function') {
        const st = kernel.getStats();
        const t = st.hit + st.fallback + st.noFrame + st.lowConf + st.outOfRange + st.notReady;
        console.info(`[analyze] 路由统计: hit=${st.hit} fallback=${st.fallback} lowConf=${st.lowConf} noFrame=${st.noFrame} outOfRange=${st.outOfRange} notReady=${st.notReady} → SwiftF0离线占比=${t ? Math.round(100 * st.hit / t) : 0}%`);
      }
      if (kernel && typeof kernel.setWindowTime === 'function') kernel.setWindowTime(null);
      if (kernel && typeof kernel._clearOffline === 'function') kernel._clearOffline();
    } catch (e) { /* 清理失败不影响结果 */ }
  }
}
