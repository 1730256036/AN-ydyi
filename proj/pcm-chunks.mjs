// ============================================================
// proj/pcm-chunks.mjs —— 分块 PCM 缓冲（纯函数，零依赖）
//
// 用途：录音期间实时累积原始 PCM（app.mjs 的 recPcm）。
// 为什么不用"单个几何倍增 Float32Array"：
//   扩容那步是 new + 复制旧数据，**新旧两块同时存在 → 峰值 ≈ 2× 数据量**。
//   44.1kHz 单声道 float32 ≈ 176 KB/s：
//     1 分钟 ~10.6MB / 10 分钟 ~106MB / 30 分钟 ~317MB
//   30 分钟那次扩容峰值约 950MB（634MB 新 + 317MB 旧）——足以让标签页直接崩、录音全丢。
//   分块后：每次只分配一块 CHUNK，永不复制旧数据，峰值 = 数据量 + 一块。
//
// 语义：与"写进一个长度无限的连续缓冲"完全等价——
//   appendChunked(chunks, len, src) 等价于 buf.set(src, len); len += src.length
//   唯一区别是内部存放为若干定长块。读出时按块拷到连续目标即可。
// ============================================================

// 每块样本数（2^16 ≈ 1.49s @44.1k）。块只增不缩，最后一块可能只填一部分。
export const CHUNK_SAMPLES = 1 << 16;

// 追加写入。返回新的累计样本数（= 旧 len + src.length）。
// chunks 会被就地修改（可能追加新块）。
export function appendChunked(chunks, len, src) {
  if (!src || src.length === 0) return len;
  let off = 0;
  const need = src.length;
  while (off < need) {
    const pos = len + off;
    const ci = Math.floor(pos / CHUNK_SAMPLES);
    while (chunks.length <= ci) chunks.push(new Float32Array(CHUNK_SAMPLES));
    const dst = chunks[ci];
    const inChunk = pos - ci * CHUNK_SAMPLES;
    const n = Math.min(CHUNK_SAMPLES - inChunk, need - off);
    dst.set(src.subarray(off, off + n), inChunk);
    off += n;
  }
  return len + need;
}

// 把前 len 个样本按顺序复制到连续目标 dst（通常是 AudioBuffer 的某个声道）。
// 返回实际复制的样本数。dst 不够长时只拷能放下的部分（不抛）。
export function copyChunked(chunks, len, dst) {
  let o = 0;
  for (const c of chunks) {
    if (o >= len || o >= dst.length) break;
    const n = Math.min(c.length, len - o, dst.length - o);
    if (n <= 0) break;
    dst.set(c.subarray(0, n), o);
    o += n;
  }
  return o;
}

// 当前占用样本数（含各块未填满的尾部空位）——用于估算真实内存占用
export function allocatedSamples(chunks) {
  return chunks.length * CHUNK_SAMPLES;
}

// 已写入的样本数换算成秒（仅供日志/估算）
export const samplesToSec = (n, sr) => (sr > 0 ? n / sr : 0);
