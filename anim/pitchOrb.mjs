// ============================================================
// anim/pitchOrb.mjs —— 音高星盘（默认模板, kind:'pitch'）
//
// 定位：不是"装饰动画"，而是【一屏能读懂当前发声状态】的仪器盘。
// 2026-09-19 晚二次重做：
//   - 视口随当前音垂直滚动：音高线（检测到声音后出现的横向游标）恒钉在画面
//     正中，半音格作为"世界"上下滚动（视口可见 28 个半音 ≈ 2.3 个八度）。
//     滚动走实测 dt 缓动，帧率无关；无声音时视口冻结不漂移。
//   - 名字「音高仪表」→「音高星盘」（模板 id 仍为 pitchOrb，localStorage/
//     测试引用不动）。
// 版式（左栏读数 / 中部滚动音高场+星尘 / 右缘音域，互不重叠）：
//   ① 中部滚动音高场：半音细格 + C 标注 + 中央 C 虚线；当前音为一条恒在
//      正中的横游标（右端光点按音高类配色，与钢琴块同一套色）
//   ② 星尘粒子（随音而起的粒子云）：
//      粒子云水平居中、贴着音高线；每个粒子的目标高度记在【音高空间】
//      （tyM=midi），所以换音/滚屏时旧粒子会"留在原音高处"被视口带走——
//      像拖出一条星迹，而不是一团糊在屏幕中央的雾。换音/起音瞬间从
//      音高场正中喷一圈爆发粒子，长音持续细流；音量决定喷发量。
//   ③ 右缘音域热力柱：每半音累计停留时长（sqrt 压缩）→ 本曲音域热力图，
//      最低/最高音带三角标；随视口一起滚动；换片段(resetKey)自动清空
//   ④ 左栏读数：大音名 + Hz + ±50¢ 音准条（准=青 / 微偏=琥珀 / 大偏=红）
//
// 保持态（HOLD_MS=260ms，与 app.mjs CFG.noteHoldMs 同值）：
//   发声中断不足 260ms 时不立刻黑屏，而是把上一次的音高画成【虚线 + 空心圈 + 半透明读数】。
//   理由：HUD 音名本就保持 260ms，pitchTrail/pianoBlocks 还会画「voiced=false 但 freq>0」
//   的桥接帧；本模板若只看当帧 voiced，一个气口就整屏空白，观感变成"检测不到声音"。
//   保持态是明确变暗/虚线的，不会被误读成实时检测值；音准指针在保持态不给（旧值指音分会误导）。
//   热力图只在真发声时累积，保持态不计入，避免音域统计被气口污染。
//   粒子在保持态不喷发、存活粒子自然飘散，不额外注入"假发声"。
//
// 音准读数来源：本模板不自算任何音高/音分——d.freq/d.cents 全部来自
// dsp/detect.mjs 的唯一检测实现（经 snapshot 下发），模板只做
// midiOf/±50¢ 线性映射的显示，与 HUD 音名同一数据源。
//
// 数据：d.voiced / d.freq / d.cents / d.prom / d.seenAny / d.statsMin / d.statsMax / d.resetKey / d.live
// 缓动与粒子物理全部用 now 的实测 dt：帧率无关，掉帧不会让画面跳跃追赶。
// ============================================================
import {
  clamp, clamp01, promNorm, midiOf, noteName, pclassOf, pcHsl,
  BG, ACCENT, approach,
} from './viz-common.mjs';

const RAIL_W = 104;                   // 左栏读数宽度
const HEAT_W = 16;                    // 右缘热力柱宽度
const CURSOR_RATE = 16;               // 视口滚动缓动速率(1/s)
const HOLD_MS = 260;                  // 短暂气口的"保持显示"时长(与 app.mjs CFG.noteHoldMs 同值)
const VIEW_SPAN = 28;                 // 视口可见半音数（约 2.3 个八度）

// ---- 星尘粒子（自 particle.mjs 合并）----
const MAX_P = 600;                    // 粒子池上限（固定池环形覆写，永不 splice，避免 GC 抖动）
const RATE_BASE = 80;                 // 基础喷发速率(个/秒)
const SPRING = 26;                    // 拉向目标音高的弹簧刚度
const DRAG = 2.2;                     // 速度阻尼
const LIFE_S = 1.2;                   // 粒子基础寿命(秒)

let ctx = null, W = 0, H = 0;
let lastNow = 0;
const heat = new Float32Array(128);   // 每半音累计停留时长(秒)
let heatMax = 0.001;
let heatKey = -2;                     // 片段代际：换片段清空热力图
let centerM = 60;                     // 视口中心音高(midi, 缓动)——音高线恒在 H/2
let holdFreq = NaN, lastVoicedT = -1e9;  // 保持态：最近一次真发声的频率与时刻

// 粒子池
const pool = [];
let head = 0, emitAcc = 0, lastPc = -1, lastPartVoiced = false;

// ---- 渲染缓存（P1：每帧 new 渐变对象会堆积 GC，按 音高类+几何尺寸 缓存）----
const gradCache = new Map();          // 'line|pc' / 'halo|pc' -> CanvasGradient
let geoKey = '';                      // 几何代数：W/H 变化后旧渐变整体作废

export default {
  id: 'pitchOrb',
  name: '音高星盘',
  kind: 'pitch',

  init(c, w, h) {
    ctx = c; W = w; H = h;
    lastNow = 0; centerM = 60; holdFreq = NaN; lastVoicedT = -1e9;
    gradCache.clear();
    clearParticles();
  },
  resize(w, h) { W = w; H = h; gradCache.clear(); },

  frame(d, now) {
    if (!ctx) return;
    const dt = lastNow ? clamp((now - lastNow) / 1000, 0, 0.10) : 1 / 60;
    lastNow = now;
    // 画布上下文是全模板共享的：整帧包在 save/restore 里，
    // 保证本模板设置的 textAlign/lineWidth/globalAlpha/globalCompositeOperation 不会泄漏给别的模板。
    ctx.save();

    if (d.resetKey !== heatKey) {
      heatKey = d.resetKey; heat.fill(0); heatMax = 0.001;
      holdFreq = NaN; lastVoicedT = -1e9;
      clearParticles();
    }

    const active = d.voiced && Number.isFinite(d.freq) && d.freq > 0;
    if (active) { holdFreq = d.freq; lastVoicedT = now; }
    // 短暂气口不闪烁：与 app.mjs CFG.noteHoldMs 同值(260ms)。
    // 这是全应用既有语义——HUD 音名本就保持 260ms，pitchTrail/pianoBlocks 还会把
    // 「voiced=false 但 freq>0」的桥接帧画成细弱线；只看当帧 voiced 的话，
    // 一个气口就整屏黑掉，观感成了"检测不到声音"。保持期内画成明确变暗的"保持态"。
    const age = now - lastVoicedT;
    const ghost = !active && Number.isFinite(holdFreq) && age <= HOLD_MS;

    // 视口滚动：音高线恒在正中，滚的是半音格。只在有声/保持态时跟随，
    // 空闲时冻结（否则每次切模板/停录音视口会自己漂走）。
    if (active || ghost) {
      centerM = approach(centerM, midiOf(active ? d.freq : holdFreq), CURSOR_RATE, dt);
    }

    const L = layout();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    drawField(L);
    // 星尘垫在下层：游标/读数/热力柱都画在粒子之上，加色混合不会盖住文字
    updateParticles(d, L, dt, active, now);

    if (active || ghost) {
      const f = active ? d.freq : holdFreq;
      const m = midiOf(f);
      if (active) {
        const idx = clamp(Math.round(m), 0, 127);
        heat[idx] += dt * (0.6 + promNorm(d.prom));   // 只有真发声才进热力图（prom→0~1 见 viz-common.promNorm）
        if (heat[idx] > heatMax) heatMax = heat[idx];
      }
      ctx.globalAlpha = active ? 1 : 0.12 + 0.5 * (1 - age / HOLD_MS);
      drawCursor(L, m, active);
      ctx.globalAlpha = 1;
      drawRail(f, active, active ? d.cents : 0);
    } else {
      drawRail(NaN, false, 0);
      if (!d.seenAny) drawIdleHint();
    }

    drawHeat(d, L);
    ctx.restore();
  },
};

// ---- 布局：一次算清，所有绘制共用（避免各函数各算一套导致错位） ----
// 音高线恒在 H/2：yOf(m) = H/2 + (centerM - m) * pxPerSemi（音越高 y 越小）
function layout() {
  geoKey = Math.round(W) + 'x' + Math.round(H);   // 渐变缓存的几何代数
  const padTop = Math.max(18, H * 0.06), padBot = 12;
  const pxPerSemi = (H - padTop - padBot) / VIEW_SPAN;
  const yOf = (m) => H / 2 + (centerM - m) * pxPerSemi;
  const heatX = W - HEAT_W - 2;
  return {
    padTop, padBot, pxPerSemi, yOf, heatX, fieldR: heatX - 4,
    viewLo: centerM - VIEW_SPAN / 2, viewHi: centerM + VIEW_SPAN / 2,
  };
}

// ---- 音高场：半音细格 + C 标注 + 中央 C 虚线（随视口滚动） ----
function drawField(L) {
  const mFrom = Math.max(0, Math.floor(L.viewLo) - 1);
  const mTo = Math.min(127, Math.ceil(L.viewHi) + 1);
  ctx.lineWidth = 1;
  for (let m = mFrom; m <= mTo; m++) {
    const y = L.yOf(m);
    if (y < L.padTop - L.pxPerSemi || y > H - L.padBot + L.pxPerSemi) continue;
    const isC = pclassOf(m) === 0;
    ctx.strokeStyle = isC ? 'rgba(230,233,238,.13)' : 'rgba(230,233,238,.045)';
    ctx.beginPath(); ctx.moveTo(RAIL_W, y + 0.5); ctx.lineTo(L.fieldR, y + 0.5); ctx.stroke();
    if (isC) {
      ctx.fillStyle = 'rgba(230,233,238,.40)';
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('C' + (Math.floor(m / 12) - 1), RAIL_W - 6, y);
    }
  }
  const c4 = L.yOf(60);
  if (c4 > L.padTop && c4 < H - L.padBot) {
    ctx.strokeStyle = 'rgba(125,211,252,.26)';
    ctx.setLineDash([5, 7]);
    ctx.beginPath(); ctx.moveTo(RAIL_W, c4 + 0.5); ctx.lineTo(L.fieldR, c4 + 0.5); ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---- 音高游标：恒在画面正中的横线（左淡右实）+ 右端光点（渐变按 pc 缓存） ----
function drawCursor(L, m, live) {
  const y = H / 2;
  const pc = pclassOf(m);
  let g = gradCache.get('line|' + pc);
  if (!g) {
    g = ctx.createLinearGradient(RAIL_W, 0, L.fieldR, 0);
    g.addColorStop(0, pcHsl(pc, 85, 62, 0));
    g.addColorStop(0.5, pcHsl(pc, 85, 62, 0.45));
    g.addColorStop(1, pcHsl(pc, 85, 62, 0.95));
    gradCache.set('line|' + pc, g);
  }
  ctx.strokeStyle = g; ctx.lineWidth = live ? 1.5 : 1;
  // 保持态画虚线：不用文字解释也能一眼看出"这是上一次的读数，不是此刻"
  if (!live) ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(RAIL_W, y); ctx.lineTo(L.fieldR, y); ctx.stroke();
  ctx.setLineDash([]);

  const r = clamp(Math.min(W, H) * 0.026, 6, 14);
  const cx = L.fieldR - r;
  if (live) {
    // 光点中心/半径在同一几何代数下是常量 → 径向渐变可安全缓存
    let halo = gradCache.get('halo|' + pc);
    if (!halo) {
      halo = ctx.createRadialGradient(cx, y, r * 0.3, cx, y, r * 3.2);
      halo.addColorStop(0, pcHsl(pc, 90, 62, 0.5));
      halo.addColorStop(1, pcHsl(pc, 90, 62, 0));
      gradCache.set('halo|' + pc, halo);
    }
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, y, r * 3.2, 0, 7); ctx.fill();
    ctx.fillStyle = pcHsl(pc, 88, 64);
    ctx.beginPath(); ctx.arc(cx, y, r, 0, 7); ctx.fill();
  } else {
    // 空心圈 = 保持态（区别于实心=此刻真发声）
    ctx.strokeStyle = pcHsl(pc, 88, 64); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, y, r, 0, 7); ctx.stroke();
  }
}

// ---- 左栏读数：大音名 + Hz + 音准条 ----
function drawRail(freq, live, cents) {
  const x = 12;
  const bigY = H * 0.30;
  if (Number.isFinite(freq) && freq > 0) {
    ctx.fillStyle = live ? 'rgba(230,233,238,.96)' : 'rgba(230,233,238,.55)';
    ctx.font = '500 ' + clamp(Math.round(H * 0.058), 26, 44) + 'px "Segoe UI", sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(noteName(midiOf(freq)), x, bigY);
    ctx.fillStyle = live ? 'rgba(230,233,238,.50)' : 'rgba(230,233,238,.28)';
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillText(freq.toFixed(1) + ' Hz', x, bigY + 18);
  } else {
    ctx.fillStyle = 'rgba(230,233,238,.18)';
    ctx.font = '500 ' + clamp(Math.round(H * 0.058), 26, 44) + 'px "Segoe UI", sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('--', x, bigY);
  }
  // 音准表只在真发声时给指针：保持态拿旧值指音分会误导
  drawCentsMeter(live ? clamp(Number.isFinite(cents) ? cents : 0, -50, 50) : null, x, bigY + 40);
}

// ±50¢ 音准条：-50 在左端、0 居中刻度、+50 在右端，指针线性映射
// px = x + bw*(cents+50)/100 —— 与 dsp 侧 cents=(midi-round(midi))*100 同一口径
function drawCentsMeter(cents, x, y) {
  const bw = RAIL_W - 24;
  ctx.strokeStyle = 'rgba(230,233,238,.16)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + 0.5); ctx.lineTo(x + bw, y + 0.5); ctx.stroke();
  for (const t of [-50, -25, 0, 25, 50]) {
    const px = x + bw * (t + 50) / 100;
    const h = t === 0 ? 7 : 3;
    ctx.strokeStyle = t === 0 ? 'rgba(125,211,252,.65)' : 'rgba(230,233,238,.22)';
    ctx.beginPath(); ctx.moveTo(px + 0.5, y - h / 2); ctx.lineTo(px + 0.5, y + h / 2); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(230,233,238,.32)';
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('音准 ¢', x, y + 8);
  if (cents == null) return;
  const a = Math.abs(cents);
  const col = a > 15 ? '#f87171' : a > 5 ? '#fbbf24' : ACCENT;
  const px = x + bw * (cents + 50) / 100;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(px, y + 4); ctx.lineTo(px - 3.5, y + 10); ctx.lineTo(px + 3.5, y + 10);
  ctx.closePath(); ctx.fill();
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText((cents > 0 ? '+' : '') + cents.toFixed(0), x + bw, y + 16);
}

// ---- 右缘音域热力柱：随视口滚动，亮度 = 累计停留时长 ----
function drawHeat(d, L) {
  const mFrom = Math.max(0, Math.floor(L.viewLo) - 1);
  const mTo = Math.min(127, Math.ceil(L.viewHi) + 1);
  const cell = L.pxPerSemi;
  ctx.fillStyle = 'rgba(8,11,16,.7)';
  ctx.fillRect(L.heatX, 0, HEAT_W, H);
  for (let m = mFrom; m <= mTo; m++) {
    const v = heat[m];
    if (!(v > 0)) continue;
    const t = Math.sqrt(clamp01(v / heatMax));
    const y = L.yOf(m) - cell / 2;
    ctx.fillStyle = pcHsl(pclassOf(m), 80, 34 + 40 * t, 0.10 + 0.82 * t);
    ctx.fillRect(L.heatX + 1, y + 0.5, HEAT_W - 2, Math.max(1, cell - 1));
  }
  if (d.seenAny) {
    ctx.fillStyle = ACCENT;
    const mark = (m) => {
      if (!Number.isFinite(m) || m <= 0) return;
      const y = L.yOf(m);
      if (y < 0 || y > H) return;   // 已滚出视口的极值不画
      ctx.beginPath();
      ctx.moveTo(L.heatX - 3, y); ctx.lineTo(L.heatX - 8, y - 4); ctx.lineTo(L.heatX - 8, y + 4);
      ctx.closePath(); ctx.fill();
    };
    mark(d.statsMax); mark(d.statsMin);
  }
  ctx.fillStyle = 'rgba(230,233,238,.26)';
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('音域', L.heatX + HEAT_W / 2, 3);
}

function drawIdleHint() {
  ctx.fillStyle = 'rgba(230,233,238,.20)';
  ctx.font = '13px "Segoe UI", sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('发声后音高线恒在正中，星尘随音而起', 12, H * 0.62);
}

// ============================================================
// 星尘粒子（自 anim/particle.mjs 合并，2026-09-19）
// 只在真发声时喷发；粒子云水平居中、贴着音高线，
// 目标高度记在音高空间(p.tyM=midi)：滚屏/换音时旧粒子留在原音高处被
// 视口带走，形成"星迹"。暂停(d.live=false)时物理整帧冻结。
// ============================================================
function clearParticles() { pool.length = 0; head = 0; emitAcc = 0; lastPc = -1; lastPartVoiced = false; }

function spawn(x, y, vx, vy, pc, life, size) {
  const p = {
    x, y, px: x, py: y, vx, vy, tyM: NaN,
    ph: Math.random() * 6.283,        // 摆动相位（P2 wiggle：让粒子漂动有机化）
    life, rate: 1, col: pcHsl(pc < 0 ? 8 : pc, 88, 62),
    size,
  };
  if (pool.length < MAX_P) pool.push(p);
  else { pool[head] = p; head = (head + 1) % MAX_P; }
  return p;
}

// 持续细流：在音高场水平中段、音高线附近出生，目标=当前音高(带一点厚度)
function spawnBase(L, m, pc, amp) {
  const cx = (RAIL_W + L.fieldR) / 2;
  const spread = (L.fieldR - RAIL_W) * 0.32;
  const p = spawn(
    cx + (Math.random() - 0.5) * 2 * spread,
    H / 2 + (Math.random() - 0.5) * H * 0.24,
    (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 40,
    pc, 0.85 + Math.random() * 0.45, 1 + Math.random() * 1.8,
  );
  p.tyM = m + (Math.random() - 0.5) * ((18 + 22 * amp) / L.pxPerSemi);
  p.rate = 0.8 + Math.random() * 0.5;
}

function updateParticles(d, L, dt, active, now) {
  // 发声质量(0~1)：直接决定粒子密度与扩散。刻度定义在 viz-common.promNorm（prom 是
  // 真实峰突出度 dB，别再按 0~30 当量程写死系数——那是旧假 prom 时代的写法）。
  const amp = promNorm(d.prom);
  const nowS = now / 1000;

  if (active) {
    const m = midiOf(d.freq);
    const pc = pclassOf(m);
    // 音头爆发：从无声进入发声，或换了音高类——从音高场正中往外喷
    if (!lastPartVoiced || pc !== lastPc) {
      const n = Math.round(14 + 26 * amp);
      const cx = (RAIL_W + L.fieldR) / 2;
      const thick = 30 / L.pxPerSemi;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
        const sp = 50 + 130 * Math.random();
        const p = spawn(cx + Math.cos(a) * 16, H / 2 + Math.sin(a) * 10,
          Math.cos(a) * sp, Math.sin(a) * sp * 0.6,
          pc, 0.9 + Math.random() * 0.4, 1.8 + Math.random() * 1.8);
        p.tyM = m + (Math.random() - 0.5) * thick;
      }
    }
    // 持续细流
    emitAcc += dt * RATE_BASE * (0.35 + amp);
    let guard = 0;
    while (emitAcc >= 1 && guard++ < 40) { emitAcc -= 1; spawnBase(L, m, pc, amp); }
    lastPc = pc;
  } else {
    emitAcc = 0;
  }
  lastPartVoiced = active;

  // 不按 d.live 冻结粒子物理——暂停/停止/播完都让残留星尘飘完
  // 自然寿命（"中途暂停也让残留动画走完"）。
  // 冻结的只有时间轴/游标/下落块；喷发在 active 分支，暂停时 voiced=false → 已不喷发，
  // 所以只会"飘完"不会"续命"。

  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const dragK = Math.exp(-DRAG * dt);
  const decay = 1 / LIFE_S;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p || p.life <= 0) continue;
      if (pass === 0) {
        // 目标 y 每帧按当前视口重算：粒子归属自己的音高，滚屏时跟着格子走
        const ty = Number.isFinite(p.tyM) ? L.yOf(p.tyM) : H / 2;
        const ay = (ty - p.y) * SPRING;
        p.vy = (p.vy + ay * dt) * dragK;
        p.vx *= Math.exp(-1.6 * dt);
        // wiggle（P2）：横向正弦扰动叠加在阻尼之后——漂动从"数学直线"变"有机漂浮"
        p.vx += Math.sin(nowS * 2.6 + p.ph) * 34 * dt;
        p.px = p.x; p.py = p.y;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt * decay * p.rate;
        if (p.y < -40 || p.y > H + 60 || p.x < -40 || p.x > W + 40) p.life = 0;
        if (p.life <= 0) continue;
      }
      const a = clamp01(p.life);
      const lw = 0.8 + p.size * 0.55;
      ctx.lineWidth = pass ? lw : lw * 3.4;
      ctx.globalAlpha = pass ? a * 0.92 : a * 0.15;
      ctx.strokeStyle = p.col;
      // 速度拉线（P2）：拖尾 = 帧位移 × 系数——快粒子拉出光痕，慢粒子保证最小可见长度
      const dx = p.x - p.px, dy = p.y - p.py;
      const vlen = Math.hypot(dx, dy);
      let tx = p.px, ty = p.py;
      if (vlen > 0.01) {
        const k = Math.max(1.2 / vlen, 1) + Math.min(2.5, vlen * 0.15);
        tx = p.x - dx * k; ty = p.y - dy * k;
      } else {
        tx = p.x - 0.7; ty = p.y;
      }
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
