// ============================================================
// test/trail-feian.mjs —— 废案风档（feian）契约守卫
//
// 参数清单：
//   - 采样节流 46ms（22050Hz / bufferSize=1024 无重叠 → 21.5 帧/s）
//   - 断连双阈值：相邻点 |Δ半音|>6 或 |Δt|>500ms → 抬笔（r3 绘制 lambda）
//   - 八度保护：与上一采样点 |Δ|>11 半音、间隔≤500ms、置信不足(promNorm<0.9)
//     → 丢帧；间隔>500ms = 气口后新起音，放行（d6.n）
//   - 不喂 One Euro（逐帧原始值直画）、无桥接、无聚合、无趋势线
//   - 荧光绿粗实线、无白芯、无光晕
//
// 观测手法（与 trail-smooth 同源，桩不同）：
//   ⚠ trail-smooth 的桩 stroke() 只收 shadowBlur>0 的发光层——feian 无光晕，
//     那种桩根本看不到它！本文件桩记录【所有】带 ≥2 顶点的 stroke，按颜色过滤：
//     曲线层唯一画 '#4be15f'（FA_COLOR），classic 主线前缀 'rgba(140,230,255'。
//   曲线画进模块级 ensureOff 缓存的离屏画布（跨用例复用同一个 ctx），
//   所以每帧前清空所有 ctx 的 traces → 帧后收集 = 严格「本帧」的笔段。
// ============================================================

const DEFAULTS = {
  fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  globalAlpha: 1, globalCompositeOperation: 'source-over',
  textAlign: 'start', textBaseline: 'alphabetic', font: '10px sans-serif',
  imageSmoothingEnabled: true, miterLimit: 10, lineDashOffset: 0, shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)', lineDash: [],
};

const ALL_CTX = [];

function makeCtx() {
  const state = { ...DEFAULTS, lineDash: [] };
  const stack = [];
  const traces = [];
  const texts = [];       // fillText 记录（标注层：当前音大字/段音名/音程都是文字）
  const api = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    measureText: () => ({ width: 12 }),
    save() { stack.push({ ...state, lineDash: state.lineDash.slice() }); },
    restore() { const s = stack.pop(); if (s) Object.assign(state, s); },
    setLineDash(a) { state.lineDash = Array.from(a || []); },
    putImageData() {}, drawImage() {}, strokeText() {},
    beginPath() { api.__cur = []; },
    closePath() {}, rect() {}, roundRect() {},
    moveTo(x, y) { if (api.__cur) api.__cur.push([x, y]); },
    lineTo(x, y) { if (api.__cur) api.__cur.push([x, y]); },
    arc() {}, arcTo() {}, ellipse() {}, fill() {},
    // ⚠ 与 trail-smooth 的桩不同：记录【所有】带 ≥1 顶点的 stroke（颜色/线宽/光晕一并留证）。
    //   门槛不能是 ≥2：单帧跳变会产生"单点段"（moveTo 后无 lineTo），那是合法笔段。
    stroke() {
      if (api.__cur && api.__cur.length >= 1) {
        traces.push({ pts: api.__cur.slice(), color: String(state.strokeStyle), w: state.lineWidth, blur: state.shadowBlur, alpha: state.globalAlpha });
      }
    },
    fillText(t, x, y) { texts.push({ text: String(t), x, y, font: String(state.font), color: state.fillStyle, align: state.textAlign }); },
    fillRect() {}, strokeRect() {}, clearRect() {}, clip() {},
    translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {}, resetTransform() {},
    quadraticCurveTo() {}, bezierCurveTo() {},
  };
  const px = new Proxy(api, {
    get(t, p) { if (p in t) return t[p]; if (p in state) return state[p]; return () => {}; },
    set(t, p, v) { if (p in t) t[p] = v; else state[p] = v; return true; },
  });
  px.__traces = traces;
  px.__texts = texts;
  px.__clearTraces = () => { traces.length = 0; texts.length = 0; };
  ALL_CTX.push(px);
  return px;
}

globalThis.document = {
  createElement: () => { const el = { width: 900, height: 520, style: {} }; el.getContext = () => makeCtx(); return el; },
  querySelector: () => null,
};
globalThis.window = globalThis;
globalThis.performance = { now: () => Date.now() };
globalThis.localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); } };

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('✓ ' + name + (extra ? '  ' + extra : ''));
  else { console.error('✗ ' + name + (extra ? '  ' + extra : '')); fail++; }
};

const T = (await import('../anim/pitchTrail.mjs')).default;
const m2f = (m) => 440 * Math.pow(2, (m - 69) / 12);

const FA_GREEN = '#4be15f';
const FA_W_AT_900 = 6.5;                    // faW() = min(11, max(6.5, 900/240)) @ W=900
const FA_NOTE_COLOR = '#8bc34a';            // 段音名标签浅绿（与源码常量一致）
const FA_INTERVAL_COLOR = '#ff9800';        // 段间音程橙（与源码常量一致）
const CLASSIC_MAIN = 'rgba(140,230,255';    // hexA(ACCENT '#8ce6ff', .95) 前缀（classic 发光主线）
const CLASSIC_CORE = 'rgba(240,247,255';    // classic 白芯前缀（feian 禁止出现）

// —— 坐标逆变换（pitchTrail 常量：padL=10 padT=16 padB=20 WIND_MS=10000 SEMI_MAX=108）——
const PAD_L = 10;
const NOW_X = Math.max(PAD_L + 60, 900 * 0.78);   // 702 @ W=900
function xToT(x, aMs) { return (x - PAD_L) / (NOW_X - PAD_L) * 10000 + (aMs - 10000); }
function yToSemi(y) { const offPx = (520 - 16 - 20) / 24; return 108 - (y - 16) / offPx; }

const snap = (ams, freq, o = {}) => ({
  voiced: o.voiced !== false, freq, midi: 69 + 12 * Math.log2(freq / 440), note: '--', cents: 0, hz: freq,
  prom: o.prom ?? 55, rms: 0.05, purity: 0.7, str: 0.12, spectrum: null, specBins: 0, specFmax: 0, waveform: null,
  seenAny: true, statsMin: NaN, statsMax: NaN,
  lastGoodFreq: freq, freqRaw: freq,
  live: true, audioMs: ams, resetKey: o.resetKey ?? 1,
  midiNotes: null, env: null, projMode: false, projFrames: null, liveRecActive: false,
});

// 实时帧序列生成：segs = [{from,to,midi,voiced?,prom?}]（ms）。
// 静音帧照实模拟检测器：voiced=false 但 lastGoodFreq 保持上一个值（classic 桥接依赖它）。
function liveSeq(segs) {
  const out = [];
  const STEP = 1000 / 60;
  const end = Math.max(...segs.map((s) => s.to));
  let lastMidi = segs.length ? segs[0].midi : 69;
  for (let t = 0; t <= end + STEP / 2; t += STEP) {
    const seg = segs.find((s) => t >= s.from && t <= s.to);
    if (seg && seg.voiced !== false) lastMidi = seg.midi;
    const prom = seg ? (seg.prom ?? 55) : 55;
    const voiced = !!(seg && seg.voiced !== false);
    out.push(snap(t, m2f(lastMidi), { voiced, prom }));
  }
  return out;
}

// 驱动实时模式：每帧前清空所有 ctx traces → 帧后 collect() = 严格本帧笔段
function driveLive(frames, { style = 'feian', aggMs = 0, smooth = true, H = 520 } = {}) {
  localStorage.setItem('ydyi_trail_style', style);   // init 路径也吃到同一档位
  const c = makeCtx();
  T.init(c, 900, H);
  T.setStyle(style);
  T.setTrendEnabled(false);
  T.setAggMode(aggMs);
  T.setSmooth(smooth);
  let last = null;
  for (const d of frames) {
    for (const cc of ALL_CTX) cc.__clearTraces();
    T.frame(d);
    last = d;
  }
  return { aMs: last ? last.audioMs : NaN, c };
}
// drawMainFa 起滑音渐隐后改为【逐点对】stroke——把首尾相接的点对 trace 合并回
// "逻辑笔画"，恢复与旧"一笔多段"一致的段数/顶点数观测语义（浮点确定性：同一 pts
// 元素的坐标重复计算值严格相等；fade 段也参与连通合并，因为它不是断笔）。
function mergeStrokes(traces) {
  const blocks = [];
  for (const tr of traces) {
    const last = blocks[blocks.length - 1];
    if (last) {
      const [lx, ly] = last.pts[last.pts.length - 1];
      const [fx, fy] = tr.pts[0];
      if (Math.abs(lx - fx) < 1e-9 && Math.abs(ly - fy) < 1e-9) {
        last.pts.push(...tr.pts.slice(1));   // 去掉重复的连接点
        last.alphaMin = Math.min(last.alphaMin, tr.alpha);
        last.alphaMax = Math.max(last.alphaMax, tr.alpha);
        last.alphaVals.push(tr.alpha);       // 保留逐片 alpha（沿线多级渐变的断言依据）
        continue;
      }
    }
    blocks.push({ pts: tr.pts.slice(), color: tr.color, w: tr.w, blur: tr.blur,
      alpha: tr.alpha, alphaMin: tr.alpha, alphaMax: tr.alpha, alphaVals: [tr.alpha] });
  }
  return blocks;
}
function collect(colorPrefix) {
  const out = [];
  for (const cc of ALL_CTX) {
    for (const tr of cc.__traces) {
      if (typeof tr.color === 'string' && tr.color.startsWith(colorPrefix)) out.push(tr);
    }
  }
  return mergeStrokes(out);
}
const flatPts = (traces, aMs) => traces.flatMap((tr) => tr.pts.map(([x, y]) => ({ t: xToT(x, aMs), s: yToSemi(y) })));
const nVtx = (traces) => traces.reduce((a, t) => a + t.pts.length, 0);
// 收集本帧所有 fillText（标注层观测）
function collectTexts() {
  const out = [];
  for (const cc of ALL_CTX) out.push(...(cc.__texts || []));
  return out;
}

console.log('\n================ 废案风档（feian）守卫 ================\n');

// ---------- 0. 冒烟 + 观感硬约束：绿、粗、无光晕、无白芯、不喂 EOF ----------
{
  const frames = liveSeq([{ from: 0, to: 400, midi: 69 }, { from: 470, to: 570, midi: 81, prom: 68 }]);
  driveLive(frames, { style: 'feian' });
  const g = collect(FA_GREEN);
  console.log('【冒烟】绿色笔段 =', g.length, ' 总顶点 =', nVtx(g));
  ok('feian 是合法档位：画出荧光绿主线', g.length > 0);
  ok('线宽 = faW() 粗实线基准', g.every((t) => Math.abs(t.w - FA_W_AT_900) < 1e-6), `(w=${g[0] && g[0].w})`);
  ok('无光晕（shadowBlur=0）', g.every((t) => t.blur === 0));
  ok('无白芯（classic 白芯色不得出现）', collect(CLASSIC_CORE).length === 0);
  // 不喂 EOF：81 跳变段 ≥2 个采样点，每个都应精确 = 81（喂了 EOF 第 2 点起必被拖离）
  const hi = flatPts(g, 570).filter((p) => p.s > 75);
  ok('跳变段逐点精确（不喂 One Euro）', hi.length >= 2 && hi.every((p) => Math.abs(p.s - 81) < 1e-6),
    `(81 段 ${hi.length} 点, 最大偏差 ${hi.length ? Math.max(...hi.map((p) => Math.abs(p.s - 81))).toExponential(1) : '-'})`);
}

// ---------- 1. 46ms 节流（21.5 帧/s）；classic 仍是 30ms 节流 ----------
{
  const frames = liveSeq([{ from: 0, to: 1000, midi: 69 }]);
  driveLive(frames, { style: 'feian' });
  const nFa = nVtx(collect(FA_GREEN));
  driveLive(frames, { style: 'classic' });
  const nCl = nVtx(collect(CLASSIC_MAIN));
  console.log('【节流】1000ms 采样点：feian =', nFa, '  classic =', nCl);
  ok('feian ≈ 21.5 点/s（46ms 节流，17~25）', nFa >= 17 && nFa <= 25, `(${nFa})`);
  ok('classic 仍 30ms 节流（28~38 点，未被殃及）', nCl >= 28 && nCl <= 38, `(${nCl})`);
  ok('feian 明显稀于 classic', nFa < nCl - 5);
}

// ---------- 2. 断连阈值①：相邻点 |Δ半音| > 6 抬笔 ----------
{
  driveLive(liveSeq([{ from: 0, to: 460, midi: 69 }, { from: 470, to: 900, midi: 76 }]), { style: 'feian' });
  const gJump = collect(FA_GREEN);
  ok('Δ=7 半音跳变 → 断成 2 段', gJump.length === 2, `(${gJump.length} 段)`);
  driveLive(liveSeq([{ from: 0, to: 460, midi: 69 }, { from: 470, to: 900, midi: 74 }]), { style: 'feian' });
  const gStay = collect(FA_GREEN);
  ok('Δ=5 半音跳变 → 保持 1 段（阈值内不断）', gStay.length === 1, `(${gStay.length} 段)`);
}

// ---------- 3. 断连阈值②：|Δt| > 500ms 抬笔；feian 无桥接 ----------
{
  const seq = liveSeq([
    { from: 0, to: 300, midi: 69 },
    { from: 300, to: 1000, midi: 69, voiced: false },
    { from: 1000, to: 1250, midi: 69 },
  ]);
  driveLive(seq, { style: 'feian' });
  const gz = collect(FA_GREEN);
  ok('feian：~700ms 空窗 → 断成 2 段（无桥接）', gz.length === 2, `(${gz.length} 段)`);
  driveLive(seq, { style: 'classic' });
  const qc = collect(CLASSIC_MAIN);
  ok('classic：同一空窗被桥接补点 → 保持 1 段（未被殃及）', qc.length === 1, `(${qc.length} 段)`);
}

// ---------- 4. 八度跳变保护（d6.n）----------
{
  // 4a. 低置信 +12 跳变：持续丢弃，直到与上一采样点的间隔超过 500ms 才放行
  const r4a = driveLive(liveSeq([{ from: 0, to: 460, midi: 69 }, { from: 470, to: 1500, midi: 81, prom: 55 }]), { style: 'feian' });
  const segs4a = collect(FA_GREEN);
  const hi4a = flatPts(segs4a, r4a.aMs).filter((p) => p.s >= 75);
  const lo4a = flatPts(segs4a, r4a.aMs).filter((p) => p.s < 75);
  const tHiMin = hi4a.length ? Math.min(...hi4a.map((p) => p.t)) : NaN;
  const tLoMax = lo4a.length ? Math.max(...lo4a.map((p) => p.t)) : NaN;
  console.log('【八度保护】低置信 +12：69 末点 t=', tLoMax.toFixed(0), 'ms，81 首点 t=', tHiMin.toFixed(0), 'ms');
  ok('4a 丢弃期间不产 81 点（81 首点 t > 930ms）', hi4a.length > 0 && tHiMin > 930, `(首点 ${tHiMin.toFixed(0)}ms)`);
  ok('4a Δt 超过 500ms 后放行（81 段 ≥2 点）', hi4a.length >= 2);
  ok('4a 曲线断开（69 段与 81 段分离 → 2 段）', segs4a.length === 2, `(${segs4a.length} 段)`);

  // 4b. 高置信（promNorm≥0.9）+12 跳变 → 立即放行（真跳变不拦）
  const r4b = driveLive(liveSeq([{ from: 0, to: 460, midi: 69 }, { from: 470, to: 900, midi: 81, prom: 68 }]), { style: 'feian' });
  const hi4b = flatPts(collect(FA_GREEN), r4b.aMs).filter((p) => p.s >= 75);
  const t4b = hi4b.length ? Math.min(...hi4b.map((p) => p.t)) : NaN;
  ok('4b 高置信真跳变 → 首个 81 点 t < 600ms', hi4b.length > 0 && t4b < 600, `(首点 ${t4b.toFixed(0)}ms)`);

  // 4c. 气口后新起音（与上一点的间隔>500ms）→ 保护不生效，立即采样
  const r4c = driveLive(liveSeq([
    { from: 0, to: 300, midi: 69 },
    { from: 300, to: 1200, midi: 69, voiced: false },
    { from: 1210, to: 1500, midi: 81, prom: 55 },
  ]), { style: 'feian' });
  const hi4c = flatPts(collect(FA_GREEN), r4c.aMs).filter((p) => p.s >= 75);
  const t4c = hi4c.length ? Math.min(...hi4c.map((p) => p.t)) : NaN;
  ok('4c 气口后新起音不被误拦（81 首点 t < 1300ms）', hi4c.length > 0 && t4c < 1300, `(首点 ${t4c.toFixed(0)}ms)`);
}

// ---------- 5. 废案无聚合概念：aggMs 对 feian 不生效（classic 照旧）----------
{
  const frames = liveSeq([{ from: 0, to: 1000, midi: 69 }]);
  driveLive(frames, { style: 'feian', aggMs: 500 });
  const nz = nVtx(collect(FA_GREEN));
  driveLive(frames, { style: 'classic', aggMs: 500 });
  const nc = nVtx(collect(CLASSIC_MAIN));
  console.log('【聚合豁免】agg=500ms：feian 点 =', nz, '  classic 点 =', nc);
  ok('feian 忽略聚合（仍 ≈21 点）', nz >= 15 && nz <= 25, `(${nz})`);
  ok('classic 聚合生效（500ms 桶 → ≤4 点）', nc >= 1 && nc <= 4, `(${nc})`);
}

// ---------- 6. 工程帧模式：feian 不喂 EOF + 双阈值断连同样生效 ----------
{
  const pFrames = [];
  for (let t = 0; t <= 980; t += 23) pFrames.push({ t, freq: m2f(69), voiced: true, prom: 55 });
  // ⚠ 81 段只给 1 帧：持速多帧跳变是 One Euro "快速放行"的设计场景（每步缩 ~96% 残差，
  //   4~5 帧就完全跟上），拿来当"EOF 应有偏差"的对照必翻车；单帧跳变的 EOF 输出必偏。
  pFrames.push({ t: 1092, freq: m2f(81), voiced: true, prom: 55 });
  const run = (style, smooth) => {
    localStorage.setItem('ydyi_trail_style', style);
    const c = makeCtx();
    T.init(c, 900, 520);
    T.setStyle(style); T.setTrendEnabled(false); T.setAggMode(0); T.setSmooth(smooth);
    for (const cc of ALL_CTX) cc.__clearTraces();
    T.frame({ ...snap(1100, 440), projMode: true, projFrames: pFrames });
  };
  run('feian', true);
  const gz = collect(FA_GREEN);
  const allZ = flatPts(gz, 1100).map((p) => p.s);
  const lastZ = allZ[allZ.length - 1];
  ok('工程帧 feian：末点 = 输入 81（1e-6 内，未喂 EOF）', Math.abs(lastZ - 81) < 1e-6, `(末点=${lastZ.toFixed(6)})`);
  ok('工程帧 feian：Δ=12 跳变断成 2 段', gz.length === 2, `(${gz.length} 段)`);
  run('classic', true);
  const allC = flatPts(collect(CLASSIC_MAIN), 1100).map((p) => p.s);
  const lastC = allC[allC.length - 1];
  ok('工程帧 classic：EOF 仍在工作（末点被拖离 81）', Math.abs(lastC - 81) > 0.01, `(末点=${lastC.toFixed(3)})`);
}

// ---------- 7. init 路径：localStorage 残留档名的兼容 ----------
{
  localStorage.setItem('ydyi_trail_style', 'feian');
  const c1 = makeCtx();
  T.init(c1, 900, 520);
  T.setTrendEnabled(false); T.setAggMode(0); T.setSmooth(true);
  for (let i = 0; i < 30; i++) {
    for (const cc of ALL_CTX) cc.__clearTraces();
    T.frame(snap(300 + i * 16.7, m2f(69)));
  }
  ok("localStorage 残留 'feian' → init 保持废案档（绿线）", collect(FA_GREEN).length > 0);
  localStorage.setItem('ydyi_trail_style', 'neon');
  const c2 = makeCtx();
  T.init(c2, 900, 520);   // ⚠ 必须重新 init：否则 style 停在上一段的 feian，测的不是 init 路径
  T.setTrendEnabled(false); T.setAggMode(0); T.setSmooth(true);
  for (let i = 0; i < 30; i++) {
    for (const cc of ALL_CTX) cc.__clearTraces();
    T.frame(snap(1300 + i * 16.7, m2f(69)));
  }
  ok("localStorage 残留 'neon' → init 回落经典档（青线、无绿线）",
    collect(FA_GREEN).length === 0 && collect(CLASSIC_MAIN).length > 0);
  localStorage.setItem('ydyi_trail_style', 'classic');
  T.setStyle('classic');   // 收尾复位
}

// ---------- 8. 标注层：当前音大字 / 段音名 / 段间音程（2026-09-21 二轮）----------
{
  // 8a 大字防抖：长音（≥5 个 46ms 采样点）显示 34px 白色音名；短音不显示
  const long = liveSeq([{ from: 0, to: 1000, midi: 69 }]);
  driveLive(long, { style: 'feian' });
  let big = collectTexts().filter((t) => t.font.includes('34px') && t.text.includes('A4'));
  ok('大字：长音 A4 稳定后显示（34px）', big.length > 0,
    `(${big.length} 条, text=${big[0] && big[0].text})`);
  driveLive(liveSeq([{ from: 0, to: 60, midi: 69 }]), { style: 'feian' });
  big = collectTexts().filter((t) => t.font.includes('34px'));
  ok('大字：短音（<5 采样点）不显示', big.length === 0, `(${big.length} 条)`);
  // 8a' 静音保持：voiced=false 期间字不消失（同类应用 q1 语义）
  const hold = long.concat(Array.from({ length: 10 }, (_, i) => snap(1600 + i * 16.7, m2f(69), { voiced: false })));
  driveLive(hold, { style: 'feian' });
  big = collectTexts().filter((t) => t.font.includes('34px') && t.text.includes('A4'));
  ok('大字：静音时保持最后稳定音', big.length > 0);

  // 8b 段音名 + 段间音程：A4(69) → E5(76) Δ=7 断段，段间隔 ≈53ms ≤1s
  driveLive(liveSeq([{ from: 0, to: 460, midi: 69 }, { from: 470, to: 900, midi: 76 }]), { style: 'feian' });
  const texts = collectTexts();
  ok('段音名：A4 浅绿标注（11px）',
    texts.some((t) => t.text.includes('A4') && t.color === FA_NOTE_COLOR && t.font.includes('11px')));
  ok('段音名：E5 浅绿标注',
    texts.some((t) => t.text.includes('E5') && t.color === FA_NOTE_COLOR));
  ok('音程：纯五度橙色标注',
    texts.some((t) => t.text === '纯五度' && t.color === FA_INTERVAL_COLOR));
  ok('音程：橙色虚线连接两段', collect(FA_INTERVAL_COLOR).length >= 1);
  // 8b' 长气口不连音程：段间隔（采样点间 Δt）>1s 才不连。
  //    ⚠ 自定保护项：同类应用原版对任意相邻 ToneLine 都连虚线；这里给 1s 上限是防止
  //    长气口两侧的段拉出横穿全屏的斜线（偏离一比一，注释留痕）。
  driveLive(liveSeq([{ from: 0, to: 300, midi: 69 }, { from: 300, to: 1400, midi: 69, voiced: false },
    { from: 1410, to: 1650, midi: 76 }]), { style: 'feian' });
  ok('音程：长气口（间隔>1s）不画音程标注',
    collectTexts().filter((t) => t.color === FA_INTERVAL_COLOR).length === 0
    && collect(FA_INTERVAL_COLOR).length === 0);

  // 8c 音名不叠的几何保证：同音高断连必然 Δt>500ms → 两段音名 x 间隔 ≥35px > 文字宽；
  //    不同音高段 y 天然错开（8b 已证）——组合覆盖"相邻段音名永不重叠"。
  //    （避让链保留作防御，但在断连几何下 x+y 双冲突不可达，无法构造触发素材。）
  driveLive(liveSeq([
    { from: 0, to: 80, midi: 69 }, { from: 80, to: 600, midi: 69, voiced: false },
    { from: 610, to: 690, midi: 69 },
  ]), { style: 'feian' });
  const notes8c = collectTexts().filter((t) => t.color === FA_NOTE_COLOR && t.text.includes('A4'));
  const dx8c = notes8c.length === 2 ? notes8c[1].x - notes8c[0].x : NaN;
  console.log('【音名不叠】同音高相邻 2 段 → A4 =', notes8c.length, ' 条, Δx =', dx8c.toFixed(1), 'px');
  ok('音名不叠：两段都标注且 x 间隔 ≥30px（>文字宽，段左端锚定的几何保证）',
    notes8c.length === 2 && dx8c >= 30, `(Δx=${dx8c.toFixed(1)}px)`);
  // 对照：不同音高的相邻段 y 天然错开，不该被避让误杀（8b 已断言 A4/E5 同时显示）

  localStorage.setItem('ydyi_trail_style', 'classic');
  T.setStyle('classic');   // 收尾复位
}

// ---------- 9. 滑音渐隐：段内大跳连线降 alpha，长音主体 alpha=1（r3 atan 公式）----------
{
  // Δ=5（≤6 不断笔，>2 滑音阈值）：跳变那一对连线沿线切片渐变（r3 min(d,dist−d) 对称形态）。
  // 观测粒度：合并块级 alphaMin/Max + alphaVals 档数（fade 片与长音区连通合并成同一逻辑笔画）。
  driveLive(liveSeq([{ from: 0, to: 460, midi: 69 }, { from: 470, to: 900, midi: 74 }]), { style: 'feian' });
  const blocks = collect(FA_GREEN);
  const mins = blocks.map((b) => b.alphaMin);
  const maxs = blocks.map((b) => b.alphaMax);
  const glide = blocks.find((b) => b.alphaMin < 0.999);
  const fadeAlphas = glide ? glide.alphaVals.filter((a) => a < 0.999) : [];
  console.log('【滑音渐隐】块 =', blocks.length,
    ' alphaMin =', mins.length ? Math.min(...mins).toFixed(3) : '-',
    ' alphaMax =', maxs.length ? Math.max(...maxs).toFixed(3) : '-',
    ' 淡化档数 =', fadeAlphas.length,
    ' 唯一 alpha 档 =', fadeAlphas.length ? new Set(fadeAlphas.map((a) => a.toFixed(3))).size : 0);
  ok('滑音渐隐：段内大跳连线明显淡化（alphaMin < 0.7）',
    glide !== undefined && glide.alphaMin < 0.7);
  ok('滑音渐隐：长音主体保持 alpha=1（块内存在全实片）',
    maxs.some((a) => a === 1));
  ok('滑音渐隐：沿线多级渐变而非两档色（fade 区 ≥3 个不同 alpha 档）',
    fadeAlphas.length >= 3 && new Set(fadeAlphas.map((a) => a.toFixed(3))).size >= 3);
  ok('滑音渐隐：淡化下限防呆（alphaMin ≥ 0.4）',
    mins.every((a) => a >= 0.4));
  localStorage.setItem('ydyi_trail_style', 'classic');
  T.setStyle('classic');   // 收尾复位
}

console.log(fail === 0 ? '\n守卫完成（无断言失败）\n' : '\n失败 ' + fail + ' 项\n');
process.exit(fail === 0 ? 0 : 1);
