// ============================================================
// test/echo-hmm.mjs —— `'hmm'` 档守卫（app/echo.mjs 的第三条分支）
//
// 为什么单独一个文件：grain / classic 的既有行为由 test/echo.mjs 守着（那份一行未动）。
// 本文件只守**新增的 hmm 档** + 它与另两档的**隔离性**——硬性要求：
// 「做的始终只针对钢琴块中的回声这一块，其他方面绝不能受到任何影响，
//   包括回声算法里的颗粒和经典这俩」。
//
// 覆盖：
//   A 在线解码器（dsp/notes-hmm.mjs createOnlineNotes）：收敛即输出 / 滞后 / open 报告 / reset
//   B hmm 档回声链路：三音单吐 → 3 个块、音高正确、块结构与 echoNotes 同构
//   C 隔离性：hmm ↔ grain 换档不串味；同素材下 grain 仍走原语义（hmm 不影响它）
//   D 边界：未开回声 / 非录音态 / 非 live 帧 → hmm 档不产块
// ============================================================
import { createOnlineNotes } from '../dsp/notes-hmm.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

function fakeLS(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
let seq = 0;
async function fresh(lsInit) {
  globalThis.localStorage = fakeLS(lsInit);
  return await import(new URL('../app/echo.mjs?h=' + (++seq), import.meta.url).href);
}
const FR = 16.7;
const frame = (t, midi, extra) => Object.assign({ live: true, audioMs: t, voiced: true, midi }, extra);
const quiet = (t) => ({ live: true, audioMs: t, voiced: false, midi: NaN });
const midis = (a) => a.map((n) => n.midi);

function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
// 造实时帧序列：[{t, midi, voiced}]（含帧级抖动，模拟真实检测输出）
function timeline(plan, { jitter = 0.1, seed = 11 } = {}) {
  const r = rng(seed), out = [];
  let t = 0;
  for (const seg of plan) {
    const n = Math.max(1, Math.round(seg.ms / FR));
    for (let k = 0; k < n; k++) {
      // ⚠ 两种消费方式都要满足：createOnlineNotes 读帧的 t，echoFeed 读 live/voiced/audioMs
      if (seg.rest) out.push(Object.assign(quiet(t), { t }));
      else out.push(Object.assign(frame(t, seg.midi + (r() - 0.5) * 2 * jitter), { t }));
      t = +(t + FR).toFixed(2);
    }
  }
  return out;
}

console.log('[echo-hmm] hmm 档守卫');

// ─────────── A. 在线解码器（纯逻辑） ───────────
{
  const f = [
    { t: 0, midi: 69, voiced: true, str: 0.02 }, { t: 16.7, midi: 69.1, voiced: true, str: 0.02 },
  ];
  const on = createOnlineNotes({ lagMs: 200 });
  on.push({ t: 0, midi: 69, voiced: true, str: 0.02 });
  ck('A 缓冲不足 6 帧时不输出', on.push({ t: 16.7, midi: 69, voiced: true, str: 0.02 }).settled.length === 0);
  ck('A 缓冲长度可读', on.bufferLen === 2, String(on.bufferLen));
  on.reset();
  ck('A reset 清空缓冲', on.bufferLen === 0);
  ck('A reset 后 emittedUntil 复位', on.emittedUntil === -Infinity, String(on.emittedUntil));
}
{
  const plan = [
    { midi: 69, ms: 300 }, { rest: true, ms: 300 },
    { midi: 72, ms: 300 }, { rest: true, ms: 600 },
  ];
  const tl = timeline(plan);
  const on = createOnlineNotes({ lagMs: 200 });
  const settled = [];
  let openAt9 = null, firstSettledT = -1;
  for (let i = 0; i < tl.length; i++) {
    const r = on.push(tl[i]);
    for (const n of r.settled) settled.push(n);
    if (i === 9 && r.open) openAt9 = r.open.midi;         // 第 10 帧：正在吹第一个音
    if (settled.length && firstSettledT < 0) firstSettledT = tl[i].t;
  }
  ck('A 两个音最终都输出（中间有 300ms 静音）', JSON.stringify(midis(settled)) === JSON.stringify([69, 72]),
    JSON.stringify(midis(settled)));
  ck('A 进行中的音符被报告为 open', openAt9 === 69, String(openAt9));
  ck('A 首块出现有滞后（不是一开始就出）', firstSettledT > 300, `t=${firstSettledT}`);
  ck('A 输出按时间单调不回退', settled.every((n, i) => i === 0 || n.t0 >= settled[i - 1].t0));
  ck('A 滞后参数生效：lagMs 更大 → 首块更晚',
    (() => {
      const o2 = createOnlineNotes({ lagMs: 600 });
      let t2 = -1;
      for (const fr of tl) { const r = o2.push(fr); if (r.settled.length && t2 < 0) t2 = fr.t; }
      return t2 > firstSettledT;
    })());
}

// ─────────── B. hmm 档回声链路：三音单吐 ───────────
const TRIPLE = [
  { midi: 69, ms: 250 }, { rest: true, ms: 60 },
  { midi: 72, ms: 250 }, { rest: true, ms: 60 },
  { midi: 74, ms: 250 }, { rest: true, ms: 800 },
];
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline(TRIPLE)) m.echoFeed(Object.assign({}, fr, { segAlgo: 'hmm' }));
  ck('B 三音单吐 → 3 个块', m.echoNotes.length === 3, String(m.echoNotes.length));
  ck('B 块音高正确', JSON.stringify(midis(m.echoNotes)) === JSON.stringify([69, 72, 74]),
    JSON.stringify(midis(m.echoNotes)));
  ck('B 块结构 = {t0,t1,midi}（与另两档同构）',
    m.echoNotes.every((n) => Number.isFinite(n.t0) && Number.isFinite(n.t1) && Number.isInteger(n.midi)));
  ck('B t0 = 音频域起点 + fallMs(4200)', m.echoNotes[0].t0 >= 4200, String(m.echoNotes[0].t0));
  ck('B 块按时间有序且 t1 > t0', m.echoNotes.every((n, i) => n.t1 > n.t0 && (i === 0 || n.t0 >= m.echoNotes[i - 1].t0)),
    JSON.stringify(m.echoNotes.map((n) => [Math.round(n.t0), Math.round(n.t1), n.midi])));
}

// ─────────── C. 隔离性：hmm 与 grain 互不影响 ───────────
{
  // C1 同一实例内换档：先 hmm 再 grain，grain 仍按原语义出块（不被 hmm 状态污染）
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline(TRIPLE)) m.echoFeed(Object.assign({}, fr, { segAlgo: 'hmm' }));
  const hmmCount = m.echoNotes.length;
  m.echoFeed(frame(99999, 69, { segAlgo: 'grain' }));      // 换档
  ck('C1 换档不追加/不残留 hmm 块（清掉 hmm 状态后 grain 自己那套照旧）',
    m.echoNotes.length === hmmCount, `${hmmCount} → ${m.echoNotes.length}`);

  const m2 = await fresh({ ydyi_echo: '1' });
  m2.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline(TRIPLE)) m2.echoFeed(Object.assign({}, fr, { segAlgo: 'grain' }));
  ck('C1 grain 档在同一素材上照常出块（未被新增档影响）', m2.echoNotes.length > 0, String(m2.echoNotes.length));
  ck('C1 grain 的音高也正确',
    JSON.stringify(midis(m2.echoNotes)) === JSON.stringify([69, 72, 74]), JSON.stringify(midis(m2.echoNotes)));

  // C2 档位白名单：未知档仍回退 grain（老行为不变）
  const m3 = await fresh({ ydyi_echo: '1' });
  m3.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline([{ midi: 69, ms: 300 }, { rest: true, ms: 300 }]))
    m3.echoFeed(Object.assign({}, fr, { segAlgo: 'nonsense' }));
  ck('C2 未知档位回退 grain 并照常出块', m3.echoNotes.length === 1, String(m3.echoNotes.length));

  // C3 hmm 档不写入 grain/classic 的状态量（隔着跑互不串味）
  const a = await fresh({ ydyi_echo: '1' });
  a.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline(TRIPLE)) a.echoFeed(Object.assign({}, fr, { segAlgo: 'classic' }));
  const classicOnly = midis(a.echoNotes);
  const b = await fresh({ ydyi_echo: '1' });
  b.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline(TRIPLE)) b.echoFeed(Object.assign({}, fr, { segAlgo: 'hmm' }));
  for (const fr of timeline(TRIPLE)) b.echoFeed(Object.assign({}, fr, { segAlgo: 'classic', resetKey: 'r2' }));
  ck('C3 实例内先后跑 hmm 与 classic，classic 结果与单独跑一致',
    JSON.stringify(midis(b.echoNotes)) === JSON.stringify(classicOnly),
    `${JSON.stringify(classicOnly)} vs ${JSON.stringify(midis(b.echoNotes))}`);
}

// ─────────── D. 边界：不满足前置条件时 hmm 档不产块 ───────────
{
  const m = await fresh({});                                     // 未开回声
  m.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline(TRIPLE)) m.echoFeed(Object.assign({}, fr, { segAlgo: 'hmm' }));
  ck('D 未开回声 → 不产块', m.echoNotes.length === 0, String(m.echoNotes.length));

  const m2 = await fresh({ ydyi_echo: '1' });
  m2.configureEcho({ getRecState: () => 'idle' });                // 非录音态
  for (const fr of timeline(TRIPLE)) m2.echoFeed(Object.assign({}, fr, { segAlgo: 'hmm' }));
  ck('D 非录音态 → 不产块', m2.echoNotes.length === 0, String(m2.echoNotes.length));

  const m3 = await fresh({ ydyi_echo: '1' });
  m3.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline(TRIPLE)) {
    const bad = Object.assign({}, fr, { segAlgo: 'hmm', live: false });    // 非 live
    m3.echoFeed(bad);
  }
  ck('D 非 live 帧 → 不产块', m3.echoNotes.length === 0, String(m3.echoNotes.length));

  const m4 = await fresh({ ydyi_echo: '1' });
  m4.configureEcho({ getRecState: () => 'rec' });
  for (const fr of timeline([{ rest: true, ms: 600 }])) m4.echoFeed(Object.assign({}, fr, { segAlgo: 'hmm' }));
  ck('D 全静音 → 不产块', m4.echoNotes.length === 0, String(m4.echoNotes.length));
}

// ─────────── E. env 气口驱动：同音快吐在回声链路上各自成块 ───────────
// 这是本轮的核心能力（真机实测：6 段真实录音里同音快吐/快速吐音都被 grain 糊成长块）。
// env 必须带真实成分：谷底有 ±1~2dB 逐点抖动 —— 正是这个抖动让 grain 那套
// 「相邻爬坡峰」深度口径退化失效（所以 grain 在此素材上仍会糊，hmm 才能分开）。
{
  const FR2 = 16.7;
  const frames = [], segs = [];
  let t = 0;
  for (let i = 0; i < 6; i++) {
    const t0 = t;
    for (let k = 0; k < 6; k++) { frames.push(Object.assign(frame(t, 69), { t })); t = +(t + FR2).toFixed(2); }
    segs.push([t0 + 2, t - 2]);
    for (let k = 0; k < 2; k++) { frames.push(Object.assign(quiet(t), { t })); t = +(t + FR2).toFixed(2); }
  }
  for (let k = 0; k < 60; k++) { frames.push(Object.assign(quiet(t), { t })); t = +(t + FR2).toFixed(2); }  // 尾巴：让最后一块能定案
  let sd = 7;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
  const env = [];
  for (let e = 0; e <= t + 400; e += 5.8) {
    const base = segs.some(([a, b]) => e >= a && e <= b) ? 0.30 : 0.012;
    env.push({ t: Math.round(e), rms: base * (1 + rnd() * 0.2) });     // ±1dB 抖动（真实形态）
  }
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  for (const fr of frames) m.echoFeed(Object.assign({}, fr, { segAlgo: 'hmm', env, resetKey: 'e' }));
  ck('E 同音快吐 6 音（env 气口）→ 6 个块', m.echoNotes.length === 6,
    String(m.echoNotes.length) + ' ' + JSON.stringify(m.echoNotes.map((n) => [Math.round(n.t0), Math.round(n.t1), n.midi])));
  ck('E 块按时间单调且互不重叠', m.echoNotes.every((n, i) => i === 0 || n.t0 >= m.echoNotes[i - 1].t1),
    JSON.stringify(m.echoNotes.map((n) => [Math.round(n.t0), Math.round(n.t1)])));
  ck('E 音高全为 69（同音快吐不串音）', m.echoNotes.every((n) => n.midi === 69));

  const m2 = await fresh({ ydyi_echo: '1' });
  m2.configureEcho({ getRecState: () => 'rec' });
  for (const fr of frames) m2.echoFeed(Object.assign({}, fr, { segAlgo: 'grain', env, resetKey: 'e' }));
  ck('E 对照：grain 档同素材明显更少块（hmm 的增益来自 env 气口维度）',
    m2.echoNotes.length < m.echoNotes.length, `grain=${m2.echoNotes.length} vs hmm=${m.echoNotes.length}`);
}

console.log(`[echo-hmm] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
