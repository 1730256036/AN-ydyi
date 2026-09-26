// pYIN 检测内核验证（专项素材：
// 只有 kernels-sim 里一条 440Hz 纯音——恰好落在这类实现唯一不出错的工作点上）。
//
//   1) 谐波丰富素材上不得错八度（取"相对门 cm≤(1+cmMin)/2"≈0.5 会把半周期浅谷
//      当基频：f=440 时报 882Hz(+1204¢)；YIN 用绝对门 0.15 不受影响。本组就是那次回归）；
//   2) 与 YIN 的谷选择规则同源（同一素材两侧偏差应很小，不再出现单向偏高）；
//   3) 纯音精度 / 白噪 prob 低；
//   4) 品质信号方向 + 端到端门控（口哨发声、撞击判静音）。
import { yin, pyin, centsOf } from '../dsp/core.mjs';
import { pyinKernel } from '../dsp/kernels/pyin.mjs';
import { createDetector } from '../dsp/detect.mjs';

const SR = 44100, N = 4096;
const CFG = { windowSize: N, fmin: 40, fmax: 8000, voicing: 85 };
const CTR = Math.floor(SR * 0.6);          // 取中段窗（跳过起振）

function rngOf(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; }
function tone(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR); return x; }
function noise(sec, seed = 1) { const n = Math.floor(SR * sec), x = new Float32Array(n); const rng = rngOf(seed); for (let i = 0; i < n; i++) x[i] = rng(); return x; }
// 谐波丰富 + 2 次谐波凸出 + 噪声 + AM —— 复现"半周期谷被当基频"的素材形态
function richHarm(f, sec) {
  const n = Math.floor(SR * sec), x = new Float32Array(n), rng = rngOf(3);
  const ph = new Float32Array(15); for (let k = 1; k <= 14; k++) ph[k] = rng() * Math.PI;
  let sp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; let v = 0;
    for (let k = 1; k <= 14; k++) v += 10 ** ((-4 * (k - 1) + (k === 2 ? 9 : 0)) / 20) * Math.sin(2 * Math.PI * k * f * t + ph[k]);
    sp += v * v; x[i] = v * (1 + 0.3 * Math.sin(2 * Math.PI * 3.2 * t));
  }
  let np = 0; const nz = new Float32Array(n); for (let i = 0; i < n; i++) { nz[i] = rng(); np += nz[i] * nz[i]; }
  const k = Math.sqrt(sp / np) / 10 ** (15 / 20);
  for (let i = 0; i < n; i++) x[i] += nz[i] * k;
  return x;
}
function toneNoisy(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n), rng = rngOf(7); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR) + 0.08 * rng(); return x; }
function impulse(sec) { const n = Math.floor(SR * sec), x = new Float32Array(n), rng = rngOf(99); for (let i = 0; i < n; i++) x[i] = rng() * Math.exp(-i / (SR * 0.012)); return x; }
function windows(x) { const w = []; for (let p = 0; p + N <= x.length; p += N) w.push(x.subarray(p, p + N)); return w; }
const atWindow = (x) => x.subarray(CTR, CTR + N);

let fail = 0;
console.log('pYIN 内核验证（dsp/core.mjs pyin + kernels/pyin.mjs）\n');

console.log('— ① 谐波丰富素材不得错八度（旧实现 440Hz→882Hz/+1204¢）');
for (const f of [220, 283, 440, 523.25]) {
  const w = atWindow(richHarm(f, 0.9));
  const r = pyin(w, SR, { windowSize: N, hopSize: N, fmin: 40, fmax: 8000, threshold: 0.15 });
  const got = r.f[0], e = got ? centsOf(got, f) : NaN;
  const ok = Number.isFinite(got) && Math.abs(e) < 50;
  if (!ok) fail++;
  console.log(`  f=${String(f).padStart(7)}Hz → pYIN=${got ? got.toFixed(1) : 'NaN'}Hz (${e.toFixed(0)}¢) ${ok ? '✓' : '✗'}`);
}

console.log('\n— ② 与 YIN 谷选择规则同源（同一素材两侧应几乎一致，且不再单向偏高）');
for (const f of [220, 283, 440, 523.25]) {
  const w = atWindow(richHarm(f, 0.9));
  const a = yin(w, SR, { windowSize: N, hopSize: N, fmin: 40, fmax: 8000, threshold: 0.15 }).f[0];
  const b = pyin(w, SR, { windowSize: N, hopSize: N, fmin: 40, fmax: 8000, threshold: 0.15 }).f[0];
  const d = (a > 0 && b > 0) ? centsOf(b, a) : NaN;
  const ok = Number.isFinite(d) && Math.abs(d) < 20;
  if (!ok) fail++;
  console.log(`  f=${String(f).padStart(7)}Hz  YIN=${a ? a.toFixed(1) : 'NaN'}  pYIN=${b ? b.toFixed(1) : 'NaN'}  差=${d.toFixed(1)}¢ ${ok ? '✓' : '✗'}`);
}

console.log('\n— ③ 纯音精度 / 白噪 prob');
{
  const r = pyin(tone(440, 0.8), SR);
  let c = 0, e = 0;
  for (let i = 0; i < r.f.length; i++) if (Number.isFinite(r.f[i]) && r.f[i] > 0) { c++; e += Math.abs(centsOf(r.f[i], 440)); }
  const mae = c ? e / c : NaN;
  const rn = pyin(noise(0.8), SR);
  let p = 0; for (let i = 0; i < rn.prob.length; i++) p += rn.prob[i]; p /= rn.prob.length;
  const ok = mae < 20 && p < 0.4;
  if (!ok) fail++;
  console.log(`  纯音440Hz MAE=${mae.toFixed(2)}¢（<20 ✓）  白噪 prob均值=${p.toFixed(3)}（<0.4 ✓） ${ok ? '✓' : '✗'}`);
}

console.log('\n— ④ pyinKernel 品质信号方向 + 量纲（频谱侧，与 yin-dual 同源）');
{
  const kw = pyinKernel.frame(windows(toneNoisy(523.25, 1.5))[5], SR, CFG);
  const ki = pyinKernel.frame(windows(impulse(0.5))[0], SR, CFG);
  // prom>30 是量纲守卫：把 prom 当 0~30 的线性代理(封顶 30) 的话，与 yin-dual 的真实
  // 峰突出度 dB(纯净音 90~115、真素材 p50≈58) 不可比 → 渲染层与工程存档随内核漂移。
  const okDim = kw.prom > 30;
  let ok = kw.str < ki.str && kw.purity > ki.purity && okDim;
  for (const f of ['freq', 'str', 'purity', 'prom']) if (!Number.isFinite(kw[f])) { ok = false; console.log(`  ✗ ${f} 非有限`); }
  if (!ok) fail++;
  console.log(`  口哨帧 str=${kw.str.toFixed(3)} purity=${kw.purity.toFixed(3)} prom=${kw.prom.toFixed(1)}dB freq=${kw.freq.toFixed(1)}Hz`);
  console.log(`  撞击帧 str=${ki.str.toFixed(3)} purity=${ki.purity.toFixed(3)} prom=${ki.prom.toFixed(1)}dB ${ok ? '✓' : '✗'}`);
  console.log(`  量纲守卫 prom=${kw.prom.toFixed(1)}>30（真实 dB，非 0~30 代理）${okDim ? '✓' : '✗'}`);
}

console.log('\n— ⑤ 端到端门控（createDetector kernel=pyin）');
{
  const ratio = (x) => {
    const det = createDetector({ sampleRate: SR, fmin: 40, fmax: 8000, windowSize: N, voicing: 85, sens: 70, kernel: 'pyin' });
    det.setEnergy({ mode: 'auto', envRms: 0.002 });
    let v = 0; const ws = windows(x); for (const w of ws) if (det.processWindow(w).voiced) v++;
    return v / ws.length;
  };
  const rW = ratio(toneNoisy(523.25, 2.0)), rI = ratio(impulse(0.5));
  const ok = rW > 0.5 && rI === 0;
  if (!ok) fail++;
  console.log(`  口哨C5(带气声) 发声占比 ${(rW * 100).toFixed(0)}% (>50%)  拍桌撞击 ${(rI * 100).toFixed(0)}% (=0) ${ok ? '✓' : '✗'}`);
}

if (fail) { console.log(`\n失败 ${fail} 项`); process.exit(1); }
console.log('\n完成。pYIN 谷选择、精度、品质方向、门控行为均符合预期。');
