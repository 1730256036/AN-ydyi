// ============================================================
// test/anim-smoke.mjs —— 动画模板冒烟测试（node 直跑，不开浏览器/不起服务）
//
// 目的：模板改造后最容易出的错是"某个 ctx 方法名写错 / 某字段 undefined 参与
// 运算 / 换尺寸后除零"，这些在浏览器里表现为整块黑屏且控制台只报一行。
// 这里用打桩 2D context 把每个整块画布模板在【合成音频数据】上跑满：
//   - 四种画布尺寸（含极窄/极矮，逼出布局除零）
//   - 五种状态：空闲 / 运行但静音 / 发声中(含谐波峰) / 极低音 / 极高音 / 换片段(resetKey)
//   - 长跑 1084 帧，覆盖环形缓冲、峰值保持、热力图累积等状态机路径
// 只验证"不抛异常 + 关键纯函数数值正确"，不做像素断言（像素得靠人眼）。
//
// 另断言"一帧跑完绘图状态原样归还"：画布 2D 上下文是全模板共享的同一个对象，
// 任何模板泄漏 textAlign/globalAlpha/虚线都会静默影响别的模板（如 pitchTrail 的缩放贴图）。
// ============================================================
import { existsSync } from 'node:fs';
import { promNorm, PROM_LO, PROM_HI } from '../anim/viz-common.mjs';

// ---------- 打桩：2D context ----------
// 关键：真的维护绘图状态栈（save 压栈 / restore 出栈），这样才能断言
// "模板跑完一帧后没有把 textAlign/globalAlpha/虚线等状态泄漏给别的模板"——
// 画布 2D 上下文是全模板共享的同一个对象，泄漏会静默影响 pitchTrail 等未改动模板。
let W0 = 800, H0 = 500;
const DEFAULTS = {
  fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  globalAlpha: 1, globalCompositeOperation: 'source-over',
  textAlign: 'start', textBaseline: 'alphabetic', font: '10px sans-serif',
  imageSmoothingEnabled: true, miterLimit: 10, lineDashOffset: 0, shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)', lineDash: [],
};
const STATE_KEYS = Object.keys(DEFAULTS);
function makeCtx() {
  const state = { ...DEFAULTS, lineDash: [] };
  const stack = [];
  // 调用计数 + 绘制签名：用于观测"某一帧到底画了什么"。
  // 签名 = 所有 fillRect/arc/moveTo/lineTo/fillText 坐标的滚动哈希；相邻帧签名相同
  // ⇔ 画面逐像素一致（用于断言"暂停后必须静止"）。只在 __recOn() 后记录，避免拖慢其他用例。
  // texts：记住每帧画过的文字，供"画布内的界面角标该不该出现"这类断言使用（只留最近 40 条）
  const calls = { arc: 0, fillText: 0, fill: 0, stroke: 0, sig: 0, n: 0, texts: [], arcs: [] };
  const rec = { on: false };
  const acc = (a, b) => { calls.sig = (calls.sig * 31 + a + b * 7) | 0; calls.n++; };
  const api = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    measureText: () => ({ width: 12 }),
    save() { stack.push({ ...state, lineDash: state.lineDash.slice() }); },
    restore() { const s = stack.pop(); if (s) Object.assign(state, s); },
    setLineDash(a) { state.lineDash = Array.from(a || []); },
    putImageData() {}, drawImage() {}, strokeText() {},
    beginPath() {}, closePath() {}, rect() {}, roundRect() {},
    moveTo(x, y) { if (rec.on) acc(x * 4, y * 4); },
    lineTo(x, y) { if (rec.on) acc(x * 4, y * 4); },
    arc(x, y, r) { if (rec.on) acc(x * 4 + r, y * 4); calls.arc++; calls.arcs.push({ x, y }); if (calls.arcs.length > 8) calls.arcs.shift(); },
    arcTo() {}, ellipse() {},
    fill() { calls.fill++; }, stroke() { calls.stroke++; },
    fillText(t, x, y) {
      if (rec.on) acc(x * 4, y * 4);
      calls.fillText++;
      calls.texts.push(String(t));
      if (calls.texts.length > 40) calls.texts.shift();
    },
    fillRect(x, y, w, h) { if (rec.on) acc(x * 4 + w, y * 4 + h); },
    strokeRect() {}, clearRect() {}, clip() {}, translate() {}, rotate() {},
    scale() {}, transform() {}, setTransform() {}, resetTransform() {},
    quadraticCurveTo() {}, bezierCurveTo() {},
    __recOn() { rec.on = true; calls.sig = 0; calls.n = 0; },
    __recOff() { rec.on = false; },
    __recSig() { return { sig: calls.sig, n: calls.n }; },
  };
  return new Proxy(api, {
    get(t, p) {
      if (p === '__state') return state;
      if (p === '__calls') return calls;
      if (p in t) return t[p];
      if (p in state) return state[p];
      return () => {};
    },
    set(t, p, v) { if (p in t) t[p] = v; else state[p] = v; return true; },
  });
}
globalThis.document = {
  createElement: (tag) => {
    const el = { width: W0, height: H0, style: {}, tagName: tag };
    el.getContext = () => makeCtx();
    return el;
  },
  querySelector: () => null,
};
globalThis.window = globalThis;
globalThis.performance = { now: () => Date.now() };

// 比较绘图状态，返回泄漏的字段名数组
function stateLeaks(ctx, baseline) {
  const bad = [];
  for (const k of STATE_KEYS) {
    const a = ctx.__state[k], b = baseline[k];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(k);
    } else if (a !== b) bad.push(k);
  }
  return bad;
}

// ---------- 合成数据 ----------
const SR = 44100, FMAX = SR / 2, NBINS = 2049;
const spec = new Float32Array(NBINS);
const wave = new Float32Array(4096);
const silentWave = new Float32Array(4096);

function fillSpectrum(freq, amp) {
  spec.fill(0.18);                                   // 底噪
  if (!(freq > 0)) return;
  for (let k = 1; k <= 8; k++) {                     // 基频 + 谐波峰
    const i = Math.round((freq * k / FMAX) * (NBINS - 1));
    if (i < NBINS) spec[i] = amp / Math.sqrt(k);
  }
}
function fillSine(freq, amp) {
  if (!(freq > 0)) { wave.fill(0); return; }
  for (let i = 0; i < wave.length; i++) wave[i] = amp * Math.sin(2 * Math.PI * freq * i / SR);
}

function snap(o = {}) {
  const freq = o.freq ?? NaN;
  const voiced = !!(freq > 0) && o.voiced !== false;
  const midi = freq > 0 ? 69 + 12 * Math.log2(freq / 440) : NaN;
  const cents = Number.isFinite(midi) ? (midi - Math.round(midi)) * 100 : 0;
  return {
    voiced, freq,
    midi, note: '--', cents, hz: freq,
    prom: o.prom ?? 22, rms: o.rms ?? 0.05, purity: 0.7, str: 0.12,
    spectrum: o.spectrum !== undefined ? o.spectrum : spec,
    specBins: NBINS, specFmax: FMAX,
    waveform: o.waveform !== undefined ? o.waveform : wave,
    seenAny: !!o.seenAny, statsMin: o.statsMin ?? NaN, statsMax: o.statsMax ?? NaN,
    lastGoodFreq: freq > 0 ? freq : NaN,
    freqRaw: freq,
    // 音频是否真的在流：默认 true；暂停/停止/播完由 app.mjs snapshot() 传 false，
    // 模板据此冻结画面（不再推进时间轴、不再衰减动画）
    live: o.live !== false,
    // ⚠ 桩是白名单式构造：快照新增字段必须同步补这里，漏列 = 静默丢弃，
    //   模板那边表现为"参数永远是 undefined、改了没反应"（2026-09-20 踩过）。
    audioMs: o.audioMs ?? 1000,
    resetKey: o.resetKey ?? 1,
    midiNotes: o.midiNotes ?? null, env: null, projMode: false, projFrames: null,
    liveRecActive: false,
  };
}

// 工程/MIDI 音符表（钢琴块下落块 + 珠链拖尾走这条路径）
const MIDI_NOTES = (() => {
  const a = [];
  for (let i = 0; i < 60; i++) {
    const t0 = i * 120, t1 = t0 + 90;
    a.push({ t0, t1, midi: 48 + ((i * 7) % 36) });
  }
  return a;
})();

// ---------- 断言 ----------
let fail = 0;
const ok = (name, cond) => { if (cond) console.log('✓ ' + name); else { console.error('✗ ' + name); fail++; } };
const eq = (name, got, want, tol = 1e-6) => ok(name + ' (' + got + ')', Math.abs(got - want) <= tol);

// ---------- 纯函数：viz-common ----------
const C = await import('../anim/viz-common.mjs');
eq('midiOf(440)=69', C.midiOf(440), 69);
eq('freqOfMidi(69)=440', C.freqOfMidi(69), 440);
eq('midiOf(261.626)≈C4', C.midiOf(261.6256), 60, 1e-3);
eq('noteName(60)=C4', C.noteName(60) === 'C4' ? 1 : 0, 1);
eq('noteName(70)=A#4', C.noteName(70) === 'A#4' ? 1 : 0, 1);
eq('pclassOf(-1)=11', C.pclassOf(-1), 11);
eq('pcHue(1)=30', C.pcHue(1), 30);
ok('isBlackMidi(61)=true', C.isBlackMidi(61) === true);
ok('isBlackMidi(60)=false', C.isBlackMidi(60) === false);
eq('clamp01(-3)=0', C.clamp01(-3), 0);
eq('clamp01(9)=1', C.clamp01(9), 1);

// 帧率无关逼近
eq('approach 用一半时间走 ~63%', C.approach(0, 1, 1, Math.LN2), 0.5, 1e-9);

// ---------- 跟音练习：纯函数(评分/中位数/选题) ----------
const P = await import('../anim/practice.mjs');
eq('gradeCents(+8)=优', P.gradeCents(8).label === '优' ? 1 : 0, 1);
eq('gradeCents(-10)=优', P.gradeCents(-10).label === '优' ? 1 : 0, 1);
eq('gradeCents(+24)=良', P.gradeCents(24).label === '良' ? 1 : 0, 1);
eq('gradeCents(-49)=合格', P.gradeCents(-49).label === '合格' ? 1 : 0, 1);
eq('gradeCents(+51)=跑调', P.gradeCents(51).label === '跑调' ? 1 : 0, 1);
eq('median([3,1,2])=2', P.median([3, 1, 2]), 2);
eq('median([4,1,3,2])=2.5', P.median([4, 1, 3, 2]), 2.5);
ok('median([])=NaN', Number.isNaN(P.median([])));
ok('pickNext scale 从 lo 起', P.pickNext('scale', 60, 72, null) === 60);
ok('pickNext scale 上行', P.pickNext('scale', 60, 72, 65) === 66);
ok('pickNext scale 到顶回卷', P.pickNext('scale', 60, 72, 72) === 60);
{
  let okRnd = true;
  for (let i = 0; i < 50; i++) {
    const m = P.pickNext('random', 60, 72, 66);
    if (m < 60 || m > 72) okRnd = false;                    // 必在音域内
  }
  ok('pickNext random 恒在音域内', okRnd);
}


// ---------- 模板：整状态长跑 ----------
let midiTick = 0;   // 工程用例让 audioMs 逐帧推进(真实播放就是这样)，否则活跃键永不变化
const CASES = [
  { name: '空闲(无音频)', d: () => snap({ freq: NaN, spectrum: null, waveform: silentWave }) },  { name: '运行·静音底噪', d: () => { fillSpectrum(NaN); return snap({ freq: NaN }); } },
  { name: '发声 C5(523.25Hz)', d: () => { fillSpectrum(523.25, 0.95); fillSine(523.25, 0.35); return snap({ freq: 523.25, seenAny: true, statsMin: 523.25, statsMax: 523.25 }); } },
  { name: '发声 A2 极低音(110Hz)', d: () => { fillSpectrum(110, 0.8); fillSine(110, 0.3); return snap({ freq: 110, seenAny: true, statsMin: 110, statsMax: 523 }); } },
  { name: '发声 C7 极高音(2093Hz)', d: () => { fillSpectrum(2093, 0.7); fillSine(2093, 0.2); return snap({ freq: 2093, seenAny: true, statsMin: 110, statsMax: 2093 }); } },
  { name: '工程/MIDI 下落块+珠链', d: () => { fillSpectrum(523.25, 0.8); fillSine(523.25, 0.3); return snap({ freq: 523.25, seenAny: true, statsMin: 130, statsMax: 900, midiNotes: MIDI_NOTES, audioMs: 300 + ((midiTick++ * 16.7) % 3200) }); } },
];
const SIZES = [[800, 500], [320, 240], [1920, 1080], [1400, 220]];

// ---------- 自检：泄漏检测本身必须有效（否则"未泄漏"是假通过） ----------
{
  const c = makeCtx();
  const b = { ...c.__state, lineDash: c.__state.lineDash.slice() };
  c.save(); c.textAlign = 'center'; c.setLineDash([4, 4]); c.restore();
  ok('泄漏检测自检：save/restore 包住 → 判无泄漏', stateLeaks(c, b).length === 0);
  const c2 = makeCtx();
  const b2 = { ...c2.__state, lineDash: c2.__state.lineDash.slice() };
  c2.textAlign = 'center'; c2.setLineDash([4, 4]); c2.globalAlpha = 0.5;
  ok('泄漏检测自检：裸改状态 → 能抓到泄漏', stateLeaks(c2, b2).length >= 3);
}

// pianoBlocks 也纳入驱动：它是全项目最大、特效层最厚的文件，
// 只"加载不驱动"等于零覆盖（2026-09-12 加特效层时补上）
const TPL = ['pitchOrb', 'pianoBlocks'];
for (const id of TPL) {
  const mod = await import('../anim/' + id + '.mjs');
  const t = mod.default;
  if (!t || typeof t.frame !== 'function') { ok(id + ' 导出合法模板', false); continue; }
  let frameCount = 0, err = null;
  const leaks = new Set();
  const t0 = performance.now();
  try {
    for (const [w, h] of SIZES) {
      const ctx = makeCtx();
      t.init(ctx, w, h);
      // 基线：init 之后的绘图状态，一帧跑完必须原样还回来（否则污染共享上下文）
      const baseline = { ...ctx.__state, lineDash: ctx.__state.lineDash.slice() };
      let now = t0;
      for (const cse of CASES) {
        for (let i = 0; i < 50; i++) {
          now += 16.7;
          t.frame(cse.d(), now);
          frameCount++;
        }
      }
      for (const k of stateLeaks(ctx, baseline)) leaks.add(k);
      // 换片段（resetKey 变化）+ 尺寸变化（走 resize 路径）
      for (let i = 0; i < 20; i++) {
        now += 16.7;
        const s = snap({ freq: 440 + i * 8, resetKey: 2 + Math.floor(i / 5), seenAny: true, statsMin: 300, statsMax: 900 });
        fillSpectrum(440 + i * 8, 0.9); fillSine(440 + i * 8, 0.3);
        t.frame(s, now);
        frameCount++;
      }
      if (t.resize) { t.resize(w + 40, h + 30); t.frame(snap({ freq: 660 }), now + 20); frameCount++; }
      for (const k of stateLeaks(ctx, baseline)) leaks.add(k);
    }
  } catch (e) { err = e; }
  ok(id + ' 跑完 ' + frameCount + ' 帧无异常' + (err ? ' → ' + err.message : ''), !err);
  if (err && err.stack) console.error('   ' + err.stack.split('\n').slice(1, 3).join('\n   '));
  ok(id + ' 未泄漏画布状态' + (leaks.size ? ' → ' + [...leaks].join(', ') : ''), leaks.size === 0);
}

// ---------- pitchTrail / pianoBlocks 未被改动，做回归护栏 ----------
for (const id of ['pitchTrail', 'pianoBlocks']) {
  const mod = await import('../anim/' + id + '.mjs');
  ok(id + ' 仍可正常加载（未改动护栏）', !!(mod.default && typeof mod.default.frame === 'function'));
}
const pb = await import('../anim/pianoBlocks.mjs');
ok('pianoBlocks.segmentPoints 仍导出', typeof pb.segmentPoints === 'function');
const pt = await import('../anim/pitchTrail.mjs');
ok('pitchTrail.aggregateItems 仍导出', typeof pt.aggregateItems === 'function');

// ---------- pitchOrb 保持态：短暂气口不黑屏，超时才回落（2026-09-12） ----------
{
  const t = (await import('../anim/pitchOrb.mjs')).default;
  const ctx = makeCtx();
  t.init(ctx, 800, 500);
  const arcs = () => { const n = ctx.__calls.arc; ctx.__calls.arc = 0; return n; };
  let now = 100000;
  const voiced = snap({ freq: 523.25, seenAny: true, statsMin: 523.25, statsMax: 523.25 });
  const silence = snap({ freq: NaN, seenAny: true, statsMin: 523.25, statsMax: 523.25 });
  // 先跑几帧发声，让游标进入稳定态
  for (let i = 0; i < 5; i++) { now += 16.7; t.frame(voiced, now); }
  const nLive = arcs();
  ok('保持态：真发声帧画了游标(arc≥2)', nLive >= 2);
  now += 100; t.frame(silence, now);            // 气口 100ms < 260ms → 应仍在画保持态
  const nGhost = arcs();
  ok('保持态：气口 100ms 内仍绘制游标(arc≥1，不黑屏)', nGhost >= 1);
  now += 400; t.frame(silence, now);            // 累计 500ms > 260ms → 应回落为空态
  const nBlank = arcs();
  ok('保持态：超过 260ms 后回落不画游标(arc=0)', nBlank === 0);
  ok('保持态：保持态确实比空态多画(有中间状态)', nGhost > nBlank);
}

// ---------- 中断(暂停/停止/播完)：只冻时间轴与游标，残留粒子必须走完 ----------
// ⚠️ 口径：d.live=false **不**让画面逐帧静止。
// 原话："中途暂停也让残留动画走完"（先是"播完粒子直接静止"，
// 再是"暂停也不要定格"）。新契约三条，全部在这里钉死：
//   ① 游标/音高线定住 —— 中断不推进时间轴（块停在原处、游标不动）；
//   ② 残留星尘仍在飘 —— 不再整帧定格；
//   ③ 走完寿命后自行安静 —— 「走完」与「卡住/永动」的分界，绝不能漏。
// 画法：单帧 drawing 坐标签名（每帧前清零）；另取最近一次 arc 坐标代表游标。
{
  const t = (await import('../anim/pitchOrb.mjs')).default;
  const ctx = makeCtx();
  t.init(ctx, 800, 500);
  let now = 300000, k = 0;
  const sigOf = (d, step) => { ctx.__recOn(); t.frame(d, now += step); const s = ctx.__recSig(); ctx.__recOff(); return s; };
  const arcOf = (d, step) => { ctx.__recOn(); t.frame(d, now += step); const a = ctx.__calls.arcs; ctx.__recOff(); return a[a.length - 1]; };
  const mkLive = () => {
    k++;
    return snap({ freq: 523.25 + 8 * Math.abs(Math.sin(k * 0.9)), prom: 18 + 16 * Math.abs(Math.sin(k * 0.5)), live: true, seenAny: true, statsMin: 500, statsMax: 560 });
  };
  const paused = () => snap({ freq: NaN, live: false, seenAny: true, statsMin: 500, statsMax: 560 });
  for (let i = 0; i < 40; i++) { now += 16.7; t.frame(mkLive(), now); }
  const a1 = sigOf(mkLive(), 16.7), a2 = sigOf(mkLive(), 16.7);
  ok('音高星盘：发声时画面确实在变(滚屏+星尘粒子)', a1.sig !== a2.sig && a1.n > 50);
  for (let i = 0; i < 25; i++) { now += 16.7; t.frame(paused(), now); }   // 先熬过保持态(260ms)
  // ① 游标定住（时间轴不推进）
  const c1 = arcOf(paused(), 16.7), c2 = arcOf(paused(), 33);
  ok('音高星盘：暂停后游标定住(时间轴未推进)', !!c1 && !!c2 && c1.x === c2.x && c1.y === c2.y);
  // ② 残留星尘继续飘（不再整帧定格）
  const p1 = sigOf(paused(), 33), p2 = sigOf(paused(), 33);
  ok('音高星盘：暂停后残留星尘继续飘(不再整帧定格)', p1.sig !== p2.sig);
  // ③ 寿命走完(LIFE_S=1.2s)后必须自行安静，不能永动
  for (let i = 0; i < 60; i++) { now += 33; t.frame(paused(), now); }
  const q1 = sigOf(paused(), 33), q2 = sigOf(paused(), 33);
  ok('音高星盘：星尘寿命走完后画面重新静止(不永动)', q1.sig === q2.sig && q1.n > 0);
}

// ---------- 音高星盘：音高线恒在画面正中（视口滚动，游标 y 不随音高移动） ----------
{
  const t = (await import('../anim/pitchOrb.mjs')).default;
  const ctx = makeCtx();
  t.init(ctx, 800, 500);   // H=500 → 正中 y=250
  let now = 700000;
  const c5 = snap({ freq: 523.25, seenAny: true, statsMin: 523.25, statsMax: 523.25 });
  for (let i = 0; i < 40; i++) { now += 16.7; t.frame(c5, now); }
  const lastC5 = ctx.__calls.arcs[ctx.__calls.arcs.length - 1];
  ok('音高星盘：唱 C5 时光点在正中(y=' + (lastC5 && lastC5.y) + ')', lastC5 && Math.abs(lastC5.y - 250) < 2);
  const c7 = snap({ freq: 2093, seenAny: true, statsMin: 523.25, statsMax: 2093 });
  for (let i = 0; i < 60; i++) { now += 16.7; t.frame(c7, now); }   // 从 C5 滚到 C7
  const lastC7 = ctx.__calls.arcs[ctx.__calls.arcs.length - 1];
  ok('音高星盘：唱 C7 时光点仍在正中(y=' + (lastC7 && lastC7.y) + ')', lastC7 && Math.abs(lastC7.y - 250) < 2);
  ok('音高星盘：光点 x 贴近音高场右缘(星盘读数布局不变)', lastC7 && lastC7.x > 700);
}

// ---------- 钢琴块特效层：珠链/命中光球必须真的被喷出来 + 暂停不再吐珠 ----------
{
  const t = (await import('../anim/pianoBlocks.mjs')).default;
  const fx = await import('../anim/pianoBlocks.mjs');
  const ctx = makeCtx();
  t.init(ctx, 900, 560);
  let now = 500000, ams = 1800;
  const midiD = () => { ams += 16.7; return snap({ freq: 523.25, seenAny: true, statsMin: 130, statsMax: 900, midiNotes: MIDI_NOTES, audioMs: ams }); };
  for (let i = 0; i < 60; i++) { now += 16.7; t.frame(midiD(), now); }
  const a = fx.__dbgFx();
  ok('钢琴块特效：工程模式下珠链有粒子(' + a.trail + ')', a.trail > 0);
  ok('钢琴块特效：命中光球被触发(' + a.hits + ')', a.hits > 0);
  ok('钢琴块特效：软球精灵已缓存(' + a.sprites + ')', a.sprites > 0);
  // 暂停(d.live=false)：不得继续吐珠（aMs 是冻结值，否则会原地持续冒粒子）
  const paused = snap({ freq: 523.25, seenAny: true, midiNotes: MIDI_NOTES, audioMs: ams, live: false });
  now += 16.7; t.frame(paused, now);
  const b = fx.__dbgFx();
  for (let i = 0; i < 30; i++) { now += 16.7; t.frame(paused, now); }
  const c = fx.__dbgFx();
  ok('钢琴块特效：暂停后不再新增粒子(' + b.trail + ' → ' + c.trail + ')', c.trail <= b.trail);

  // 核心纪律：发光 = 有声音。这里用"单个短音 + 之后静音"验证音停后必须灭掉
  // （这条能抓到两类真 bug：h.age 不递增 → 光球满亮永不衰减；音停不做快速淡出 → 余光滑到下一拍）
  const solo = [{ t0: 1000, t1: 1090, midi: 64 }];
  let ams2 = 900;
  const soloD = () => { ams2 += 16.7; return snap({ freq: 329.63, seenAny: true, midiNotes: solo, audioMs: ams2 }); };
  while (ams2 < 1080) { now += 16.7; t.frame(soloD(), now); }
  const during = fx.__dbgFx();
  ok('钢琴块特效：发声期内有粒子(' + during.trail + ')与光球(' + during.hits + ')', during.trail > 0 && during.hits > 0);
  while (ams2 < 1360) { now += 16.7; t.frame(soloD(), now); }   // 音停后再跑 ~270ms
  const after = fx.__dbgFx();
  ok('钢琴块特效：声音结束后 ~270ms 内粒子与光球全部清空(' + after.trail + '/' + after.hits + ')',
    after.trail === 0 && after.hits === 0);
}

// ---------- 画布内的界面角标：录制中/纯净模式必须不画（2026-09-15，"角标被录进视频"） ----------
// 背景：钢琴块的「♪ 琴声: …」是用 ctx.fillText 画在画布上的（不是 DOM 覆盖层），
// 因此 canvas.captureStream() 会把它一起录进视频。app.mjs 在录制中/纯净模式下广播
// setChromeHidden(true)；这里钉住"真的不画了"，以及"退出后能恢复"。
{
  const t = (await import('../anim/pianoBlocks.mjs')).default;
  const ctx = makeCtx();
  t.init(ctx, 900, 560);
  t.setSoundEnabled(true);              // 角标只在开了琴声时画，不开则本用例无意义
  let now = 600000, ams = 1800;
  const mk = () => { ams += 16.7; return snap({ freq: 523.25, seenAny: true, statsMin: 130, statsMax: 900, midiNotes: MIDI_NOTES, audioMs: ams }); };
  const drawsBadge = () => {
    ctx.__calls.texts.length = 0;
    for (let i = 0; i < 4; i++) { now += 16.7; t.frame(mk(), now); }
    return ctx.__calls.texts.some((s) => s.includes('琴声'));
  };
  ok('角标：默认可见（不动这块时行为与从前一致）', drawsBadge() === true);
  ok('角标：setChromeHidden(true) 后不再画（录制/纯净模式）', (() => {
    t.setChromeHidden(true);
    return drawsBadge() === false;
  })());
  ok('角标：setChromeHidden(false) 后恢复可见', (() => {
    t.setChromeHidden(false);
    return drawsBadge() === true;
  })());
  // 同名字段守卫：app.mjs 是按键名广播的，改名会让"隐藏"静默失效
  ok('角标：pianoBlocks 暴露了 setChromeHidden 接口（app.mjs 靠它广播）',
    typeof t.setChromeHidden === 'function');
  t.setSoundEnabled(false);
}

// ---------- 特效品质三档：setFxQuality 生效性（低档=只琴键点亮：清场+发射全停） ----------
{
  const fxMod = await import('../anim/pianoBlocks.mjs');
  const t = fxMod.default;
  ok('钢琴块暴露 setFxQuality 接口（app.mjs 靠它广播）', typeof t.setFxQuality === 'function');
  const ctx = makeCtx();
  t.init(ctx, 900, 560);
  let now = 800000, ams = 1800;
  const midiD = () => { ams += 16.7; return snap({ freq: 523.25, seenAny: true, statsMin: 130, statsMax: 900, midiNotes: MIDI_NOTES, audioMs: ams }); };
  for (let i = 0; i < 40; i++) { now += 16.7; t.frame(midiD(), now); }   // 高档先攒出粒子
  t.setFxQuality('low');                                                 // 切低档
  for (let i = 0; i < 6; i++) { now += 16.7; t.frame(midiD(), now); }
  const lo = fxMod.__dbgFx();
  ok('特效低档：粒子全部清场且停止发射(' + lo.trail + '/' + lo.hits + '/' + lo.smoke + '/' + lo.embers + ')',
    lo.trail === 0 && lo.hits === 0 && lo.smoke === 0 && lo.embers === 0);
  t.setFxQuality('high');                                                // 还原高档
  for (let i = 0; i < 30; i++) { now += 16.7; t.frame(midiD(), now); }
  const hi = fxMod.__dbgFx();
  ok('特效还原高档：粒子重新出现(珠链=' + hi.trail + ')', hi.trail > 0);
}

// ---------- 键盘动态光照层 + 落块漆面反射（v9）：高层真的在发光，低档必须不开 ----------
{
  const fxMod = await import('../anim/pianoBlocks.mjs');
  const t = fxMod.default;
  const ctx = makeCtx();
  // 计数器：点光/命中光洒走径向渐变，漆面反射/玻璃反光走线性渐变
  let radial = 0, linear = 0;
  ctx.createRadialGradient = (...a) => { radial++; return { addColorStop() {} }; };
  ctx.createLinearGradient = (...a) => { linear++; return { addColorStop() {} }; };
  t.init(ctx, 900, 560);
  let now = 900000;
  // 高档 + 一个正在发声的音（midi 64）：点光层必须点亮 → 径向渐变出现
  const near = [{ t0: 2000, t1: 2600, midi: 64 }];
  let ams = 2100;
  const dNear = () => { ams += 16.7; return snap({ freq: 329.63, seenAny: true, midiNotes: near, audioMs: ams }); };
  for (let i = 0; i < 4; i++) { now += 16.7; t.frame(dNear(), now); }
  const radialHigh = radial, linearHigh = linear;
  ok('键盘光照：高档发声时点光层点亮(径向渐变 ' + radialHigh + ' 个/帧均)', radialHigh >= 4);   // ≥1/帧：活跃键点光(+命中光洒)
  // 漆面反射：块贴线(aMs≈t0)时应有额外线性渐变(反射条)——远离后消失
  linear = 0;
  const far = [{ t0: 9000, t1: 9600, midi: 64 }];
  let ams2 = 2100;
  const dFar = () => { ams2 += 16.7; return snap({ freq: 329.63, seenAny: true, midiNotes: far, audioMs: ams2 }); };
  for (let i = 0; i < 4; i++) { now += 16.7; t.frame(dFar(), now); }
  ok('漆面反射：块贴线时的线性渐变多于块远在半空(' + linearHigh + '→含反射帧 > ' + linear + ' 远帧)',
    linearHigh > linear);
  // 低档：点光层必须关闭（低档=只琴键自染色，径向渐变应归零——烟/火花/命中/泛光全关）
  t.setFxQuality('low');
  radial = 0;
  for (let i = 0; i < 4; i++) { now += 16.7; t.frame(dNear(), now); }
  ok('键盘光照：低档点光层关闭(径向渐变 ' + radial + ' 个)', radial === 0);
  t.setFxQuality('high');                                                // 还原，别污染后面的用例
}

// ---------- 键线能量条（v11）：粒子池真的有存货 + 低档清空 + 暂停冻结 ----------
{
  const fxMod = await import('../anim/pianoBlocks.mjs');
  const t = fxMod.default;
  const ctx = makeCtx();
  t.init(ctx, 900, 560);
  let now = 950000, ams = 2100;
  const near = [{ t0: 2000, t1: 2600, midi: 64 }];
  const dNear = () => { ams += 16.7; return snap({ freq: 329.63, seenAny: true, midiNotes: near, audioMs: ams }); };
  for (let i = 0; i < 40; i++) { now += 16.7; t.frame(dNear(), now); }
  const a = fxMod.__dbgFx();
  ok('能量条：高档沿线粒子有存货(' + a.line + ')', a.line > 0);
  // 暂停(d.live=false)：不再新增粒子（粒子被冻结，数量只减不增）
  const paused = snap({ freq: 329.63, seenAny: true, midiNotes: near, audioMs: ams, live: false });
  const b = fxMod.__dbgFx();
  for (let i = 0; i < 20; i++) { now += 16.7; t.frame(paused, now); }
  const c = fxMod.__dbgFx();
  ok('能量条：暂停后粒子不增(' + b.line + ' → ' + c.line + ')', c.line <= b.line);
  // 低档：线粒子必须清空（低档只留静态芯线+光晕）
  t.setFxQuality('low');
  for (let i = 0; i < 4; i++) { now += 16.7; t.frame(dNear(), now); }
  ok('能量条：低档线粒子清空(' + fxMod.__dbgFx().line + ')', fxMod.__dbgFx().line === 0);
  t.setFxQuality('high');                                                // 还原
}

// ---------- prom 归一化刻度（不可用按"0~30 假 prom"定的系数）----------
// 背景：pitchOrb 两处若各自写死 `prom/40`（热力图）与 `prom/34`（粒子 amp），那是照旧
// mpm/pyin 内核的 0~30 假 prom 定的；三内核统一成真实 dB(30~115) 后这两个系数让真实素材
// 恒贴 1，"随声音质量呼吸"的效果被压平。现统一走 viz-common.promNorm(PROM_LO=20/HI=70)。
// 这里锁死刻度曲线的关键锚点 + 真实素材必须落在中段（既不饱和也不全 0）。
{
  ok(`promNorm 定义存在（${PROM_LO}dB→0 / ${PROM_HI}dB→1）`, typeof promNorm === 'function' && PROM_LO < PROM_HI);
  const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
  ok('promNorm 下界：门控下限附近 → 0', promNorm(PROM_LO) === 0 && promNorm(10) === 0 && promNorm(-5) === 0);
  ok('promNorm 上界：纯净音(104dB) → 1，且越界钳住', promNorm(104) === 1 && promNorm(1e6) === 1);
  ok('promNorm 口哨 p10/50/90 = 42/51/55dB → 0.44/0.62/0.70（旧系数会全贴 1）',
    near(promNorm(42), 0.44) && near(promNorm(51), 0.62) && near(promNorm(55), 0.70));
  ok('promNorm 人声 p50 = 58.6dB → ~0.77', near(promNorm(58.6), 0.77));
  // 非数/缺失输入（保持态、stub 数据）不得产生 NaN
  ok('promNorm 非数输入 → 0（不产生 NaN）', promNorm(undefined) === 0 && promNorm(NaN) === 0 && !Number.isNaN(promNorm(null)));
  // 真正的体感断言：真实素材整段必须"有动态范围"，否则等于没接
  const real = [31, 42, 55, 72].map(promNorm);              // 人声 p10 / 口哨 p10 / 口哨 p90 / 人声 p90
  const spread = Math.max(...real) - Math.min(...real);
  ok('真实素材(31~72dB)在归一化后跨度 >0.4（调制不死）', spread > 0.4);
}

// ---------- 中断(暂停/停止/播完)：残留粒子必须走完，且绝不新增 ----------
// 2026-09-20 口径变更：中断不再冻结粒子（先是"音频播完粒子直接静止"，再是"中途暂停也不要
// 定格"）。三条契约：① 残留粒子继续飘（数量必须开始下降）；② 绝不新增——发射口仍看 d.live，
// 否则 aMs 是冻结值会变成原地无限冒；③ 走完寿命窗后清零、④ 恢复播放后发射照常。
{
  const fxMod = await import('../anim/pianoBlocks.mjs');
  const t = fxMod.default;
  const ctx = makeCtx();
  t.init(ctx, 900, 560);
  let now = 1200000, ams = 2100;
  const near = [{ t0: 2000, t1: 2600, midi: 64 }];
  const dNear = () => { ams += 16.7; return snap({ freq: 329.63, seenAny: true, midiNotes: near, audioMs: ams }); };
  for (let i = 0; i < 40; i++) { now += 16.7; t.frame(dNear(), now); }
  const live0 = fxMod.__dbgFx();
  ok('中断收尾：播放中火花/线粒子有存货(' + live0.embers + '/' + live0.line + ')', live0.embers > 0 && live0.line > 0);

  // ① 中断（暂停与播完走同一条路径：audioMs 冻结 + live=false）：必须开始自然消亡
  const pausedD = snap({ freq: 329.63, seenAny: true, midiNotes: near, audioMs: ams, live: false });
  for (let i = 0; i < 30; i++) { now += 33; t.frame(pausedD, now); }
  const paused1 = fxMod.__dbgFx();
  ok('中断收尾：暂停后残留粒子继续走完（火花 ' + live0.embers + '→' + paused1.embers +
     '，线 ' + live0.line + '→' + paused1.line + '）',
    paused1.embers < live0.embers && paused1.line < live0.line);

  // ② + ③ 全程只减不增；跑完最长寿命窗（烟 2.4s）必须清零
  let prev = paused1, mono = true;
  for (let k2 = 0; k2 < 110; k2++) {
    now += 33; t.frame(pausedD, now);
    const s = fxMod.__dbgFx();
    if (s.embers > prev.embers || s.line > prev.line || s.smoke > prev.smoke) mono = false;
    prev = s;
  }
  ok('中断收尾：中断后粒子只减不增（发射口真的关了，不会原地无限冒）', mono);
  ok('中断收尾：走完寿命后粒子全部清空(' + prev.smoke + '/' + prev.embers + '/' + prev.line + ')',
    prev.smoke === 0 && prev.embers === 0 && prev.line === 0);

  // ④ 恢复播放：发射口必须立刻重新工作
  for (let i = 0; i < 30; i++) { now += 16.7; t.frame(dNear(), now); }
  const back = fxMod.__dbgFx();
  ok('中断收尾：恢复播放后粒子重新喷出(线 ' + back.line + ')', back.line > 0);
}

// ---------- 已下线模板：确认不会回流（3D钢琴、声谱瀑布；
//            2026-09-19 大清洗：频谱分析/示波器/3D音高隧道删除，音高星尘并入音高仪表） ----------
for (const id of ['spectrum', 'piano3d', 'spectrumBars', 'waveform', 'ribbon3d', 'particle']) {
  ok('anim/' + id + '.mjs 已删除且未回流', !existsSync(new URL('../anim/' + id + '.mjs', import.meta.url)));
}

console.log(fail === 0 ? '\n全部通过' : '\n失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
