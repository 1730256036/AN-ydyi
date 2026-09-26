// ============================================================
// test/trail-fx.mjs —— trailFx 视觉特效层契约守卫
//
// 守卫目标（每个都是可失效的强断言，不是空断言）：
//   ① 开关门控：四个效果各自独立开关，关闭时对应绘制零输出、发射口零发射；
//   ② 粒子合同：live=false 不发射（发射口看 live）；已发射的按真实时钟
//      飘完自然寿命（寿命到了被清场，场上不堆积）；
//   ③ 发射判据：涟漪只在"气口新起音"时发；火花只在同一笔段内 |Δsemi|>2
//      时发（跨气口 Δt>500ms 不发，长音 |Δ|≤2 不发）；
//   ④ 场上限：火花 ≤SPARK_MAX、涟漪 ≤RIPPLE_CAP，极端连发不堆积；
//   ⑤ 能量柱：采样进、按音频游标裁出，绘制条数=窗内柱数。
//
// 观测手法：trailFx 是纯状态+绘制函数（不碰 document），直接注入记录型
// 桩 ctx 数调用次数；时间用显式传入的 now（确定性，不依赖真实时钟）。
// ============================================================

import assert from 'node:assert/strict';
import {
  fxInit, fxSet, fxEnabled, fxReset, fxDump, fxOnSample, fxBar, fxCleanup,
  drawFxBars, drawFxSpectrum, drawFxOverlays, drawFxHead, fxFeed,
} from '../anim/trailFx.mjs';

function mkCtx() {
  const calls = { arc: 0, fill: 0, stroke: 0, fillRect: 0 };
  const api = {
    calls,
    beginPath() {}, setLineDash() {},
    arc() { calls.arc++; },
    fill() { calls.fill++; },
    stroke() { calls.stroke++; },
    fillRect() { calls.fillRect++; },
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  };
  return api;
}

const API = {
  now: 0,
  xOfT: (t) => t * 0.1,
  yOfSemi: (s) => 300 - s * 10,
};
const BARS_API = {
  winLo: 0, bottom: 400, maxH: 300, barW: 4,
  xOfT: (t) => t * 0.1,
};

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  ✓ ' + name);
}

// 每个用例前回到"全开 + 空场"
function fresh() {
  fxReset();
  for (const k of Object.keys(fxEnabled())) fxSet(k, true);
}

// —— ① 开关门控 ——
ok('彗星头：默认开=3个圆弧，关闭=零输出', () => {
  fresh();
  const c1 = mkCtx();
  drawFxHead(c1, 100, 200);
  assert.equal(c1.calls.arc, 3, '光晕=3层圆');
  fxSet('head', false);
  const c2 = mkCtx();
  drawFxHead(c2, 100, 200);
  assert.equal(c2.calls.arc, 0);
  assert.equal(c2.calls.fill, 0);
  assert.equal(c2.calls.stroke, 0);
});

ok('涟漪：关闭时发射口不收、绘制零输出；重开后恢复', () => {
  fresh();
  fxSet('ripple', false);
  fxOnSample({ tAudio: 1000, semi: 60, prevSemi: NaN, prevDtMs: NaN, isOnset: true, live: true, now: 100 });
  assert.equal(fxDump().ripples, 0, '关闭=不发射');
  fxSet('ripple', true);
  fxOnSample({ tAudio: 2000, semi: 60, prevSemi: NaN, prevDtMs: NaN, isOnset: true, live: true, now: 100 });
  assert.equal(fxDump().ripples, 1);
  const c = mkCtx(); API.now = 500;   // prog≈0.44：主环+副环都在场
  drawFxOverlays(c, API);
  assert.ok(c.calls.stroke >= 2, '主环+副环至少两次stroke，实际=' + c.calls.stroke);
});

ok('火花：关闭时零发射；开关立即清场', () => {
  fresh();
  fxOnSample({ tAudio: 1000, semi: 65, prevSemi: 60, prevDtMs: 46, isOnset: false, live: true, now: 100 });
  assert.equal(fxDump().sparks, 3, '一次转音=3颗');
  fxSet('spark', false);
  assert.equal(fxDump().sparks, 0, '关开关立即清场');
  fxOnSample({ tAudio: 1100, semi: 70, prevSemi: 65, prevDtMs: 46, isOnset: false, live: true, now: 150 });
  assert.equal(fxDump().sparks, 0);
  const c = mkCtx(); API.now = 200;
  drawFxOverlays(c, API);
  assert.equal(c.calls.fill, 0);
  fxSet('spark', true);
});

// —— ② 粒子合同 ——
ok('粒子合同：live=false 不发射（暂停/中断不吐新粒子）', () => {
  fresh();
  fxOnSample({ tAudio: 1000, semi: 60, prevSemi: NaN, prevDtMs: NaN, isOnset: true, live: false, now: 100 });
  assert.equal(fxDump().ripples, 0);
  fxOnSample({ tAudio: 1000, semi: 65, prevSemi: 60, prevDtMs: 46, isOnset: false, live: false, now: 100 });
  assert.equal(fxDump().sparks, 0);
});

ok('粒子合同：寿命按真实时钟到期清场（涟漪900ms/火花480ms）', () => {
  fresh();
  fxOnSample({ tAudio: 1000, semi: 60, prevSemi: NaN, prevDtMs: NaN, isOnset: true, live: true, now: 100 });
  fxOnSample({ tAudio: 1000, semi: 65, prevSemi: 60, prevDtMs: 46, isOnset: false, live: true, now: 100 });
  assert.ok(fxDump().ripples === 1 && fxDump().sparks === 3);
  const c1 = mkCtx(); API.now = 500;   // 涟漪期内、火花期内
  drawFxOverlays(c1, API);
  assert.ok(c1.calls.arc > 0 && c1.calls.fill > 0);
  const c2 = mkCtx(); API.now = 2000;  // 全部过期
  drawFxOverlays(c2, API);
  assert.equal(c2.calls.arc, 0);
  assert.equal(c2.calls.fill, 0);
  assert.equal(fxDump().ripples, 0);
  assert.equal(fxDump().sparks, 0);
});

// —— ③ 发射判据 ——
ok('涟漪节流：持续发声按 ~380ms 节奏发环，间隔内不重复；起音无视节流必发', () => {
  fresh();
  fxOnSample({ tAudio: 1000, semi: 60, prevSemi: NaN, prevDtMs: NaN, isOnset: true, live: true, now: 100 });
  assert.equal(fxDump().ripples, 1);
  fxOnSample({ tAudio: 1046, semi: 60.1, prevSemi: 60, prevDtMs: 46, isOnset: false, live: true, now: 150 });
  fxOnSample({ tAudio: 1092, semi: 60, prevSemi: 60.1, prevDtMs: 46, isOnset: false, live: true, now: 300 });
  assert.equal(fxDump().ripples, 1, '节流间隔内不重复');
  fxOnSample({ tAudio: 1138, semi: 60, prevSemi: 60, prevDtMs: 46, isOnset: false, live: true, now: 500 });
  assert.equal(fxDump().ripples, 2, '间隔到=继续泛环');
  fxOnSample({ tAudio: 1184, semi: 60, prevSemi: 60, prevDtMs: 46, isOnset: true, live: true, now: 510 });
  assert.equal(fxDump().ripples, 3, '起音无视节流');
});

ok('火花：持续发声常燃 1 颗/采样点；快速转音加量到 3 颗；跨气口(Δt>500ms)点不发', () => {
  fresh();
  fxOnSample({ tAudio: 1000, semi: 60, prevSemi: NaN, prevDtMs: NaN, isOnset: true, live: true, now: 100 });
  assert.equal(fxDump().sparks, 0, '首点无前点不发');
  fxOnSample({ tAudio: 1046, semi: 60.2, prevSemi: 60, prevDtMs: 46, isOnset: false, live: true, now: 120 });
  assert.equal(fxDump().sparks, 1, '持续发声=常燃');
  fxOnSample({ tAudio: 1092, semi: 66, prevSemi: 60.2, prevDtMs: 46, isOnset: false, live: true, now: 140 });
  assert.equal(fxDump().sparks, 1 + 3, '快速转音加量');
  fxOnSample({ tAudio: 2000, semi: 72, prevSemi: 66, prevDtMs: 900, isOnset: true, live: true, now: 160 });
  assert.equal(fxDump().sparks, 4, '跨气口那个点不发火花');
});

// —— ④ 场上限 ——
ok('场上限：极端连发不堆积（火花≤120）', () => {
  fresh();
  for (let i = 0; i < 100; i++) {
    fxOnSample({ tAudio: 1000 + i * 46, semi: 60 + (i % 2) * 8, prevSemi: 60 + ((i + 1) % 2) * 8, prevDtMs: 46, isOnset: false, live: true, now: 1000 + i });
  }
  assert.ok(fxDump().sparks <= 120, 'sparks=' + fxDump().sparks);
  assert.ok(fxDump().sparks > 0);
});

// —— ⑤ 能量柱 ——
ok('能量柱：采样进、游标裁出、绘制条数=窗内柱数、开关零输出', () => {
  fresh();
  for (let i = 0; i < 5; i++) fxBar(1000 + i * 46, 0.5);
  fxCleanup(2000);                       // 全部在 14s 保留窗内
  assert.equal(fxDump().bars, 5);
  fxCleanup(1000 + 5 * 46 + 15000);      // 推进游标 15s → 全部过期
  assert.equal(fxDump().bars, 0);
  for (let i = 0; i < 3; i++) fxBar(2000 + i * 46, 0.8);
  const c1 = mkCtx();
  drawFxBars(c1, { ...BARS_API, winLo: 1000 });
  assert.equal(c1.calls.fillRect, 3, '窗内3根柱画3个矩形');
  fxSet('bars', false);
  const c2 = mkCtx();
  drawFxBars(c2, { ...BARS_API, winLo: 1000 });
  assert.equal(c2.calls.fillRect, 0);
  fxSet('bars', true);
});

ok('能量柱：rms 钳到 0~1（NaN/越界不炸）', () => {
  fresh();
  fxBar(1000, NaN);
  fxBar(1046, 5);
  fxBar(1092, -3);
  assert.equal(fxDump().bars, 2, 'NaN丢弃，越界钳位');
});

ok('fxInit：localStorage 缺项=默认全开（node 无 localStorage 不炸）', () => {
  fxReset();
  fxInit();
  const e = fxEnabled();
  assert.deepEqual(e, { head: true, ripple: true, spark: true, bars: true });
});

// —— fxFeed 统一入口（录音活工程 drawProject 路径的关键判据）——
ok('fxFeed：首点=涟漪；持续发声=火花常燃+涟漪节流；跨气口=必发涟漪；能量柱同步进', () => {
  fresh();
  const t0 = 1000;
  fxFeed({ tAudio: t0, semi: 60, live: true, now: 100, energy: 0.5 });
  assert.ok(fxDump().ripples >= 1, '首点视为新起音');
  assert.equal(fxDump().sparks, 0, '首点无前点');
  for (let i = 1; i <= 5; i++) {
    fxFeed({ tAudio: t0 + i * 46, semi: 60.1, live: true, now: 100 + i, energy: 0.5 });
  }
  assert.equal(fxDump().sparks, 5, '常燃火花每采样点 1 颗');
  assert.equal(fxDump().ripples, 1, 'now 101~105 均在节流间隔内');
  fxFeed({ tAudio: t0 + 6 * 46, semi: 66, live: true, now: 500, energy: 0.5 });
  assert.equal(fxDump().sparks, 5 + 3, '段内大跳加量');
  assert.equal(fxDump().ripples, 2, '500-100=400ms ≥ 节流间隔');
  fxFeed({ tAudio: t0 + 6 * 46 + 800, semi: 66.2, live: true, now: 700, energy: 0.5 });
  assert.equal(fxDump().sparks, 8, '跨气口点不发火花');
  assert.equal(fxDump().ripples, 3, '气口新起音无视节流必发');
  assert.equal(fxDump().bars, 8, '每次喂入都记能量柱');
});

ok('fxFeed 高水位：整窗旧点升序重放（drawProject 每帧行为）不重复发射', () => {
  fresh();
  const t0 = 1000;
  const seq = [];
  seq.push([t0, 60]);
  for (let i = 1; i <= 5; i++) seq.push([t0 + i * 46, 60.1]);
  seq.push([t0 + 6 * 46, 66]);            // 一次大跳
  for (const [t, s] of seq) fxFeed({ tAudio: t, semi: s, live: true, now: 100, energy: 0.5 });
  const before = fxDump();
  assert.ok(before.sparks === 8 && before.ripples === 1, '基线：常燃+加量共8颗、首点1环');
  for (const [t, s] of seq) {             // 模拟下一渲染帧：全窗重放
    fxFeed({ tAudio: t, semi: s, live: true, now: 133, energy: 0.5 });
  }
  assert.deepEqual(fxDump(), before, '重放零新增发射');
});

ok('fxFeed seek 回退：往回喂的旧点完全忽略；越过水位继续前进恢复发射', () => {
  fresh();
  fxFeed({ tAudio: 5000, semi: 60, live: true, now: 100, energy: 0.5 });
  const r0 = fxDump().ripples;
  fxFeed({ tAudio: 2000, semi: 72, live: true, now: 150, energy: 0.5 });   // 回跳
  assert.equal(fxDump().ripples, r0, '回退点不发射');
  fxFeed({ tAudio: 5800, semi: 60, live: true, now: 200, energy: 0.5 });   // 越过水位 + Δt>500ms
  assert.ok(fxDump().ripples > r0, '重新越过水位前进=正常发射');
});

ok('fxReset 清高水位：复位后（新片段）首点重新视为起音', () => {
  fresh();
  fxFeed({ tAudio: 9000, semi: 60, live: true, now: 100, energy: 0.5 });
  fxReset();
  fxFeed({ tAudio: 100, semi: 60, live: true, now: 200, energy: 0.5 });
  assert.ok(fxDump().ripples >= 1, '复位后小 t 也能起涟漪');
});

// —— 真频谱背景（升级自响度柱；同一开关 ydyi_fx_bars）——
ok('频谱背景：超噪声门画 48 根柱返回 true；纯底噪/开关关/无频谱返回 false（回落响度柱）', () => {
  fresh();
  const spec = new Float32Array(512).fill(0.8);   // 全频段超噪声门（(dB+100)/100 量纲）
  const c1 = mkCtx();
  const r1 = drawFxSpectrum(c1, { spec, specFmax: 8000, x0: 0, x1: 480, bottom: 400, maxH: 300 });
  assert.equal(r1, true, '有超门频谱=画成');
  assert.equal(c1.calls.fillRect, 48, '48 根 log 频轴柱');
  const c1b = mkCtx();
  const rNoise = drawFxSpectrum(c1b, { spec: new Float32Array(512).fill(0.1), specFmax: 8000, x0: 0, x1: 480, bottom: 400, maxH: 300 });
  assert.equal(rNoise, false, '纯底噪(0.1<门限0.3)=不画（防"没声音也有律动"）');
  assert.equal(c1b.calls.fillRect, 0);
  fxSet('bars', false);
  const c2 = mkCtx();
  const r2 = drawFxSpectrum(c2, { spec, specFmax: 8000, x0: 0, x1: 480, bottom: 400, maxH: 300 });
  assert.equal(r2, false, '开关关=不画');
  assert.equal(c2.calls.fillRect, 0);
  fxSet('bars', true);
  const r3 = drawFxSpectrum(mkCtx(), { spec: null, specFmax: 0, x0: 0, x1: 480, bottom: 400, maxH: 300 });
  assert.equal(r3, false, '无频谱数据=回落（pitchTrail 转画响度柱）');
});

console.log('\ntrail-fx: ' + pass + ' 用例全部通过');
