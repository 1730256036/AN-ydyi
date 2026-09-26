// ============================================================
// dsp/envelope.mjs —— 细粒度音量包络(全本地，零依赖)
//
// computeEnv(pcm, sr, { hopMs = 5, winMs = 12 }) → [{ t(ms), rms }]
//   短窗(默认12ms)短跳(默认5ms)的 rms 序列。用途：吐音/发音气口在
//   93ms 检测窗里会被平均抹平(tongue-diag 实测：快吐段包络近乎直线)，
//   10ms 级短窗才能看见气口。给分段器当切分线索。
// ============================================================

export function computeEnv(pcm, sr, { hopMs = 5, winMs = 12 } = {}) {
  const hop = Math.max(1, Math.round(sr * hopMs / 1000));
  const win = Math.max(hop, Math.round(sr * winMs / 1000));
  const env = [];
  for (let p = 0; p + win <= pcm.length; p += hop) {
    let s = 0;
    for (let k = p; k < p + win; k++) s += pcm[k] * pcm[k];
    env.push({ t: Math.round((p + win / 2) / sr * 1000), rms: Math.sqrt(s / win) });
  }
  return env;
}
