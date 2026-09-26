// ============================================================
// test/trail-smooth.mjs —— 音高曲线平滑（One Euro Filter）契约守卫
//
// 为什么需要这个守卫：
//   One Euro 的价值全在"自适应"三个字——慢速强滤、快速放行。一个常数低通也能
//   "让曲线变顺"，但它会连颤音一起吃掉（真颤音 ≈5.5Hz 幅 ±40cents，正好落在
//   常数低通的通带边缘）。所以只断言"变平滑了"是空断言，必须【同时】断言：
//     ① 慢速抖动被显著压制（否则平滑没生效）
//     ② 快速大幅变化基本不被压制（否则颤音/滑音被吃掉 = 功能倒退）
//   这两条一起才证明"自适应"真的在工作。
//
// ⚠ 实现细节依赖（改了源码这些假设可能失效，先看这里）：
//   - 平滑施加在【采样入口】：实时 hist.push 前、工程帧组装候选点时；
//   - 只滤 f(频率)，不滤 t —— hist 的排序/裁剪依赖 t 严格递增（滤 t 会破坏）；
//   - 实时桥接点不滤波（它是"上一点保持值"的阶梯，喂进去只会拖慢滤波器）；
//   - 工程帧每帧从窗口左缘往前 EOF_WARMUP_MS 预热，不持有跨帧状态。
//
// 观测手法：曲线画进模块级 ensureOff 缓存的离屏画布 → 读它的 stroke 顶点。
//   ⚠ 不要按"第几个新建的 ctx"去找（import 的模块级状态在进程内共享，
//     ensureOff 的 offCv 只在首个用例里创建，后续用例复用）；
//     可靠做法 = 登记【所有】ctx，取那个"有 curve 顶点"的。
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
  const traces = [];      // 每次 stroke() 若带 shadowBlur（=主线）则记录其顶点
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
    // 只收 shadowBlur>0 的那条：即主线（发光层）。白芯/网格/圆点都不带 shadow。
    // 同时记下 strokeStyle 与 lineWidth —— 音准档用颜色编码音准、线宽编码可靠度，
    // 这两项才是该档的实质，必须能被守卫看到。
    stroke() {
      if (state.shadowBlur > 0 && api.__cur && api.__cur.length) {
        traces.push({ pts: api.__cur.slice(), color: state.strokeStyle, w: state.lineWidth });
      }
    },
    fillText() {}, fillRect() {}, strokeRect() {}, clearRect() {}, clip() {},
    translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {}, resetTransform() {},
    quadraticCurveTo() {}, bezierCurveTo() {},
  };
  const px = new Proxy(api, {
    get(t, p) { if (p in t) return t[p]; if (p in state) return state[p]; return () => {}; },
    set(t, p, v) { if (p in t) t[p] = v; else state[p] = v; return true; },
  });
  px.__traces = traces;
  px.__clearTraces = () => { traces.length = 0; };
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

// 唯一登记曲线层的 ctx：随时更新为"累计顶点最多的那个"
function curveCtx() {
  let best = null;
  for (const c of ALL_CTX) if (!best || c.__traces.length >= best.__traces.length) best = c;
  return best;
}
// 取最后一帧画出的主线顶点，换算回半音（y → semi 逆变换）
// y = padT + (SEMI_MAX - s) * offPx，offPx = (H-padT-padB)/(2*SEMI_RANGE)
function lastFrameSemis(H = 520) {
  const c = curveCtx();
  if (!c || !c.__traces.length) return [];
  const offPx = (H - 16 - 20) / 24;
  const tr = c.__traces[c.__traces.length - 1];
  return tr.pts.map(([, y]) => 108 - (y - 16) / offPx);
}

const snap = (ams, freq, o = {}) => ({
  voiced: o.voiced !== false, freq, midi: 69 + 12 * Math.log2(freq / 440), note: '--', cents: 0, hz: freq,
  prom: o.prom ?? 55, rms: 0.05, purity: 0.7, str: 0.12, spectrum: null, specBins: 0, specFmax: 0, waveform: null,
  seenAny: true, statsMin: NaN, statsMax: NaN,
  lastGoodFreq: freq, freqRaw: freq,
  live: true, audioMs: ams, resetKey: o.resetKey ?? 1,
  midiNotes: null, env: null, projMode: false, projFrames: null, liveRecActive: false,
});

const T = (await import('../anim/pitchTrail.mjs')).default;
const m2f = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ------------------------------------------------------------
// 素材生成：确定性伪随机，保证每次跑出同一串数字
// ------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 场景 A：长音 + 强抖动。真值恒定，叠加 ±jit 半音的帧间随机噪声 → 抖动应被压掉
// 场景 B：真颤音。正弦 ±amp 半音 @freq Hz → 应被基本保留
function genScenario({ n = 300, stepMs = 30, base = 67, jit = 0, vibAmp = 0, vibHz = 0, seed = 7 }) {
  const rnd = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i * stepMs;
    let m = base;
    if (vibAmp > 0) m += vibAmp * Math.sin(2 * Math.PI * vibHz * (t / 1000));
    if (jit > 0) m += (rnd() - 0.5) * 2 * jit;
    out.push({ t, m });
  }
  return out;
}

// 跑一个场景，返回逐帧"曲线最右端半音"序列（对应真值的观测）
function runScenario(rows, { smooth, H = 520, nFrames = null } = {}) {
  const c = makeCtx();
  T.init(c, 900, H);
  T.setStyle('classic');
  T.setTrendEnabled(false);
  T.setAggMode(0);
  T.setSmooth(smooth);
  const N = nFrames ?? rows.length;
  let now = 500000;
  for (let i = 0; i < N; i++) {
    now += 16.7;
    T.frame(snap(rows[i].t, m2f(rows[i].m)), now);
  }
  const s = lastFrameSemis(H);
  return { series: s, ctx: c };
}

// 指标 A：抖动强度 = 高频残差能量（在 12~14Hz 两个探针频率上的 DFT 幅度平方和）。
//   检测抖动是帧间随机的 → 能量落在高频；真颤音(5.5Hz)不在这个带内。
//   这是"抖动有没有被滤掉"的直接度量。
// 指标 B：颤音幅度保留 = 5.5Hz 处的 DFT 幅度比。
// ⚠ 不要用"相邻二阶差"衡量颤音：33Hz 采样下 5.5Hz 每周期仅 6 点，二阶差对相位
//   极敏感，会把滤波器的相位滞后误读成"幅度丢失"（曾据此误判"颤音被吃掉 3/4"）。
//   改用 DFT 幅度：只测那个频率上还剩多少能量，对相位不敏感。
const FS = 1000 / 30;   // 实时采样率(30ms 节流)

function ampAt(series, fTest, warm = 120) {
  const x = series.slice(warm);
  const n = x.length;
  if (n < 8) return NaN;
  const mean = x.reduce((a, b) => a + b, 0) / n;
  let re = 0, im = 0, wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const ph = 2 * Math.PI * fTest * (i / FS);
    re += w * (x[i] - mean) * Math.cos(ph);
    im += w * (x[i] - mean) * Math.sin(ph);
    wsum += w;
  }
  return 2 * Math.sqrt(re * re + im * im) / wsum;
}
// 高频残差（抖动）：12Hz 与 14Hz 两点的能量
function hiResidual(series) {
  const a = ampAt(series, 12), b = ampAt(series, 14);
  return Math.sqrt((Number.isFinite(a) ? a * a : 0) + (Number.isFinite(b) ? b * b : 0));
}
// 与真值的 RMS 偏差（cents），衡量"整体形态还像不像"
function rmsDev(series, rows, warm = 120) {
  const n = Math.min(series.length, rows.length);
  let e = 0, k = 0;
  for (let i = warm; i < n; i++) { e += (series[i] - rows[i].m) ** 2; k++; }
  return k ? Math.sqrt(e / k) * 100 : NaN;
}

console.log('\n================ 音高曲线平滑（One Euro）守卫 ================\n');

// ---------- 0. 冒烟：平滑开关可调用、曲线确实在画 ----------
{
  const rows = genScenario({ n: 120, jit: 0.2 });
  const r = runScenario(rows, { smooth: true });
  ok('平滑开启时曲线仍在绘制（主线顶点 > 0）', r.series.length > 0, `(${r.series.length} 顶点)`);
  ok('setSmooth 导出可用', typeof T.setSmooth === 'function');
}

// ---------- 1. 核心契约①：帧间抖动被显著压制 ----------
// 真值恒定 + ±10 cents 帧间随机噪声（真实检测抖动的典型量级；±30cents 是夸张值，
// 那种幅度下 One Euro 的速度判别会失效——它的自适应前提是"抖动速度低"）。
{
  const rows = genScenario({ n: 600, jit: 0.10, seed: 11 });
  const off = runScenario(rows, { smooth: false });
  const on = runScenario(rows, { smooth: true });
  const hOff = hiResidual(off.series), hOn = hiResidual(on.series);
  console.log('【抖动压制】真值恒定 + ±10 cents 帧间随机噪声：');
  console.log('   关平滑 高频残差(12~14Hz) =', hOff.toFixed(5));
  console.log('   开平滑 高频残差(12~14Hz) =', hOn.toFixed(5));
  ok('抖动被显著压制（高频残差至少降 60%）', hOn < hOff * 0.4,
    `(降 ${(100 * (1 - hOn / hOff)).toFixed(0)}%)`);
}

// ---------- 2. 核心契约②：真颤音基本被保留（这是"自适应"的证明）----------
// 真颤音典型 5~7Hz、±30~50 cents。常数低通会把它吃掉；One Euro 应放行。
{
  const rows = genScenario({ n: 600, vibAmp: 0.45, vibHz: 5.5, seed: 3 });
  const off = runScenario(rows, { smooth: false });
  const on = runScenario(rows, { smooth: true });
  const aOff = ampAt(off.series, 5.5), aOn = ampAt(on.series, 5.5);
  console.log('\n【颤音保留】5.5Hz 真颤音 ±0.45 半音（DFS 幅度，元数据 ±0.45）:');
  console.log('   关平滑 5.5Hz 幅度 =', aOff.toFixed(4), '半音');
  console.log('   开平滑 5.5Hz 幅度 =', aOn.toFixed(4), '半音',
    `（保留 ${(100 * aOn / aOff).toFixed(0)}%）`);
  ok('真颤音不被吃掉（5.5Hz 幅度保留 ≥ 50%）', aOn > aOff * 0.5,
    `(保留 ${(100 * aOn / aOff).toFixed(0)}%)`);
}

// ---------- 3. 自适应正面对证：慢速抖动 vs 快速颤音的差别对待 ----------
// 若换成常数低通，两条保留比会一样；One Euro 应让颤音保留比明显高于抖动保留比。
{
  const jitRows = genScenario({ n: 600, jit: 0.10, seed: 11 });
  const vibRows = genScenario({ n: 600, vibAmp: 0.45, vibHz: 5.5, seed: 3 });
  const hOff = hiResidual(runScenario(jitRows, { smooth: false }).series);
  const hOn = hiResidual(runScenario(jitRows, { smooth: true }).series);
  const vOff = ampAt(runScenario(vibRows, { smooth: false }).series, 5.5);
  const vOn = ampAt(runScenario(vibRows, { smooth: true }).series, 5.5);
  const keepJit = hOn / hOff, keepVib = vOn / vOff;
  console.log('\n【自适应对证】抖动保留比 =', (100 * keepJit).toFixed(0) + '%',
    ' vs 颤音保留比 =', (100 * keepVib).toFixed(0) + '%');
  ok('自适应生效：颤音保留比显著高于抖动保留比（≥2 倍）',
    keepVib > keepJit * 2, `(${(keepVib / keepJit).toFixed(2)}×)`);
}

// ---------- 4. 不引入系统性偏移 / 不吃形态 ----------
// 缓慢滑音（真值单调上行）不应被平滑削去幅度或产生可见滞后偏移。
{
  const n = 360, rows = [];
  for (let i = 0; i < n; i++) rows.push({ t: i * 30, m: 60 + i * 0.02 });
  const off = runScenario(rows, { smooth: false });
  const on = runScenario(rows, { smooth: true });
  const dOff = rmsDev(off.series, rows), dOn = rmsDev(on.series, rows);
  console.log('\n【形态保真】缓慢上行滑音（真值 60→67.2 半音，每帧 +2 cents）：');
  console.log('   关平滑 与真值 RMS =', dOff.toFixed(0), 'cents');
  console.log('   开平滑 与真值 RMS =', dOn.toFixed(0), 'cents');
  ok('平滑后与真值的偏差仍很小（≤15 cents，无系统性滞后）', dOn < 15,
    `(${dOn.toFixed(0)} cents)`);
}

// ---------- 5. 参数域扫描：确认默认参数落在合理区间 ----------
// 这条不是断言"默认值好看"，而是【锁住量级】——防止后人误把 β 调小
// (颤音被吃掉) 或调大 (等于不滤)。两头失败模态都要能被抓到。
{
  const jitRows = genScenario({ n: 600, jit: 0.10, seed: 11 });
  const vibRows = genScenario({ n: 600, vibAmp: 0.45, vibHz: 5.5, seed: 3 });
  const hOff = hiResidual(runScenario(jitRows, { smooth: false }).series);
  const hOn = hiResidual(runScenario(jitRows, { smooth: true }).series);
  const vOff = ampAt(runScenario(vibRows, { smooth: false }).series, 5.5);
  const vOn = ampAt(runScenario(vibRows, { smooth: true }).series, 5.5);
  console.log('\n【参数域】默认参数下：抖动高频压掉 ' + (100 * (1 - hOn / hOff)).toFixed(0)
    + '%，颤音保留 ' + (100 * vOn / vOff).toFixed(0) + '%');
  ok('默认参数：真在滤（抖动高频降幅 > 50%）', hOn < hOff * 0.5,
    `(降 ${(100 * (1 - hOn / hOff)).toFixed(0)}%)`);
  ok('默认参数：又不过头（颤音保留 > 50%）', vOn > vOff * 0.5,
    `(留 ${(100 * vOn / vOff).toFixed(0)}%)`);
}

// ---------- 6. 工程帧模式同样生效 ----------
{
  const rows = genScenario({ n: 600, jit: 0.10, seed: 11 });
  const frames = rows.map((r) => ({ t: r.t, freq: m2f(r.m), voiced: true, prom: 55 }));
  const mk = (ams) => ({ ...snap(ams, 440), projMode: true, projFrames: frames });
  const collect = (smooth) => {
    const c = makeCtx();
    T.init(c, 900, 520);
    T.setStyle('classic'); T.setTrendEnabled(false); T.setAggMode(0);
    T.setSmooth(smooth);
    let now = 600000;
    for (let i = 0; i < 60; i++) { now += 16.7; T.frame(mk(12000 + i * 20), now); }
    return lastFrameSemis();
  };
  const sOff = collect(false), sOn = collect(true);
  const pOff = hiResidual(sOff), pOn = hiResidual(sOn);
  console.log('\n【工程帧模式】高频残差：关=' + pOff.toFixed(5) + '  开=' + pOn.toFixed(5));
  ok('工程帧模式：平滑同样生效（高频残差被压制）', pOn < pOff * 0.6,
    `(降 ${(100 * (1 - pOn / pOff)).toFixed(0)}%)`);
  // 预热契约：窗口左缘附近不应看到"滤波器未预热"的软塌
  ok('工程帧模式：窗口内无 NaN 顶点', sOn.every((v) => Number.isFinite(v)));
}

// ---------- 6. seek 回退不炸、不产生 NaN ----------
{
  const rows = genScenario({ n: 200, jit: 0.25, seed: 5 });
  const c = makeCtx();
  T.init(c, 900, 520);
  T.setStyle('classic'); T.setTrendEnabled(false); T.setAggMode(0);
  T.setSmooth(true);
  let now = 700000;
  for (let i = 0; i < 150; i++) { now += 16.7; T.frame(snap(i * 30, m2f(rows[i].m)), now); }
  // 回退 2 秒
  for (let i = 90; i < 150; i++) { now += 16.7; T.frame(snap(i * 30, m2f(rows[i].m)), now); }
  const s = lastFrameSemis();
  console.log('\n【seek 回退】回退 2s 后曲线顶点数 =', s.length);
  ok('回退后仍绘出曲线', s.length > 0, `(${s.length} 顶点)`);
  ok('回退后无 NaN 顶点', s.every((v) => Number.isFinite(v)),
    '(' + s.filter((v) => !Number.isFinite(v)).length + ' 个 NaN)');
}

// ---------- 7. 关平滑 = 与改造前的逐点行为一致 ----------
// 关掉后曲线端点应精确复现输入的频率（不被任何滤波器改动）。
{
  const rows = genScenario({ n: 60, jit: 0.3, seed: 9 });
  const r = runScenario(rows, { smooth: false });
  const last = r.series[r.series.length - 1];
  const expect = rows[rows.length - 1].m;
  console.log('\n【关平滑】末点 =', last.toFixed(3), ' 输入真值 =', expect.toFixed(3));
  ok('关平滑时曲线末点 = 输入值（1e-6 内，无任何滤波残留）',
    Math.abs(last - expect) < 1e-6, `(差 ${Math.abs(last - expect).toExponential(1)})`);
}

// ---------- 8. 经典档语义 ----------
// 8①②③（音准档 颜色=音准 / 线宽=可靠度 / 跳变断开）已随四档一并裁撤。
// 仅保留 semiToF 供下方经典档用例使用。
const semiToF = (m) => 440 * Math.pow(2, (m - 69) / 12);
// ④ 经典档未被污染：classic 下不应出现琥珀/红配色（那是音准档专有）
{
  const c = makeCtx();
  T.init(c, 900, 520);
  T.setStyle('classic');
  T.setTrendEnabled(false); T.setAggMode(0); T.setSmooth(false);
  let now = 950000;
  for (let i = 0; i < 40; i++) {
    now += 16.7;
    T.frame(snap(3000 + i * 30, semiToF(69 + 30 / 100)), now);   // 故意跑调 30¢
  }
  const c2 = curveCtx();
  const tr = c2 && c2.__traces.length ? c2.__traces[c2.__traces.length - 1] : null;
  const col = tr && tr.color;
  console.log('【经典档·未受污染】跑调素材下的描边色 =', col);
  ok('经典档不使用音准配色（跑调素材下仍为原色）', col !== '#f87171' && col !== '#fbbf24', `(${col})`);
}

// ⑤ 已废除/非法档名一律回落 classic（setStyle 与 init 两条路径都测）：
//    localStorage('ydyi_trail_style') 可能残留任何未知档名，两条路都不许卡空档。
//    （'feian' 2026-09-20 起重新成为合法档位，已从本列表移除；其行为守卫见 trail-feian.mjs）
{
  const legacy = ['accuracy', 'neon', 'particles', 'depth', null, 123, {}];
  for (const bad of legacy) {
    T.setStyle(bad);
    const c = makeCtx();
    T.init(c, 900, 520);
    T.setTrendEnabled(false); T.setAggMode(0); T.setSmooth(false);
    let now = 970000;
    for (let i = 0; i < 30; i++) {
      now += 16.7;
      T.frame(snap(4000 + i * 30, semiToF(69 + 30 / 100)), now);
    }
    const c2 = curveCtx();
    const tr = c2 && c2.__traces.length ? c2.__traces[c2.__traces.length - 1] : null;
    ok('setStyle(' + JSON.stringify(bad) + ') 回落经典档（不绘制音准配色）',
      tr && tr.color !== '#f87171' && tr.color !== '#fbbf24', '(' + (tr && tr.color) + ')');
  }
  // init 路径：localStorage 里残留未知档名 → init 应回落 classic
  for (const bad of ['accuracy', 'neon', 'particles', 'depth']) {
    localStorage.setItem('ydyi_trail_style', bad);
    const c = makeCtx();
    T.init(c, 900, 520);
    T.setTrendEnabled(false); T.setAggMode(0); T.setSmooth(false);
    let now = 975000;
    for (let i = 0; i < 30; i++) {
      now += 16.7;
      T.frame(snap(5000 + i * 30, semiToF(69 + 30 / 100)), now);
    }
    const c2 = curveCtx();
    const tr = c2 && c2.__traces.length ? c2.__traces[c2.__traces.length - 1] : null;
    ok('localStorage 残留 ' + JSON.stringify(bad) + ' → init 回落经典档',
      tr && tr.color !== '#f87171' && tr.color !== '#fbbf24', '(' + (tr && tr.color) + ')');
  }
  localStorage.setItem('ydyi_trail_style', 'classic');
  T.setStyle('classic');   // 收尾：恢复默认
}

console.log(fail === 0 ? '\n守卫完成（无断言失败）\n' : '\n失败 ' + fail + ' 项\n');
process.exit(fail === 0 ? 0 : 1);
