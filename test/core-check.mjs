// 验证 dsp/core.mjs：用合成已知频率信号跑 A/B/融合，检查 MAE 与八度误判率。
import { peakTrack, yin, fusePoint, freqToNote, centsOf } from '../dsp/core.mjs';

const SR = 44100;

function makeTone(f, dur = 0.8, { harm = null, snr = null, seed = 1 } = {}) {
  const n = Math.floor(SR * dur);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = Math.sin(2 * Math.PI * f * t);
    if (harm !== null) {
      v += 10 ** (harm / 20) * Math.sin(2 * Math.PI * 2 * f * t + 0.3);
      v += 10 ** ((harm - 10) / 20) * Math.sin(2 * Math.PI * 3 * f * t + 0.7);
    }
    x[i] = v;
  }
  if (snr !== null) {
    let s = 1; const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1;
    const noise = new Float32Array(n);
    let sp = 0, np = 0;
    for (let i = 0; i < n; i++) { noise[i] = rng(); np += noise[i] ** 2; sp += x[i] ** 2; }
    const k = Math.sqrt(sp / np) / 10 ** (snr / 20);
    for (let i = 0; i < n; i++) x[i] += noise[i] * k;
  }
  return x;
}
// 缺失基频：只有 2f,3f,4f
function makeMissing(f, dur = 0.8) {
  const n = Math.floor(SR * dur);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = Math.sin(2 * Math.PI * 2 * f * t) + 0.8 * Math.sin(2 * Math.PI * 3 * f * t) + 0.6 * Math.sin(2 * Math.PI * 4 * f * t);
  }
  return x;
}

function maeOf(list, ref) {
  let s = 0, c = 0, g = 0;
  for (const v of list) {
    if (!Number.isFinite(v) || v <= 0) continue;
    const e = Math.abs(centsOf(v, ref)); s += e; c++; if (e > 600) g++;
  }
  return { mae: c ? s / c : NaN, octRate: c ? g / c : NaN };
}

console.log('引擎精度验证（dsp/core.mjs）\n');

const FREQS = [['G1', 49], ['C2', 65.41], ['E2', 82.41], ['C3', 130.81], ['A4', 440], ['C5', 523.25], ['C7', 2093], ['B7', 3951.07], ['D8', 4698.64]];
console.log('— 纯音 + 20dB噪声 —— 引擎A(峰追踪) / 引擎B(YIN) MAE(音分)');
for (const [name, f] of FREQS) {
  const x = makeTone(f, 0.6, { snr: 20 });
  const A = maeOf(peakTrack(x, SR).f, f);
  const B = maeOf(yin(x, SR).f, f);
  console.log(`  ${name.padEnd(3)} ${String(f).padStart(7)}Hz   A=${A.mae.toFixed(2)}  B=${B.mae.toFixed(2)}  ${A.octRate ? 'A八度误判!' : ''}${B.octRate ? ' B八度误判!' : ''}`);
}

console.log('\n— 缺失基频场景（引擎A死穴，B应接管）');
for (const [name, f] of [['A3', 220], ['A4', 440]]) {
  const x = makeMissing(f, 0.6);
  const A = maeOf(peakTrack(x, SR).f, f);
  const B = maeOf(yin(x, SR).f, f);
  console.log(`  ${name} ${f}Hz   A=${A.mae.toFixed(1)}¢ 八度误判${(A.octRate * 100).toFixed(0)}%   B=${B.mae.toFixed(2)}¢ 八度误判${(B.octRate * 100).toFixed(0)}%`);
}

// 融合：合成一条真实"人声式"含基频缺失的流，验证 fuse 后能出正确音高
console.log('\n— 融合仲裁 fusePoint（口哨场景一致→加权；缺失基频场景不一致→应偏向 B）');
{
  const f = 440;
  const xm = makeMissing(f, 0.6); // 缺失基频
  const a = peakTrack(xm, SR).f, b = yin(xm, SR).f;
  let fused = 0, nf = 0, correctA = 0, correctF = 0;
  for (let i = 0; i < a.length; i++) {
    const out = fusePoint(a[i], b[i]);
    if (Number.isFinite(out)) { fused++; if (Math.abs(centsOf(out, f)) < 50) correctF++; }
    if (Number.isFinite(a[i]) && Math.abs(centsOf(a[i], f)) < 50) correctA++;
  }
  console.log(`  缺失基频440Hz: 若只用A 正确帧=${correctA}/${a.length}; 融合后 正确帧=${correctF}/${nf + (fused || 1) ? fused : 1}  (共${a.length}帧，融合有效${fused}帧)`);
}

console.log('\n— 音名映射 freqToNote');
for (const f of [49, 65.41, 261.63, 440, 523.25, 3951.07]) {
  const n = freqToNote(f);
  console.log(`  ${String(f).padStart(8)}Hz -> ${n.name}${n.oct}  (cents ${n.cents.toFixed(1)}, midi ${n.midi})`);
}

console.log('\n— 周期强度 str（YIN cmMin 谷值, 越小越像有音高）——门控核心判据验证');
console.log('  目的：口哨/纯音 str 应低(强周期)；噪音/撞击/宽带 str 应高(弱周期)，据此滤噪音。');
function avgStr(x) {
  const r = yin(x, SR); let s = 0, c = 0;
  for (let i = 0; i < r.str.length; i++) if (Number.isFinite(r.f[i])) { s += r.str[i]; c++; }
  return c ? (s / c).toFixed(3) : 'N/A';
}
function makeNoise(dur = 0.6, seed = 1) { // 宽带白噪
  const n = Math.floor(SR * dur); const x = new Float32Array(n);
  let s = seed; const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1;
  for (let i = 0; i < n; i++) x[i] = rng();
  return x;
}
function makeImpulse(dur = 0.12) { // 模拟拍桌/响指的宽带撞击：指数衰减噪音(覆盖至少1个分析窗)
  const n = Math.floor(SR * dur); const x = new Float32Array(n);
  let s = 99; const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1;
  for (let i = 0; i < n; i++) x[i] = rng() * Math.exp(-i / (SR * 0.01));
  return x;
}
const strChecks = [
  ['纯音 440Hz', makeTone(440, 0.6)],
  ['口哨高音 2093Hz', makeTone(2093, 0.6)],
  ['带噪纯音 C5', makeTone(523.25, 0.6, { snr: 20 })],
  ['宽带白噪', makeNoise()],
  ['拍桌撞击', makeImpulse()],
];
for (const [name, x] of strChecks) console.log(`  ${name.padEnd(12)} str=${avgStr(x)}`);
console.log('  判读：口哨/带噪纯音应 <0.25；白噪/撞击应显著更高(>0.3)。');
// ── 低端端点 bin 的插值边界（2026-09-18 修，留个防回退断言）──
// peakTrack 的抛物线插值要读 best±1；mag 若只填 [kmin,kmax]，端点会读到从未赋值的 0
// → 40~45Hz 一律被推到 kmin+0.5 bin ≈ 48.4Hz（+130~330¢）；若此刻 YIN 也失效，
// fusePoint 会直接采纳它（实测 27.5Hz → 屏上显示 G）。这条是"端点"专案，别删。
console.log('\n— 低端端点插值（fmin=40 → kmin=4=43.07Hz，端点是历史 bug 高发区）');
{
  const rows = [41, 43, 44, 45].map((f) => {
    const got = peakTrack(makeTone(f, 0.6), SR).f[20] || NaN;
    return { f, got, cents: 1200 * Math.log2(got / f) };
  });
  for (const r of rows) console.log(`  ${r.f}Hz → A=${r.got.toFixed(2)}Hz (${r.cents.toFixed(0)}¢)`);
  const bad = rows.filter((r) => !(Math.abs(r.cents) <= 25));
  if (bad.length) {
    console.error('  FAIL 低端端点插值越界（旧实现会报到 ~48.4Hz）：' +
      bad.map((r) => r.f + 'Hz→' + r.got.toFixed(1) + 'Hz').join('，'));
    process.exit(1);
  }
  console.log('  ok  40~45Hz 未被推离端点 bin');
}

console.log('\n完成。');
