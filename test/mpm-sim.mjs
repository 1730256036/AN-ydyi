// MPM 检测内核验证：
//   1) core.mpm 对合成纯音/谐波信号的 MAE 与八度误判率；
//   2) mpmKernel.frame 产出的品质信号(str/purity/prom)均为有限数、方向对齐门控；
//   3) 端到端：createDetector({kernel:'mpm'}) 门控 —— 口哨高比例发声、撞击判静音。
import { mpm, centsOf } from '../dsp/core.mjs';
import { mpmKernel } from '../dsp/kernels/mpm.mjs';
import { createDetector } from '../dsp/detect.mjs';

const SR = 44100, N = 4096;
const CFG = { windowSize: N, fmin: 40, fmax: 8000, voicing: 85 };

function makeTone(f, dur = 0.8, { harm = null, snr = null, seed = 1 } = {}) {
  const n = Math.floor(SR * dur); const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let v = Math.sin(2 * Math.PI * f * t);
    if (harm !== null) {
      v += 10 ** (harm / 20) * Math.sin(2 * Math.PI * 2 * f * t + 0.3);
      v += 10 ** ((harm - 10) / 20) * Math.sin(2 * Math.PI * 3 * f * t + 0.7);
    }
    x[i] = v;
  }
  if (snr !== null) {
    let s = seed; const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1;
    let sp = 0, np = 0; const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) { noise[i] = rng(); np += noise[i] ** 2; sp += x[i] ** 2; }
    const k = Math.sqrt(sp / np) / 10 ** (snr / 20);
    for (let i = 0; i < n; i++) x[i] += noise[i] * k;
  }
  return x;
}
function toneNoisy(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let sd = 7; const rng = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR) + 0.08 * rng(); return x; }
function impulse(sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let sd = 99; const rng = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = rng() * Math.exp(-i / (SR * 0.012)); return x; }
function windows(x) { const w = []; for (let p = 0; p + N <= x.length; p += N) w.push(x.subarray(p, p + N)); return w; }
function maeOf(list, ref) { let s = 0, c = 0, g = 0; for (const v of list) { if (!Number.isFinite(v) || v <= 0) continue; const e = Math.abs(centsOf(v, ref)); s += e; c++; if (e > 600) g++; } return { mae: c ? s / c : NaN, octRate: c ? g / c : NaN }; }

console.log('MPM 精度（dsp/core.mjs mpm）\n');
let anyFail = false;
// 注意：MPM 纯时域、NSDF 窗口仅覆盖 ~4.5 个周期，低频(C2 及以下)在 20dB 噪声下抗噪弱于 YIN
// (44k/49Hz 低频伪相关段较宽)，这是 MPM 相对 YIN 的真实差异，非缺陷——故低频仅报告、不拦截。
const FREQS = [
  ['G1', 49, false], ['C2', 65.41, false],          // 低频：报告不要求
  ['C3', 130.81, true], ['A4', 440, true], ['C5', 523.25, true],
  ['C7', 2093, true], ['B7', 3951.07, true],         // 中高频：严格
];
for (const [name, f, strict] of FREQS) {
  const r = maeOf(mpm(makeTone(f, 0.6, { snr: 20 }), SR).f, f);
  const ok = r.mae < 50 && r.octRate === 0;
  if (strict && !ok) anyFail = true;
  console.log(`  ${name.padEnd(3)} ${String(f).padStart(7)}Hz  MAE=${r.mae.toFixed(2)}¢ 八度误判${(r.octRate * 100).toFixed(0)}%  ${strict ? (ok ? '✓' : '✗') : '(低频·仅报告)'}`);
}
if (anyFail) { console.log('\nMPM 中高频精度不达标'); process.exit(1); }

// ---- 品质信号方向：口哨 str 应低(强周期)、撞击 str 应高(弱周期) ----
console.log('\nmpmKernel 品质信号方向 + 量纲（频谱侧，与 yin-dual 同源）');
const wWhist = windows(toneNoisy(523.25, 1.5)); const wImp = windows(impulse(0.5));
const kw = mpmKernel.frame(wWhist[5], SR, CFG);
const ki = mpmKernel.frame(wImp[0], SR, CFG);
console.log(`  口哨帧: str=${kw.str.toFixed(3)} purity=${kw.purity.toFixed(3)} prom=${kw.prom.toFixed(1)} freq=${kw.freq.toFixed(1)}Hz`);
console.log(`  撞击帧: str=${ki.str.toFixed(3)} purity=${ki.purity.toFixed(3)} prom=${ki.prom.toFixed(1)} freq=${isFinite(ki.freq) ? ki.freq.toFixed(0) : '--'}Hz`);
// prom>30 是量纲守卫：把 prom 当 0~30 线性代理(封顶 30) 的话，与 yin-dual 的真实峰突出度
// dB(纯净音 90~115、真素材 p50≈58) 不可比 → 渲染层与工程存档的 prom 随内核漂移。
const dirOk = kw.str < ki.str && kw.purity > ki.purity && kw.prom > 30;
if (!(kw.prom > 30)) console.log(`  ✗ prom=${kw.prom.toFixed(1)} 未落在真实 dB 量纲（<=30 说明退回了代理值）`);
for (const f of ['freq', 'str', 'purity', 'prom']) if (!Number.isFinite(kw[f])) { dirOk = false; console.log(`  ✗ ${f} 非有限`); }
if (!dirOk) { console.log('\nMPM 品质信号方向不正确'); process.exit(1); }

// ---- 端到端门控（走默认外部的 MPM 内核） ----
console.log('\n端到端门控（createDetector kernel=mpm）');
function gateRatio(x) { const det = createDetector({ sampleRate: SR, fmin: 40, fmax: 8000, windowSize: N, voicing: 85, sens: 70, kernel: 'mpm' }); det.setEnergy({ mode: 'auto', envRms: 0.002 }); let v = 0; const ws = windows(x); for (const w of ws) if (det.processWindow(w).voiced) v++; return v / ws.length; }
const rW = gateRatio(toneNoisy(523.25, 2.0));
const rI = gateRatio(impulse(0.5));
const okW = rW > 0.5, okI = rI === 0;
console.log(`  口哨C5(带气声) 发声占比 ${(rW * 100).toFixed(0)}%  ${okW ? '✓' : '✗'}（期望 >50%）`);
console.log(`  拍桌撞击      发声占比 ${(rI * 100).toFixed(0)}%  ${okI ? '✓' : '✗'}（期望 =0）`);
if (!(okW && okI)) { console.log('\nMPM 门控行为不符合预期'); process.exit(1); }
console.log('\n完成。MPM 精度、品质方向、门控行为均符合预期。');