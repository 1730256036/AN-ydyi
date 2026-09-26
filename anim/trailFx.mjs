// ============================================================
// anim/trailFx.mjs —— 废案档视觉特效层（2026-09-21 新增）
//
// 定位（全部做成可选）：
//   四个效果 = 彗星头部 / 起音涟漪 / 转音火花 / 律动背景。
//   全部是【叠加瞬时层】：不动曲线本体一个符号（classic 与 feian 的
//   观感硬约束都不碰），只在 feian 档由 pitchTrail 调用；
//   每个效果独立开关，localStorage 'ydyi_fx_*' 持久化，默认全开。
//   整个文件删掉 + pitchTrail 里几行调用 = 零侵入回退。
//
// 粒子合同（01c0b45 定稿）遵守：
//   - 发射口看 d.live（pitchTrail 传入）：中断/暂停不吐新粒子；
//   - 物理寿命用真实时钟（performance.now）：任何中断飘完自然寿命，
//     不由 audioMs 冻结；
//   - 位置锚定在（音频时间 t, 半音 semi）空间，绘制时经 xOfT/yOfSemi
//     映射到屏幕 → 视口滚动/纵轴平移时特效跟着曲线走。
//
// 判据（2026-09-21 二轮："触发时机不好，统一放彗星头部，有声音就始终触发"）：
//   - 涟漪 = 持续发声时从当前演唱点按 RIPPLE_EVERY_MS 节奏泛出（起音瞬间必发一个），
//     锚在出生点随时间轴左移 → 沿路径留下一串 blooming 环；
//   - 火花 = 持续发声常燃（每个采样点 1 颗），快速转音（|Δsemi|>2 且同笔段）加量到
//     SPARK_PER 颗；跨气口（Δt>500ms）那个点不发。
// ============================================================

// —— 可调 ——
const RIPPLE_MS = 900;        // 涟漪寿命(ms)：一圈扩散+消散
const RIPPLE_EVERY_MS = 380;  // 持续发声时涟漪泛出节奏(ms)：~2.6 环/s，同屏 2~3 环
const RIPPLE_R0 = 5;          // 涟漪起始半径(px)
const RIPPLE_R1 = 30;         // 涟漪最大半径(px)
const SPARK_LIFE_MS = 480;    // 火花寿命(ms)
const SPARK_PER = 3;          // 每次转音采样点发射颗数
const SPARK_MAX = 120;        // 场上火花上限(防极端连转音堆积)
const SPARK_TRIGGER_SEMI = 2; // 触发阈值：|Δsemi| 超过此值(与 FA_GLIDE_MIN_SEMI 一致)
const SPARK_WITHIN_MS = 500;  // 只在同一笔段内触发(Δt ≤ FA_FIT_MS)
const RIPPLE_CAP = 40;        // 场上涟漪上限
const BAR_KEEP_MS = 14000;    // 能量柱历史保留(> 可视窗 10s + 2s 裁剪余量)
const BAR_CAP = 400;          // 能量柱历史条数上限(10s@46ms ≈ 220，留余量)
const FA_GREEN = '#4be15f';
const SPARK_AMBER = '#ef9f27';

// 火花速度模式表(确定性循环，不引入随机 → 守卫可断言)：vx=px/s，vy=半音/s
const SPARK_PAT = [
  { vx: 80, vy: 12, size: 2.2, white: false },
  { vx: 45, vy: 18, size: 1.6, white: true },
  { vx: 110, vy: 8, size: 2.5, white: false },
  { vx: 60, vy: 15, size: 1.8, white: false },
  { vx: -50, vy: 20, size: 1.5, white: true },
  { vx: 90, vy: 10, size: 2.0, white: false },
];

const FX_KEYS = { head: 1, ripple: 1, spark: 1, bars: 1 };
let on = { head: true, ripple: true, spark: true, bars: true };

let ripples = [];   // {tA:音频时钟ms, semi, born:真实时钟ms}
let sparks = [];    // {tA, semi, vx, vy, born, size, white}
let bars = [];      // {t:音频时钟ms, e:0~1}
let sparkSeq = 0;
let lastRippleBorn = -Infinity;   // 涟漪节流锚（真实时钟）

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// 恢复四个开关(默认全开；localStorage 缺项/异常都落默认)
export function fxInit() {
  for (const k of Object.keys(FX_KEYS)) {
    on[k] = lsGet('ydyi_fx_' + k) !== '0';
  }
}
export function fxSet(k, v) {
  if (!FX_KEYS[k]) return;
  on[k] = !!v;
  // 瞬时粒子在关开关瞬间立即清场（确定性语义，不靠下次绘制懒清理）
  if (k === 'ripple' && !on.ripple) { ripples = []; lastRippleBorn = -Infinity; }
  if (k === 'spark' && !on.spark) sparks = [];
  lsSet('ydyi_fx_' + k, on[k] ? '1' : '0');
}
export function fxEnabled() { return { ...on }; }
export function fxReset() { ripples = []; sparks = []; bars = []; sparkSeq = 0; lastRippleBorn = -Infinity; hiT = -Infinity; lastSpawned = null; }
export function fxDump() { return { ripples: ripples.length, sparks: sparks.length, bars: bars.length }; }

// —— 统一喂入口（2026-09-21 补：录音走 drawProject「录音活工程」路径——
//   projMode=true 时 pitchTrail 根本不走 drawLive，特效必须两条路都喂）——
// o = { tAudio, semi, live, now, energy(0~1：实时=d.rms，工程=promNorm(prom)) }
// ⚠ 边沿检测用【高水位 hiT】而不是"上一点"锚：drawProject 每帧从窗口左缘
//   把全部旧点【升序重放】一遍，若用 lastPt 锚会被重放洗回最旧点 → 整窗
//   转音/起音每帧重新发射。高水位语义：只有 t 严格超过历史最高水位的点才
//   可能发射；重放（升序过旧点）、seek 往回拖一律完全忽略；水位只涨不降。
//   发射点的 prev = 上一个【发射过】的点（跨水位前进时的正确邻居）。
let cfg = { fitMs: 500, triggerSemi: 2 };
let hiT = -Infinity;      // 已发射水位（音频时钟 ms）
let lastSpawned = null;   // 最后发射点 {t, semi}
export function fxConfig(c) {
  if (c && Number.isFinite(c.fitMs)) cfg.fitMs = c.fitMs;
  if (c && Number.isFinite(c.triggerSemi)) cfg.triggerSemi = c.triggerSemi;
}
export function fxFeed(o) {
  if (o.tAudio <= hiT) return;                    // 旧点重放/回退：完全忽略（含能量柱，防重放翻倍）
  if (Number.isFinite(o.energy)) fxBar(o.tAudio, o.energy);
  const prev = lastSpawned;
  const dt = prev ? o.tAudio - prev.t : NaN;
  fxOnSample({
    tAudio: o.tAudio, semi: o.semi,
    prevSemi: prev ? prev.semi : NaN,
    prevDtMs: Number.isFinite(dt) ? dt : NaN,
    isOnset: !prev || dt > cfg.fitMs,
    live: !!o.live, now: o.now,
  });
  fxCleanup(o.tAudio);
  hiT = o.tAudio;
  lastSpawned = { t: o.tAudio, semi: o.semi };
}

// —— 发射口：pitchTrail 的 feian 采样分支每接受一个点调一次 ——
// o = { tAudio, semi, prevSemi(NaN=无前点), prevDtMs(NaN=无前点),
//       isOnset(气口新起音放行), live(此刻真有音频流), now(performance.now()) }
export function fxOnSample(o) {
  const now = o.now;
  // 涟漪：持续发声按 RIPPLE_EVERY_MS 节奏从当前点泛出；起音瞬间无视节流必发
  if (o.live && on.ripple && ripples.length < RIPPLE_CAP
      && (o.isOnset || now - lastRippleBorn >= RIPPLE_EVERY_MS)) {
    ripples.push({ tA: o.tAudio, semi: o.semi, born: now });
    lastRippleBorn = now;
  }
  // 火花：持续发声常燃 1 颗/采样点；快速转音（同笔段内 |Δ|>2）加量到 SPARK_PER；
  // 跨气口（Δt>500ms）那个点不发（过渡瞬间由涟漪负责）
  if (o.live && on.spark && Number.isFinite(o.prevSemi)
      && Number.isFinite(o.prevDtMs) && o.prevDtMs <= SPARK_WITHIN_MS) {
    const dS = o.semi - o.prevSemi;
    const n = Math.abs(dS) > SPARK_TRIGGER_SEMI ? SPARK_PER : 1;
    const dir = dS >= 0 ? 1 : -1;
    for (let i = 0; i < n && sparks.length < SPARK_MAX; i++) {
      const pat = SPARK_PAT[sparkSeq % SPARK_PAT.length];
      sparkSeq++;
      sparks.push({
        tA: o.tAudio,
        semi: o.semi + dir * 0.6,          // 沿滑动方向偏出半格起跳
        vx: pat.vx, vy: dir * pat.vy,      // vy 沿发声方向(向上=向上飞)
        born: now, size: pat.size, white: pat.white,
      });
    }
  }
}

// —— 能量柱采样：每个 feian 采样点记一次音量(0~1) ——
export function fxBar(t, rms) {
  if (!Number.isFinite(rms)) return;
  bars.push({ t, e: Math.max(0, Math.min(1, rms)) });
  if (bars.length > BAR_CAP) bars.splice(0, bars.length - BAR_CAP);
}
// 随音频游标推进裁掉窗外旧柱(pitchTrail 每采样点调一次)
export function fxCleanup(aMs) {
  while (bars.length && bars[0].t < aMs - BAR_KEEP_MS) bars.shift();
}

// —— 绘制：律动背景（垫在网格/曲线之下，pitchTrail 在 clearRect 后调用）——
// api = { winLo, bottom, maxH, barW, xOfT(t) }
export function drawFxBars(g, api) {
  if (!on.bars) return;
  const { winLo, bottom, maxH, barW, xOfT } = api;
  for (const b of bars) {
    if (b.t < winLo) continue;
    const x = xOfT(b.t);
    const h = Math.max(2, b.e * maxH * 0.32);
    g.fillStyle = 'rgba(75,225,95,' + (0.05 + b.e * 0.10).toFixed(3) + ')';
    g.fillRect(x - barW / 2, bottom - h, barW, h);
  }
}

// —— 绘制：真频谱背景（对数频轴，48 柱）——
// 实时路径有逐帧频谱（d.spectrum），画 log 频轴柱状（80Hz~8kHz，48 根）；
// 画成了返回 true，pitchTrail 据此跳过响度柱；无频谱（工程回放/未运行）返回 false
// → 回落 drawFxBars 响度柱。同一开关 ydyi_fx_bars 管，内容随数据源自动切换。
// api = { spec(Float32Array), specFmax, x0, x1, bottom, maxH }
const FX_SPEC_FLOOR = 0.3;    // 噪声门：低于此值视为底噪不画（可调）
export function drawFxSpectrum(g, api) {
  if (!on.bars) return false;
  const { spec, specFmax, x0, x1, bottom, maxH } = api;
  if (!spec || !spec.length || !(specFmax > 0) || !(x1 > x0)) return false;
  const N = 48, f0 = 80, f1 = Math.min(specFmax, 8000);
  if (!(f1 > f0)) return false;
  const vals = new Array(N);
  let mx = 0;
  for (let k = 0; k < N; k++) {
    const f = f0 * Math.pow(f1 / f0, k / (N - 1));
    const bin = Math.min(spec.length - 1, Math.round(f / specFmax * spec.length));
    // ⚠ spec 量纲 = (dB+100)/100 的 0~1 幅度：房间底噪就有 0.2~0.3，
    //   必须绝对量纲+噪声门——按最大值归一化会把底噪放大成满幅乱跳
    //   （真机实测"没声音也有律动"）。
    const raw = Math.max(0, Number(spec[bin]) || 0);
    const v = Math.max(0, (raw - FX_SPEC_FLOOR) / (1 - FX_SPEC_FLOOR));
    vals[k] = v;
    if (v > mx) mx = v;
  }
  if (!(mx > 0.02)) return false;              // 全是底噪：不画（安静=干净背景）
  const bw = (x1 - x0) / N;
  for (let k = 0; k < N; k++) {
    const v = vals[k];
    const h = v * maxH * 0.45;
    if (h <= 0) continue;
    g.fillStyle = 'rgba(75,225,95,' + (0.05 + v * 0.10).toFixed(3) + ')';
    g.fillRect(x0 + k * bw, bottom - h, Math.max(1, bw - 1), h);
  }
  return true;
}

// —— 绘制：涟漪 + 火花（叠加在曲线之上；寿命由真实时钟驱动，暂停也飘完）——
// api = { now, xOfT(t), yOfSemi(semi) }
export function drawFxOverlays(g, api) {
  const { now, xOfT, yOfSemi } = api;
  if (on.ripple) {
    ripples = ripples.filter((r) => now - r.born < RIPPLE_MS);
    for (const r of ripples) {
      const prog = (now - r.born) / RIPPLE_MS;
      const x = xOfT(r.tA), y = yOfSemi(r.semi);
      g.setLineDash([4, 4]);
      g.strokeStyle = FA_GREEN;
      g.lineWidth = 1.5;
      for (const off of [0, 0.3]) {          // 主环 + 滞后 30% 的副环
        const p = prog - off;
        if (p <= 0 || p >= 1) continue;
        const rad = RIPPLE_R0 + (RIPPLE_R1 - RIPPLE_R0) * p;
        g.globalAlpha = (1 - p) * 0.7;
        g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.stroke();
      }
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
  } else if (ripples.length) {
    ripples = [];                            // 关开关立即清场
  }
  if (on.spark) {
    sparks = sparks.filter((s) => now - s.born < SPARK_LIFE_MS);
    for (const s of sparks) {
      const age = (now - s.born) / 1000;
      const x = xOfT(s.tA) + s.vx * age;
      const y = yOfSemi(s.semi + s.vy * age);
      g.globalAlpha = Math.max(0, 1 - (now - s.born) / SPARK_LIFE_MS);
      g.fillStyle = s.white ? '#ffffff' : SPARK_AMBER;
      g.beginPath(); g.arc(x, y, s.size, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  } else if (sparks.length) {
    sparks = [];
  }
}

// —— 绘制：彗星头部（当前演唱点光晕；pitchTrail 在 drawCursorAt 后、voiced 时调用）——
export function drawFxHead(g, x, y) {
  if (!on.head) return;
  g.fillStyle = 'rgba(75,225,95,.15)';
  g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(75,225,95,.30)';
  g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  g.strokeStyle = FA_GREEN;
  g.lineWidth = 2;
  g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
}
