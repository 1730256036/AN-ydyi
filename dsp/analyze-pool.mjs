// ============================================================
// dsp/analyze-pool.mjs —— 离线整段分析调度（浏览器分片 Worker / node 降级）
//
// analyzeOffline(pcm, sr, opt?, hooks?) -> Promise<result>
//   - 浏览器：切成 N 片交给 module Worker 并行，片间重叠 warmupSec
//     保证门控状态连续；拼接丢弃重叠帧。
//   - node / 无 Worker：直接单线程 analyzePCM（测试与回退）。
//   opt: { workerCount?, warmupSec?, ...其余透传 analyzePCM 配置(hopSize等) }
//   hooks: { onProgress?(ratio 0~1, label), onCancel?() -> bool }
// result: { sr, windowSize, hopMs, frames:[全局t递增], stats:{minHz,maxHz} }
// ============================================================
import { analyzePCMAsync } from './analyze.mjs';

const URL_WORKER = new URL('./analyze.worker.mjs', import.meta.url);

function defaultWorkers() {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(4, hc));
}

export function analyzeOffline(pcm, sr, opt = {}, hooks = {}) {
  const hasWorker = typeof Worker !== 'undefined';
  const workerCount = hasWorker ? Math.max(1, Math.min(6, opt.workerCount || defaultWorkers())) : 1;

  // ---- 无 Worker：单线程直跑（异步版：SwiftF0 先整段推理再逐窗） ----
  if (!hasWorker || workerCount === 1) {
    return analyzePCMAsync(pcm, sr, opt, (p) => {
      if (hooks.onProgress) hooks.onProgress(p.done / Math.max(1, p.total), '');
    });
  }

  // ---- 分片 ----
  const warmupSec = opt.warmupSec ?? 0.6;
  const warmupN = Math.ceil(sr * warmupSec);
  const hop = opt.hopSize || 1024;
  const align = (n) => Math.max(hop, Math.ceil(n / hop) * hop);
  const total = pcm.length;
  const nSlices = workerCount;
  const per = total / nSlices;

  const slices = [];
  for (let i = 0; i < nSlices; i++) {
    const sUsable = align(Math.round(i * per));
    const eUsable = i + 1 < nSlices ? align(Math.round((i + 1) * per)) : total;
    const s = Math.max(0, sUsable - warmupN);
    const e = Math.min(total, eUsable);
    if (e - s >= hop) slices.push({ s, e, sMs: sUsable / sr * 1000, warmMs: (sUsable - s) / sr * 1000 });
  }

  return new Promise((resolve, reject) => {
    let cancelled = false;
    const results = new Array(slices.length);
    let doneCount = 0;
    const workers = [];
    // 进度单调不减：各 worker 独立乱序上报 tick，直接显示最后一条会倒退
    // (如片3报 97% 后片0的 tick 到达显示 45%)。故只增不减。
    let lastRatio = 0;
    const report = (r, label) => {
      lastRatio = Math.max(lastRatio, Math.min(1, r));
      if (hooks.onProgress) hooks.onProgress(lastRatio, label);
    };

    const finish = () => {
      for (const w of workers) { try { w.terminate(); } catch (e) {} }
      try { resolve(merge(results, slices, sr, hop)); }
      catch (e) { reject(e); }
    };

    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      const w = new Worker(URL_WORKER, { type: 'module' });
      workers.push(w);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.id !== i) return;
        if (m.type === 'tick') {
          const ratio = (m.done / Math.max(1, m.total)) * (1 / slices.length)
                        + i * (1 / slices.length);
          report(ratio, `片 ${i + 1}/${slices.length}`);
        } else if (m.type === 'done') {
          results[i] = m.result;
          doneCount++;
          report(doneCount / slices.length, '合并中');
          if (doneCount === slices.length) finish();
        } else if (m.type === 'error') {
          for (const x of workers) { try { x.terminate(); } catch (e) {} }
          reject(new Error(m.message || '分析失败'));
        }
      };
      w.onerror = (ev) => {
        for (const x of workers) { try { x.terminate(); } catch (e) {} }
        reject(new Error(ev.message || 'Worker 初始化失败'));
      };
      if (hooks.onCancel) {
        const chk = setInterval(() => {
          if (!cancelled && hooks.onCancel()) {
            cancelled = true;
            clearInterval(chk);
            for (const x of workers) { try { x.terminate(); } catch (e) {} }
            reject(new Error('已取消'));
          }
        }, 200);
      }
      // 各切片 postMessage 时会转移其 ArrayBuffer。若直接用 pcm.subarray() 得到的是
      // 共享同一底层缓冲的视图：第一片转移后整个 buffer 即被 detach，其余片全部失效
      // （表现为整段分析卡在 1/slices 处不动）。故先把每片拷贝到独立缓冲再转移。
      const sub = new Float32Array(sl.e - sl.s);
      sub.set(pcm.subarray(sl.s, sl.e));
      // tOffsetSec：本片音频在**整段**里的起点（秒）。opt 里可能带整段帧表（SwiftF0），
      // 而 worker 只看得见自己这一片 → 不给这个偏移，kernelT.setWindowTime 收到的是
      // "片内相对时间"，查整段表就查到开头去了（第 2 片起全错，2026-09-18 修）。
      // 其余配置照旧透传（浅拷贝即可，worker 只读）。
      w.postMessage({ id: i, pcm: sub, sr, opt: Object.assign({}, opt, { tOffsetSec: sl.s / sr }) }, [sub.buffer]);
    }
    if (slices.length === 0) {
      resolve({ sr, windowSize: opt.windowSize || 4096, hopMs: hop / sr * 1000, frames: [], stats: { minHz: 0, maxHz: 0 }, params: { kernel: opt.kernel || null, sens: opt.sens ?? 70, voicing: opt.voicing ?? 85, hopMs: Math.round(hop / sr * 1000 * 100) / 100, energy: opt.energy || null } });
    }
  });
}

// 拼接各片：去掉 warmup 重叠帧，全局 t = 片有效起点 + 片内 t
function merge(results, slices, sr, hop) {
  const all = [];
  for (let i = 0; i < slices.length; i++) {
    const r = results[i];
    if (!r) continue;
    const sl = slices[i];
    const keepFromMs = 0;                  // worker 返回帧 t 从 0 起(含warmup段)
    for (const f of r.frames) {
      if (f.t < sl.warmMs - (hop / sr * 1000) * 0.5) continue;   // 丢 warmup 帧
      all.push({ ...f, t: Math.round(sl.sMs + (f.t - sl.warmMs)) });
    }
  }
  all.sort((a, b) => a.t - b.t);
  let min = NaN, max = NaN;
  for (const f of all) {
    if (f.voiced && f.freq > 0) {
      if (!(min > 0) || f.freq < min) min = f.freq;
      if (!(max > 0) || f.freq > max) max = f.freq;
    }
  }
  return {
    sr,
    windowSize: results[0] ? results[0].windowSize : 4096,
    hopMs: Math.round(hop / sr * 1000 * 100) / 100,
    frames: all,
    stats: {
      minHz: Number.isFinite(min) ? Math.round(min * 10) / 10 : 0,
      maxHz: Number.isFinite(max) ? Math.round(max * 10) / 10 : 0,
    },
    // 口径留痕（2026-09-20 加）：分片合并必须把 params 带出来，否则"分片分析"与
    // "单线程分析"产出的 analysis 结构不一致，存档里就少一段口径（worker 各片都带同一份，
    // 取第 0 片即可；worker 返回 undefined 时给 null，别让字段凭空消失）。
    params: (results[0] && results[0].params) || null,
  };
}
