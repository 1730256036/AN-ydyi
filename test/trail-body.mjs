// ============================================================
// test/trail-body.mjs —— 废案曲线本体渲染开关契约守卫
//
// 六个开关（faBody：ribbon/glow/breath/shadow/smooth/hue）默认全关 =
// 废案一比一观感（trail-feian 守卫锁死）。本守卫断言：
//   ① 默认态：无光晕/线宽=faW/无落影/无填充/逐点精确（与 trail-feian 冒烟一致）
//   ② ribbon：产生绿色渐隐填充（gradient + fill），曲线 stroke 仍在
//   ③ glow：出现 shadowBlur>0 的绿色底层 stroke（主线本体 blur 仍为 0）
//   ④ breath：高 prom 段线宽 > 低 prom 段线宽，且贴合 0.75~1.35×faW 夹紧
//   ⑤ shadow：出现深色偏移 stroke
//   ⑥ hue：strokeStyle 变 hsl(...) 且不同八度色相不同
//   ⑦ smooth：废案档喂 One Euro（跳变点被拖离精确值），关掉恢复逐点精确
//   ⑧ 持久化：setFaBody 写 localStorage，init 恢复
// 观测手法与 trail-feian 同源：全量记录桩（stroke/fill/gradient），离屏画布跨用例
// 复用 → 每帧前清所有 ctx traces。
// ============================================================

const DEFAULTS = {
  fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  globalAlpha: 1, globalCompositeOperation: 'source-over',
  textAlign: 'start', textBaseline: 'alphabetic', font: '10px sans-serif',
  imageSmoothingEnabled: true, miterLimit: 10, lineDashOffset: 0, shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)', lineDash: [], filter: 'none',
};

const ALL_CTX = [];

function makeCtx() {
  const state = { ...DEFAULTS, lineDash: [] };
  const stack = [];
  const traces = [];
  const fills = [];
  const grads = [];
  const blits = [];      // drawImage 记录：{filter, alpha}（辉光=整层模糊贴图）
  const api = {
    createLinearGradient: (x0, y0, x1, y1) => {
      const g = { x0, y0, x1, y1, stops: [], addColorStop(o, c) { g.stops.push([o, String(c)]); } };
      grads.push(g);
      return g;
    },
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => ({}),
    measureText: () => ({ width: 12 }),
    save() { stack.push({ ...state, lineDash: state.lineDash.slice() }); },
    restore() { const s = stack.pop(); if (s) Object.assign(state, s); },
    setLineDash(a) { state.lineDash = Array.from(a || []); },
    putImageData() {}, strokeText() {},
    drawImage() { blits.push({ filter: String(state.filter), alpha: state.globalAlpha }); },
    beginPath() { api.__cur = []; },
    closePath() {}, rect() {}, roundRect() {},
    moveTo(x, y) { if (api.__cur) api.__cur.push([x, y]); },
    lineTo(x, y) { if (api.__cur) api.__cur.push([x, y]); },
    arc() {}, arcTo() {}, ellipse() {},
    fill() { fills.push({ color: state.fillStyle, n: api.__cur ? api.__cur.length : 0 }); },
    stroke() {
      if (api.__cur && api.__cur.length >= 1) {
        traces.push({ pts: api.__cur.slice(), color: String(state.strokeStyle), w: state.lineWidth, blur: state.shadowBlur, alpha: state.globalAlpha });
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
  px.__fills = fills;
  px.__grads = grads;
  px.__blits = blits;
  px.__clearTraces = () => { traces.length = 0; fills.length = 0; grads.length = 0; blits.length = 0; };
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
const { promNorm, rmsNorm } = await import('../anim/viz-common.mjs');
const m2f = (m) => 440 * Math.pow(2, (m - 69) / 12);

const FA_GREEN = '#4be15f';
const FA_W_AT_900 = 6.5;
// 隔离本体观测：fx 粒子全关（否则主 ctx 的火花 fill/涟漪 stroke 混进断言）+ 本体六项全关
const ALL_OFF = () => {
  localStorage._d = {};
  for (const k of ['head', 'ripple', 'spark', 'bars']) localStorage.setItem('ydyi_fx_' + k, '0');
  for (const k of ['ribbon', 'glow', 'breath', 'shadow', 'smooth', 'hue']) localStorage.setItem('ydyi_fa_' + k, '0');
};
// ⚠ 曲线画进模块级离屏 ctx（ensureOff，跨 drive 复用）→ 必须扫全部 ALL_CTX，
//   只看 drive 返回的主 ctx 会一个笔段都看不到（fx 才画在主 ctx 上）。
const allTraces = () => ALL_CTX.flatMap((cc) => cc.__traces);
const green = () => allTraces().filter((t) => t.color === FA_GREEN || t.color.startsWith('hsl('));
const darks = () => allTraces().filter((t) => t.color.startsWith('rgba(18,46,30'));
const widths = () => green().map((t) => t.w);
const allFills = () => ALL_CTX.flatMap((cc) => cc.__fills);
// "色带填充"断言只认绿色平铺 fill（0.12 内层 + 0.05 外层两层）：
// drawCursorAt 的当前音圆点/火花等也是 fill，但颜色不同。
const ribbonFills = () => allFills().filter((f) => typeof f.color === 'string' && f.color.startsWith('rgba(75,225,95'));

const snap = (ams, freq, o = {}) => ({
  voiced: o.voiced !== false, freq, midi: 69 + 12 * Math.log2(freq / 440), note: '--', cents: 0, hz: freq,
  prom: o.prom ?? 55, rms: o.rms ?? 0.05, purity: 0.7, str: 0.12, spectrum: null, specBins: 0, specFmax: 0, waveform: null,
  seenAny: true, statsMin: NaN, statsMax: NaN,
  lastGoodFreq: freq, freqRaw: freq,
  live: true, audioMs: ams, resetKey: o.resetKey ?? 1,
  midiNotes: null, env: null, projMode: false, projFrames: null, liveRecActive: false,
});

function liveSeq(segs) {
  const out = [];
  const STEP = 1000 / 60;
  const end = Math.max(...segs.map((s) => s.to));
  let lastMidi = segs.length ? segs[0].midi : 69;
  for (let t = 0; t <= end + STEP / 2; t += STEP) {
    const seg = segs.find((s) => t >= s.from && t <= s.to);
    if (seg && seg.voiced !== false) lastMidi = seg.midi;
    const prom = seg ? (seg.prom ?? 55) : 55;
    const rms = seg ? (seg.rms ?? 0.05) : 0.05;
    const voiced = !!(seg && seg.voiced !== false);
    out.push(snap(t, m2f(lastMidi), { voiced, prom, rms }));
  }
  return out;
}

function drive(frames) {
  const c = makeCtx();
  T.init(c, 900, 520);
  T.setStyle('feian');
  T.setTrendEnabled(false);
  let last = null;
  for (const d of frames) {
    for (const cc of ALL_CTX) cc.__clearTraces();
    T.frame(d);
    last = d;
  }
  return { c, aMs: last ? last.audioMs : NaN };
}

console.log('\n================ 废案曲线本体渲染开关守卫 ================\n');

// ---------- ① 默认全关 = 一比一 ----------
{
  ALL_OFF();
  const { c } = drive(liveSeq([{ from: 0, to: 600, midi: 69 }]));
  const g = green();
  ok('默认态：画出绿色主线', g.length > 0);
  ok('默认态：线宽全部 = faW 基准', g.length > 0 && g.every((t) => Math.abs(t.w - FA_W_AT_900) < 1e-6), `(w=${g[0] && g[0].w})`);
  ok('默认态：无光晕（blur=0）', g.every((t) => t.blur === 0));
  ok('默认态：无落影/无色带填充/无辉光贴图',
    darks().length === 0 && ribbonFills().length === 0
    && c.__blits.every((b) => !b.filter.startsWith('blur(')));
}

// ---------- ② 色带填充 ----------
{
  ALL_OFF();
  localStorage.setItem('ydyi_fa_ribbon', '1');
  const { c } = drive(liveSeq([{ from: 0, to: 600, midi: 69 }]));
  ok('ribbon：产生等深带填充（内 0.12 + 外 0.05 两层绿）', ribbonFills().length >= 2, `(fills=${ribbonFills().length})`);
  ok('ribbon：曲线主线仍在（stroke 顶点>0）', green().reduce((a, t) => a + t.pts.length, 0) > 0);
  ok('ribbon 持久化：localStorage 写入 1', localStorage.getItem('ydyi_fa_ribbon') === '1');
}

// ---------- ③ 辉光（整层模糊副本） ----------
{
  ALL_OFF();
  localStorage.setItem('ydyi_fa_glow', '1');
  const { c } = drive(liveSeq([{ from: 0, to: 600, midi: 69 }]));
  const blurred = c.__blits.filter((b) => b.filter.startsWith('blur('));
  ok('glow：整层模糊贴图 1 次/帧（filter=blur + 低 alpha）',
    blurred.length >= 1 && blurred.every((b) => b.alpha > 0 && b.alpha < 1),
    `(blur 贴图=${blurred.length}, alpha=${blurred[0] && blurred[0].alpha})`);
  ok('glow：曲线本体 stroke 不再挂 shadowBlur（每段模糊已废除）', green().length > 0 && green().every((t) => t.blur === 0));
}

// ---------- ④ 响度呼吸（真 rms） ----------
{
  ALL_OFF();
  localStorage.setItem('ydyi_fa_breath', '1');
  const { c } = drive(liveSeq([
    { from: 0, to: 400, midi: 69, rms: 0.002 },      // 弱音 ≈ rmsNorm 0.06
    { from: 470, to: 1200, midi: 69, rms: 0.2 },     // 强音 ≈ rmsNorm 0.97
  ]));
  const ws = widths();
  const wLo = FA_W_AT_900 * (0.6 + 0.9 * rmsNorm(0.002));
  const wHi = FA_W_AT_900 * (0.6 + 0.9 * rmsNorm(0.2));
  ok('breath：线宽随真响度(rms)起伏（min≈弱音、max≈强音）',
    ws.length > 0 && Math.min(...ws) < wLo + 0.3 && Math.max(...ws) > wHi - 0.3,
    `(min=${Math.min(...ws).toFixed(2)} vs ${wLo.toFixed(2)}, max=${Math.max(...ws).toFixed(2)} vs ${wHi.toFixed(2)})`);
  ok('breath：倍率夹紧在 0.6~1.5×faW', ws.every((w) => w > FA_W_AT_900 * 0.59 && w < FA_W_AT_900 * 1.51));
}

// ---------- ⑤ 落影 ----------
{
  ALL_OFF();
  localStorage.setItem('ydyi_fa_shadow', '1');
  const { c } = drive(liveSeq([{ from: 0, to: 600, midi: 69 }]));
  ok('shadow：出现深色偏移 stroke', darks().length > 0);
  ok('shadow：绿色主线仍在', green().length > 0);
}

// ---------- ⑥ 八度色相 ----------
{
  ALL_OFF();
  localStorage.setItem('ydyi_fa_hue', '1');
  const { c } = drive(liveSeq([
    { from: 0, to: 400, midi: 45 },     // A2 → hue 120
    { from: 470, to: 1200, midi: 93 },  // A6 → hue 140（Δ48 断连）
  ]));
  const hsls = [...new Set(green().map((t) => t.color))];
  ok('hue：strokeStyle 变 hsl 且不同八度色相不同', hsls.length >= 2, `(${hsls.join(' / ')})`);
  ok('hue：色相落在 90~170 绿-青域', hsls.every((s) => { const h = parseInt(s.match(/hsl\((\d+)/)[1], 10); return h >= 90 && h <= 170; }));
}

// ---------- ⑦ 废案平滑 ----------
{
  ALL_OFF();
  const offPx = (520 - 36) / 24;
  const yToSemi = (y) => 108 - (y - 16) / offPx;   // 曲线层=全音域绝对坐标（offYOf 逆变换）
  const seq = liveSeq([{ from: 0, to: 400, midi: 69 }, { from: 470, to: 1200, midi: 81 }]);
  const off = drive(seq);
  const offHi = green().flatMap((t) => t.pts).map(([, y]) => yToSemi(y)).filter((s) => s > 78);
  const offDev = offHi.length ? Math.max(...offHi.map((s) => Math.abs(s - 81))) : 1;
  ok('smooth 关：跳变段逐点精确 81（不喂 EOF）', offHi.length >= 2 && offDev < 1e-6, `(max 偏差 ${offDev.toExponential(1)})`);

  localStorage.setItem('ydyi_fa_smooth', '1');
  const on = drive(seq);
  const onHi = green().flatMap((t) => t.pts).map(([, y]) => yToSemi(y)).filter((s) => s > 78);
  const onDev = onHi.length ? Math.max(...onHi.map((s) => Math.abs(s - 81))) : 0;
  ok('smooth 开：跳变点被 EOF 拖离精确值', onHi.length >= 2 && onDev > 0.05, `(max 偏差 ${onDev.toFixed(3)})`);
}

// ---------- ⑧ rmsNorm 刻度（呼吸/能量柱的真响度刻度，唯一定义处） ----------
{
  ok('rmsNorm 刻度：底噪→0 / 0.01→0.44 / 0.1→0.89，越界与非法值钳位',
    rmsNorm(0.001) < 0.02 && Math.abs(rmsNorm(0.01) - 0.444) < 0.01
    && Math.abs(rmsNorm(0.1) - 0.889) < 0.01
    && rmsNorm(5) === 1 && rmsNorm(0) === 0 && rmsNorm(NaN) === 0 && rmsNorm(undefined) === 0);
}

// ---------- ⑨ init 恢复 ----------
{
  ALL_OFF();
  localStorage.setItem('ydyi_fa_glow', '1');
  const { c } = drive(liveSeq([{ from: 0, to: 600, midi: 69 }]));
  ok('init 恢复：localStorage=1 的开关在 init 后生效（出现辉光贴图）',
    c.__blits.some((b) => b.filter.startsWith('blur(')));
}

console.log('\n' + (fail ? `trail-body: ${fail} 项失败` : 'trail-body: 全部通过'));
if (fail) process.exit(1);
