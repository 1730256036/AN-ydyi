// 轻量验证（联调用，本测试只防回归）：
//   core.pyin 纯音基频正确、prob 高；白噪 prob 低。
import { pyin, centsOf } from '../dsp/core.mjs';

const SR = 44100, N = 4096;

function tone(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR); return x; }
function noise(sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let s = 7; const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = rng(); return x; }

console.log('— core.pyin 精度');
{
  const f = 440;
  const r = pyin(tone(f, 0.8), SR);
  let cnt = 0, err = 0, windowP = 0;
  for (let i = 0; i < r.f.length; i++) if (Number.isFinite(r.f[i]) && r.f[i] > 0) { cnt++; err += Math.abs(centsOf(r.f[i], f)); }
  const rn = pyin(noise(0.8), SR);
  for (let i = 0; i < rn.prob.length; i++) windowP += rn.prob[i];
  windowP /= rn.prob.length;
  const okTone = cnt > 0 && err / cnt < 50;
  const okNoise = windowP < 0.4;
  console.log(`  纯音440Hz: MAE=${(err / Math.max(1, cnt)).toFixed(2)}¢ ${okTone ? '✓' : '✗'}`);
  console.log(`  白噪 prob 均值=${windowP.toFixed(3)} (期望<0.4, 越小越不像音高) ${okNoise ? '✓' : '✗'}`);
  if (!(okTone && okNoise)) process.exit(1);
}

console.log('\n完成。pYIN 符合预期。');