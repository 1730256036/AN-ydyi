// ============================================================
// dsp/stretch.mjs —— 变速不变调：时域颗粒重排（WSOLA 简化版）
//
// 用途：播放倍速里「保持音高不变」的那一档。纯函数，不碰 WebAudio ——
// 输入一段单声道 PCM，输出时长按 rate 缩放、音高不变的 PCM。
//
// 为什么不能直接用 playbackRate：AudioBufferSourceNode 的 playbackRate 是**重采样**，
// 2× 就把音高抬八度、0.5× 降八度（磁带式）。本工具是音高仪，慢放听到的音高与
// 屏幕上的曲线对不上会直接误导练耳，所以慢/快档默认走这里"重排"而不是"重采样"。
// （MIDI 工程不受影响：它的声音是琴声模块临时合成的固定音高，改节奏天然不变调。）
//
// 算法（WSOLA = Waveform Similarity Overlap-Add）：
//   · 合成侧固定步长 Hs = 窗长/2，Hann 窗 50% 交叠相加 —— 窗口和恒为 1；
//     末了再按实测窗口和归一化一次，首尾也不掉电平。
//   · 分析侧步长 Ha = Hs × rate：rate<1 → 相邻两粒在输入里贴得更近(同一段波形被
//     重复使用→变慢)；rate>1 → 离得更远(跳过一部分→变快)。都是"重排"，音高不动。
//   · 只按固定 Ha 走会让接缝落在波形任意相位上 → 周期性重复同一段波形，听感是
//     明显梳状/金属味。故每一粒在 ±SEARCH 内搜索与「上一粒的自然延续」最相似
//     （归一化互相关最大）的起点，把接缝挪到波形相似处 —— 这是 WSOLA 的关键一步。
//
// 已知限制（别当 bug 修）：
//   · 极端档位（0.25×/4×）颗粒感无法避免，这是 OLA 类算法的固有性质；
//   · 复杂度 O(粒数 × 搜索点数)，主线程同步跑：60s 音频约几十 ms，够用；
//   · 单位/口径：pcm 与返回值都是**同一个采样率**下的样点，长度关系 len/rate，
//     所以调用方的时间轴（播放头/走带条/工程帧查表）仍按【原时长】算，不用换算。
// ============================================================

const WIN_MS = 46;        // 分析/合成窗长。≥ 最低音(40Hz≈25ms)的两个周期，才不糊掉基频
const SEARCH_MS = 4.4;    // 相似性对齐搜索半径
const STEP_MS = 0.18;     // 搜索粗步长(≈8 样点@44.1k)：细到 8 样点已足以对齐相位，省 8 倍算力
const CORR_DIV = 8;       // 相关窗 = 窗长/8
const CORR_STRIDE = 2;    // 相关窗内抽样步长(再省一半)

/** 周期性 Hann 窗（周期型，50% 交叠相加恰为常数 1）。 */
function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

/**
 * 时域变速不变调。
 * @param {Float32Array} pcm 输入单声道样点（-1~1）。不会被修改。
 * @param {number} rate 播放倍速：2 = 快一倍(输出缩短一半)，0.5 = 慢一倍(输出加长一倍)。
 * @param {number} sampleRate 采样率（只用来把 ms 常数换算成样点）。
 * @returns {Float32Array} 新数组，长度 ≈ pcm.length / rate；rate===1 时为逐位拷贝。
 */
export function timeStretch(pcm, rate, sampleRate) {
  const n = pcm.length;
  if (!(rate > 0) || n === 0) return pcm.slice(0, n);
  const outLen = Math.max(1, Math.round(n / rate));
  // 原速：直接拷贝。绝不进 OLA —— 否则周期性信号会被"相似性对齐"挪动相位，
  // 明明是原速却多出一层处理痕迹（内容对不上是要命的回归）。
  if (rate === 1) return pcm.slice(0, outLen);

  const sr = sampleRate > 0 ? sampleRate : 44100;
  // 窗长上限是输入长度本身（极短输入不能给一个比它还大的窗，否则粒内会读到越界 → NaN）。
  // 下限取 1：短于 16 样点的输入在现实里不可能（16 样点=0.36ms 音频），但没必要留个坑。
  const win = Math.max(1, Math.min(Math.round(sr * WIN_MS / 1000), n));
  const Hs = Math.max(1, win >> 1);
  const Ha = Hs * rate;
  const search = Math.max(1, Math.round(sr * SEARCH_MS / 1000));
  const step = Math.max(1, Math.round(sr * STEP_MS / 1000));
  const corr = Math.max(4, Math.round(win / CORR_DIV));
  const maxStart = Math.max(0, n - win);

  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  const w = hann(win);
  let prev = 0;                         // 上一粒在输入中的起点（"自然延续"的参照）
  let k = 0;
  for (let pos = 0; pos < outLen; pos += Hs, k++) {
    const base = Math.round(k * Ha);
    const start = k === 0 ? 0 : align(pcm, prev + Hs, base, { search, step, corr, maxStart });
    for (let i = 0; i < win; i++) {
      const j = pos + i;
      if (j >= outLen) break;
      out[j] += pcm[start + i] * w[i];
      norm[j] += w[i];
    }
    prev = start;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
  return out;
}

/**
 * WSOLA 的相似性对齐：在 base±search 内找一个起点，使其内容与「上一粒的自然延续」
 * （输入里 ref 起的 corr 个样点）归一化互相关最大。off=0 参与竞争但不占便宜
 * （同分保留 0，静音段不会被无谓挪动）。
 */
function align(pcm, ref, base, { search, step, corr, maxStart }) {
  const n = pcm.length;
  const clamp = (v) => (v < 0 ? 0 : (v > maxStart ? maxStart : v));
  const score = (c) => {
    let dot = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < corr; i += CORR_STRIDE) {
      const ri = ref + i;
      const a = ri < n ? pcm[ri] : 0;
      const b = pcm[c + i];
      dot += a * b; e1 += a * a; e2 += b * b;
    }
    return dot / Math.sqrt(e1 * e2 + 1e-12);
  };
  let best = clamp(base), bestSc = score(best);
  for (let off = -search; off <= search; off += step) {
    if (off === 0) continue;
    const c = clamp(base + off);
    if (c === best) continue;
    const sc = score(c);
    if (sc > bestSc) { bestSc = sc; best = c; }
  }
  return best;
}
