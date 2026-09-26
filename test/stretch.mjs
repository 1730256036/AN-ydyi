// ============================================================
// test/stretch.mjs —— dsp/stretch.mjs（变速不变调）特征测试
//
// 这是本仓库里少见的"新加了一段 DSP"的地方，所以断言要能真的兜住回归：
//   ① 原速必须逐位等同（不许留下任何处理痕迹）；
//   ② 时长按 rate 缩放（时间轴口径的根本约定）；
//   ③ 【核心】音高不动 —— 用项目自己的默认内核 YIN 去量拉伸后的信号。
//      这一条才是这个模块存在的理由：如果哪天有人图省事把实现换成重采样，
//      0.5× 的信号会被量成 110Hz(原 220Hz 的一半)，这一条立刻红。
//   ④ 静音不能被算出 NaN/爆音；输入数组不许被就地改写（它可能正被播放读着）。
// ============================================================
import { timeStretch } from '../dsp/stretch.mjs';
import { yinKernel } from '../dsp/kernels/yin.mjs';

const SR = 44100;
const N = 4096;
const CFG = { windowSize: N, fmin: 40, fmax: 8000, voicing: 85 };
let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

console.log('[stretch] 变速不变调（WSOLA 颗粒重排）');

const tone = (f, sec) => {
  const n = Math.round(SR * sec), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR);
  return x;
};
// 带泛音+极轻噪声：比纯正弦更像人声/口哨，用来验"非单频信号也不跑调"
const voiceish = (f, sec) => {
  const n = Math.round(SR * sec), x = new Float32Array(n);
  let sd = 7;
  const rnd = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = Math.sin(2 * Math.PI * f * t) + 0.45 * Math.sin(2 * Math.PI * 2 * f * t)
         + 0.22 * Math.sin(2 * Math.PI * 3 * f * t) + 0.02 * rnd();
  }
  return x;
};
/** 在 pcm 的 frac 处取一窗喂 YIN，返回估算基频 */
const measure = (pcm, frac = 0.5) => {
  const p = Math.max(0, Math.min(pcm.length - N, Math.round(pcm.length * frac) - (N >> 1)));
  return yinKernel.frame(pcm.subarray(p, p + N), SR, CFG).freq;
};

// ─────────── ① 原速：逐位等同 ───────────
{
  const x = voiceish(220, 0.5);
  const y = timeStretch(x, 1, SR);
  let same = y.length === x.length;
  if (same) for (let i = 0; i < x.length; i++) if (!Object.is(y[i], x[i])) { same = false; break; }
  ck('rate=1：长度不变且逐位等同（原速不许留任何处理痕迹）', same,
    `len ${y.length}/${x.length}`);
}

// ─────────── ② 时长按 rate 缩放 ───────────
{
  const x = tone(220, 1);
  for (const r of [0.25, 0.5, 0.75, 1.5, 2, 3, 4]) {
    const y = timeStretch(x, r, SR);
    const want = Math.round(x.length / r);
    ck(`rate=${r}×：输出长度 = 输入/${r}（±1 样点）`, Math.abs(y.length - want) <= 1,
      `${y.length} vs ${want}`);
  }
}

// ─────────── ③ 核心：音高不变（真回归防线）───────────
{
  for (const r of [0.25, 0.5, 0.75, 1.5, 2, 4]) {
    for (const f of [220, 440]) {
      const x = tone(f, 2);
      const y = timeStretch(x, r, SR);
      const got = measure(y);
      // 报错信息要把"重采样会是多少"写出来，方便一眼看出坏的根因
      ck(`rate=${r}× / ${f}Hz：拉伸后仍是 ${f}Hz（重采样会变成 ${Math.round(f / r)}Hz）`,
        Number.isFinite(got) && Math.abs(got - f) / f < 0.02, `实测 ${got && got.toFixed(1)}Hz`);
    }
  }
  // 整段前后各处都量一遍：接缝处的相似性对齐若出问题，会先在中段露出来
  {
    const x = voiceish(262, 2);
    const y = timeStretch(x, 0.5, SR);
    const got = [0.2, 0.4, 0.5, 0.6, 0.8].map((fr) => measure(y, fr));
    const ok = got.every((g) => Number.isFinite(g) && Math.abs(g - 262) / 262 < 0.03);
    ck('0.5× 拉伸后：全段 5 个位置的基频都还在 262Hz（接缝对齐没把波形搞坏）', ok,
      got.map((g) => (Number.isFinite(g) ? g.toFixed(1) : 'NaN')).join(' / '));
  }
}

// ─────────── ④ 静音 / 极短输入 ───────────
{
  const sil = new Float32Array(SR);            // 1s 全零
  const y = timeStretch(sil, 0.5, SR);
  let clean = true;
  for (let i = 0; i < y.length; i++) if (!Number.isFinite(y[i]) || Math.abs(y[i]) > 1e-6) { clean = false; break; }
  ck('静音拉伸后仍是干净的全零（归一化不会除出 NaN/爆音）', clean);
  ck('空数组不炸', timeStretch(new Float32Array(0), 2, SR).length === 0);
  ck('非法 rate 不炸（回退为原样拷贝）', timeStretch(sil, 0, SR).length === sil.length);
  const tiny = tone(440, 0.01);                // 不到一窗的输入
  const ty = timeStretch(tiny, 0.5, SR);
  let tinyClean = ty.length > 0;
  for (let i = 0; i < ty.length; i++) if (!Number.isFinite(ty[i])) { tinyClean = false; break; }
  ck('极短输入(不足一窗)不炸且不出 NaN', tinyClean, 'len=' + ty.length);
  // 逐长度扫 <16 样点：win 下限若取 16 会超过输入长度 → 粒内读到越界 → NaN 静默进缓冲。
  // 现实里不可达（16 样点=0.36ms），但这类"差一"一旦被别处调用就会变成爆音。
  let shortBad = '';
  for (const n of [1, 2, 5, 10, 15, 16]) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 440 * i / SR);
    const y2 = timeStretch(x, 0.5, SR);
    for (let i = 0; i < y2.length; i++) if (!Number.isFinite(y2[i])) { shortBad = n + ' 样点'; break; }
    if (shortBad) break;
  }
  ck('★1~16 样点的极短输入都不出 NaN（窗长小于下限时的退化路径）', !shortBad, shortBad);
}

// ─────────── ⑤ 不许就地改写输入（调用方可能正拿它播放）───────────
{
  const x = voiceish(330, 0.6);
  const copy = Float32Array.from(x);
  timeStretch(x, 0.5, SR);
  let untouched = true;
  for (let i = 0; i < x.length; i++) if (!Object.is(x[i], copy[i])) { untouched = false; break; }
  ck('输入数组未被就地修改', untouched);
}

// ─────────── ⑥ 幅度量级合理（不是"音高对了但整段哑掉"）───────────
{
  const x = tone(440, 1);
  const y = timeStretch(x, 0.5, SR);
  let peak = 0, sum = 0;
  for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > peak) peak = a; sum += a * a; }
  const rms = Math.sqrt(sum / y.length);
  ck('0.5× 拉伸后峰值仍在 1 附近（Hann 交叠相加的电平没塌）', peak > 0.9 && peak < 1.1, `peak=${peak.toFixed(3)}`);
  ck('0.5× 拉伸后 RMS 仍在 0.7 附近（正弦 RMS=0.707）', Math.abs(rms - 0.707) < 0.05, `rms=${rms.toFixed(3)}`);
}

console.log(`[stretch] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
