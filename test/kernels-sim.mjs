// 轻量验证（联调用，本测试只防回归）：
//   1) core.pyin 纯音基频正确、prob 高；白噪 prob 低。
//   2) 自动回退路由：primary 未接入→走 fallback；primary ready+在范围→用主；超范围→回退。
import { pyin, centsOf } from '../dsp/core.mjs';
import { makeRouter } from '../dsp/kernels/route.mjs';
import { routeSwiftYin } from '../dsp/kernels/index.mjs';
import { resolveKernel } from '../dsp/kernels/index.mjs';
import { makeLinearResampler } from '../dsp/kernels/swiftf0.mjs';

const SR = 44100, N = 4096;
const CFG = { windowSize: N, fmin: 40, fmax: 8000 };

console.log('— SwiftF0 流式重采样（44.1k→16k）');
{
  const r1 = makeLinearResampler(44100, 16000);
  const ones = new Float32Array(44100).fill(0.5);
  const out = r1.push(ones);
  const okLen = out.length >= 15900 && out.length <= 16100;
  let mean = 0; for (let i = 0; i < out.length; i++) mean += out[i]; mean /= out.length;
  const okVal = Math.abs(mean - 0.5) < 1e-3;
  // 分片喂入与一次性喂入应产出相同样本数(增量守恒)
  const r2 = makeLinearResampler(44100, 16000);
  const parts = [4410, 8820, 17640, 13230];
  let nOut2 = 0;
  for (const n of parts) { const chunk = new Float32Array(n).fill(0.5); nOut2 += r2.push(chunk).length; }
  const okIncre = Math.abs(nOut2 - out.length) <= 2;
  console.log(`  1s直流: 输出${out.length}样本(≈16000) 均值${mean.toFixed(4)} ✓/✗ ${okLen && okVal ? '✓' : '✗'}`);
  console.log(`  分片守恒: ${nOut2}≈${out.length} ${okIncre ? '✓' : '✗'}`);
  if (!(okLen && okVal && okIncre)) process.exit(1);
  // 抗混叠：>8kHz 成分(10kHz)应被 FIR 抑制；旧行为(纯线性插值)会以 ~全幅折返到 6kHz
  {
    const x = new Float32Array(44100);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 10000 * i / 44100);
    const out = makeLinearResampler(44100, 16000).push(x);
    let rms = 0; for (const v of out) rms += v * v;
    rms = Math.sqrt(rms / out.length);         // 输入 RMS=0.707，折返残余应 <5%
    const okAA = rms < 0.05;
    console.log(`  抗混叠: 10kHz 折返残余 RMS=${rms.toFixed(4)} (期望<0.05, 旧行为≈0.5) ${okAA ? '✓' : '✗'}`);
    if (!okAA) process.exit(1);
  }
}
function tone(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR); return x; }
function noise(sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let s = 7; const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = rng(); return x; }
function firstWindow(x) { const w = new Float32Array(N); w.set(x.subarray(0, N)); return w; }

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

console.log('— 自动回退路由');
{
  // 未接入：routeSwiftYin(primary=swift, ready=false) 应等于 fallback=YIN
  const w = firstWindow(tone(523.25, 0.1));
  const fb = resolveKernel('yin-dual').frame(w, SR, CFG);
  const rt = routeSwiftYin.frame(w, SR, CFG);
  const okNoSw = Math.abs(rt.freq - fb.freq) < 1e-6 && rt.str === fb.str;
  console.log(`  路由未接入 → 恒回退 YIN：freq=${rt.freq && rt.freq.toFixed(1)}Hz 与YIN一致 ${okNoSw ? '✓' : '✗'}`);
  if (!okNoSw) process.exit(1);

  // 自建带 fake primary 的路由：ready + in-range → 用主；超范围 → 回退
  const fake = { id: 'f', ready: () => true, frame: (w2, s, c) => ({ freq: 500, str: 0.01, purity: 0.99, prom: 5 }) };
  const r2 = makeRouter({ id: 'r2', name: 'r2', primary: fake, fallback: resolveKernel('yin-dual'), range: [100, 1000] });
  r2.feedPrimary({ freq: 500, str: 0.05, purity: 0.9, prom: 9 });
  const inR = r2.frame(w, SR, CFG);
  r2.feedPrimary({ freq: 5000, str: 0.05, purity: 0.9, prom: 9 });  // 超范围
  const outR = r2.frame(w, SR, CFG);
  const okIn = Math.abs(inR.freq - 500) < 1e-6;
  const okOut = !(Math.abs(outR.freq - 500) < 1e-6) && Number.isFinite(outR.freq);   // 回到 fallback(YIN)
  console.log(`  primary ready+范围内 → 用主(500Hz) ${okIn ? '✓' : '✗'}`);
  console.log(`  primary 超范围   → 回退 YIN(${outR.freq && outR.freq.toFixed(1)}Hz) ${okOut ? '✓' : '✗'}`);
  if (!(okIn && okOut)) process.exit(1);
}

console.log('\n完成。pYIN 与回退路由均符合预期。');