// 内核等价性验证：证明把原内联的 peakTrack/yin/fusePoint 组合抽进
// dsp/kernels/yin.mjs 后，产出与原实现逐位一致（含 NaN）。
//
// 做法：对同一批信号窗，对比两条路线——
//   参考线：直接 import core.mjs 的 peakTrack/yin/fusePoint 按 detect.mjs 原内联逻辑取数
//   内核线：yinKernel.frame(win, sr, cfg)
// 逐字段(fA/prom/purity/fB/str/freq)用 Object.is 严格全等比对。
// 再驱动 createDetector 走内核跑门控端到端，断言判分与改造前期望一致。
import { peakTrack, yin, fusePoint, centsOf } from '../dsp/core.mjs';
import { yinKernel } from '../dsp/kernels/yin.mjs';
import { createDetector } from '../dsp/detect.mjs';

const SR = 44100, N = 4096;
const CFG = { windowSize: N, fmin: 40, fmax: 8000, voicing: 85 };

// ---- 原内联逻辑的忠实复刻（改造前的参考实现）----
function legacyFrame(win, sr, cfg) {
  const NN = cfg.windowSize, fmin = cfg.fmin, fmax = cfg.fmax;
  const ra = peakTrack(win, sr, { windowSize: NN, hopSize: NN, fmin, fmax });
  const fA = ra.f.length ? ra.f[0] : NaN;
  const prom = ra.prom.length ? ra.prom[0] : 0;
  const purity = (ra.purity && ra.purity.length) ? ra.purity[0] : 0;
  const rb = yin(win, sr, {
    windowSize: NN, hopSize: NN, fmin, fmax, threshold: 1 - cfg.voicing / 100,
  });
  const fB = rb.f.length ? rb.f[0] : NaN;
  const str = (rb.str && rb.str.length) ? Math.min(1, Math.max(0, rb.str[0])) : 1;
  return { freq: fusePoint(fA, fB), prom, purity, str, fA, fB };
}

const FIELDS = ['freq', 'prom', 'purity', 'str', 'fA', 'fB'];

// ---- 合成信号（与 test/gate-sim.mjs 同款）----
function tone(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR); return x; }
function toneNoisy(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let sd = 7; const rng = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR) + 0.08 * rng(); return x; }
function impulse(sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let sd = 99; const rng = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = rng() * Math.exp(-i / (SR * 0.012)); return x; }
function missing(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * 2 * f * t) + 0.8 * Math.sin(2 * Math.PI * 3 * f * t) + 0.6 * Math.sin(2 * Math.PI * 4 * f * t); } return x; }

function windows(x) { const w = []; for (let p = 0; p + N <= x.length; p += N) w.push(x.subarray(p, p + N)); return w; }

let bad = 0, total = 0;
function eq(a, b, f) {
  if (!Object.is(a, b)) { bad++; console.log(`  ✗ ${f}: 内核=${a} 参考=${b} ${(a - b)}`); }
}

console.log('内核逐字段等价性（yinKernel.frame vs 原内联逻辑）\n');
for (const [name, x] of [
  ['口哨C5(带气声)', toneNoisy(523.25, 2.0)],
  ['口哨B6 纯', tone(1975.5, 1.5)],
  ['缺失基频440', missing(440, 1.0)],
  ['拍桌撞击', impulse(0.5)],
  ['低音C2', tone(65.41, 1.5)],
  ['高音B7', tone(3951.07, 1.0)],
]) {
  const wins = windows(x);
  total += wins.length;
  for (const w of wins) {
    const k = yinKernel.frame(w, SR, CFG);
    const r = legacyFrame(w, SR, CFG);
    for (const f of FIELDS) eq(k[f], r[f], f);
  }
  console.log(`  ${name.padEnd(14)} ${wins.length} 窗比对完成`);
}
if (bad) { console.log(`\n失败：${bad}/${total * FIELDS.length} 字段不一致`); process.exit(1); }
console.log(`\nOK：全部 ${total} 窗 × ${FIELDS.length} 字段逐位一致\n`);

// ---- 端到端：走 createDetector(默认内核) 门控判定应与改造前期望一致 ----
console.log('端到端门控（createDetector 走默认 yin 内核）');
function gateRatio(x) {
  const det = createDetector({ sampleRate: SR, fmin: 40, fmax: 8000, windowSize: N, voicing: 85, sens: 70 });
  det.setEnergy({ mode: 'auto', envRms: 0.002 });
  let voiceFrames = 0; const wins = windows(x);
  for (const w of wins) if (det.processWindow(w).voiced) voiceFrames++;
  return voiceFrames / wins.length;
}
const rWhistle = gateRatio(toneNoisy(523.25, 2.0));
const rImpulse = gateRatio(impulse(0.5));
const okW = rWhistle > 0.5, okI = rImpulse === 0;
console.log(`  口哨C5(带气声) 发声帧占比 ${(rWhistle * 100).toFixed(0)}%  ${okW ? '✓' : '✗'}（期望 >50%）`);
console.log(`  拍桌撞击      发声帧占比 ${(rImpulse * 100).toFixed(0)}%  ${okI ? '✓' : '✗'}（期望 =0）`);
if (!(okW && okI)) { console.log('\n门控判定偏离预期'); process.exit(1); }
// ---- 默认内核禁止降采样（decim 必须为 1，2026-09-20 真机取证后定案）----
// 现象：快吹"高低高低"的曲线上，默认内核(then decim=2)有一帧 23ms 的滞后，pyin/mpm 没有。
// 根因（不是频率算错）：换音的交界帧上 decim=2 的 cm 谷值 str=0.233、全速率 0.210，而
// sens70 的门限 strMax=0.219 → 该帧被判"品质不达标" → detect 的「跳变需连续两帧确认」
// 晚一拍启动 → 曲线上多留一帧旧音。详见 dsp/core.mjs yin() 顶部注释。
// 本段锁两件事：① 默认 yin() 与显式 decim:1 逐位一致；② 这组用例确实对 decim 敏感
// （否则守卫是空的——实测每个用例的 str 全帧不同，故必然敏感）。
console.log('\n默认内核禁止降采样（decim 必须为 1）');
{
  const fastAlt = (sec, dur, hi, lo) => {
    const n = Math.floor(SR * sec), x = new Float32Array(n);
    let sd = 3; const rng = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1;
    for (let i = 0; i < n; i++) {
      const seg = Math.floor(i / (SR * dur));
      x[i] = Math.sin(2 * Math.PI * ((seg % 2) ? hi : lo) * i / SR) + 0.05 * rng();
    }
    return x;
  };
  const W = { windowSize: N, hopSize: N, fmin: 40, fmax: 8000, threshold: 0.15 };
  const CASES = [
    ['带噪口哨C5', toneNoisy(523.25, 0.6)],
    ['高音B7', tone(3951.07, 0.6)],
    ['低音C2', tone(65.41, 0.6)],
    ['快换音100ms', fastAlt(0.6, 0.10, 2000, 1400)],
  ];
  let mismatch = 0, sensitive = 0;
  for (const [nm, x] of CASES) {
    const a = yin(x, SR, W);
    const b = yin(x, SR, { ...W, decim: 1 });
    const c = yin(x, SR, { ...W, decim: 2 });
    let same = true, diff = false, maxC = 0;
    for (let i = 0; i < a.f.length; i++) {
      if (!Object.is(a.f[i], b.f[i]) || !Object.is(a.str[i], b.str[i])) same = false;
      if (!Object.is(a.f[i], c.f[i]) || !Object.is(a.str[i], c.str[i])) diff = true;
      if (a.f[i] > 0 && c.f[i] > 0) maxC = Math.max(maxC, Math.abs(centsOf(a.f[i], c.f[i])));
    }
    if (!same) mismatch++;
    if (diff) sensitive++;
    console.log(`  ${nm.padEnd(12)} 默认≡decim1 ${same ? '✓' : '✗'}   对 decim 敏感 ${diff ? '✓' : '✗'}${diff ? `(与 decim2 最大差 ${maxC.toFixed(0)}¢)` : ''}`);
  }
  if (mismatch) { console.log('\n✗ 默认 yin() 与 decim:1 不再逐位一致——有人把默认改回降采样了？'); process.exit(1); }
  if (!sensitive) { console.log('\n✗ 全部用例对 decim 都不敏感：这组守卫是空的，必须换用例'); process.exit(1); }
  console.log(`  ok 默认 = 全速率，且 ${sensitive}/${CASES.length} 个用例能暴露 decim 差异（守卫非空）`);
}

console.log('\n完成。内核封装与门控行为均符合预期。');