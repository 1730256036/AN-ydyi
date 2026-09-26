// ============================================================
// dsp/analyze.worker.mjs —— 离线分析 Web Worker 入口
// 主线程通过 analyzePool() 调度（见 analyze-pool.mjs）。
// 每个 worker 处理一整段独立 PCM（分片由主线程切好，含 warmup）。
// ============================================================
import { analyzePCMAsync } from './analyze.mjs';

self.onmessage = async (e) => {
  const { id, pcm, sr, opt } = e.data;      // pcm: Float32Array(transferable)
  try {
    const res = await analyzePCMAsync(pcm, sr, opt || {}, (p) => {
      self.postMessage({ id, type: 'tick', done: p.done, total: p.total });
    });
    self.postMessage({ id, type: 'done', result: res });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
