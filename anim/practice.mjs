// ============================================================
// anim/practice.mjs —— 跟音练习模板 (2026-09-13 v2 重做)
//
// 界面跟钢琴块没区别——琴键在下面、块从顶上下落。流程：
//   ①目标音作为一个下落块从屏幕顶落下，落到键盘线那一刻由钢琴块原生逻辑
//     弹出目标音(同音高钢琴声)；
//   ②你模唱/吹奏，你的音同样实时变成下落块、落键弹出(听到自己实际唱了什么，
//     与目标音对比)；你这一轮的段结束时自动评分。
//
// 实现方式：**包裹钢琴块渲染**——本模板不做任何画块/画键盘的工作，每帧把
// "目标块+你的块"合成 midiNotes 注入快照后调 pianoBlocks.frame()，落键出声/
// 粒子/发光全部是钢琴块原生路径(midiNotes 优先级最高)，钢琴块一行不改。
// 本模板只做三件事：练习状态机、midiNotes 合成注入、顶部评分浮层。
//
// 状态机(相位只在 d.live 推进；暂停=冻结，遵守全模板纪律；时间用音频游标
// d.audioMs 域，与下落块同一时间轴)：
//   falling 目标块下落中(块落地=钢琴块弹目标音) → listen
//   listen  等你发声，8s 没声 → 判"没听到" → result
//   hold    你发声中：静音≥400ms 或满 4s 结束 → 出段；<200ms 杂音回 listen
//   result  出分 2.5s → 选下一个目标音 → falling
//
// 评分：attempt 段检测 midi 的【中位数】与目标差(×100=音分)。
//   |dev|≤10¢ 优 / ≤25¢ 良 / ≤50¢ 合格 / 其余跑调；差≥1个八度判"错八度"。
//
// 数据来源：只吃检测快照(d.voiced/d.midi/d.audioMs/d.live/d.resetKey)，
// 不碰 dsp/ 公式。出声走钢琴块(pianoBlocks 内部 soundEnabled → piano-sound)，
// init 时自动开启钢琴声(没目标音声练习不成立；用户可再关)。
// 纯函数 gradeCents/median/pickNext 导出供 anim-smoke 直测。
// ============================================================

import pb from './pianoBlocks.mjs';
import { noteName, clamp } from './viz-common.mjs';

// —— 可调 ——
const FALL_MS = 4200;            // 下落时长=钢琴块 LOOKAHEAD_MS(屏幕顶→键盘线)
const TARGET_DUR_MS = 900;       // 目标音钢琴时值(块长)
const LISTEN_TIMEOUT_MS = 8000;  // 目标落地后等你发声的超时
const QUIET_MS = 400;            // 采集期静音判定(停这么久=这个音吹完了)
const MAX_HOLD_MS = 4000;        // 采集期上限(一直不停也强制出分)
const MIN_NOTE_MS = 200;         // 短于此的发声算杂音，不计分
const RESULT_MS = 2500;          // 出分展示时长

// —— 配置(localStorage 持久化，面板改) ——
let pickMode = 'random';                       // random | scale(半音阶上行)
let rangeLo = 48, rangeHi = 84;                // C3..C6
try { const p = localStorage.getItem('ydyi_practice_pick'); if (p === 'random' || p === 'scale') pickMode = p; } catch (e) {}
try { const lo = parseInt(localStorage.getItem('ydyi_practice_lo'), 10); if (Number.isFinite(lo)) rangeLo = clamp(lo, 21, 96); } catch (e) {}
try { const hi = parseInt(localStorage.getItem('ydyi_practice_hi'), 10); if (Number.isFinite(hi)) rangeHi = clamp(hi, 21, 96); } catch (e) {}
if (rangeHi < rangeLo + 2) rangeHi = rangeLo + 2;

// —— 纯函数(测试直测) ——
export function gradeCents(dev) {
  const a = Math.abs(dev);
  if (a <= 10) return { label: '优', tone: 0 };
  if (a <= 25) return { label: '良', tone: 1 };
  if (a <= 50) return { label: '合格', tone: 2 };
  return { label: '跑调', tone: 3 };
}
export function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// 选题：random=音域内随机(不与上一个重复)；scale=半音阶上行到顶回卷
export function pickNext(mode, lo, hi, last) {
  if (mode === 'scale') return last == null || last >= hi ? lo : last + 1;
  let m, guard = 20;
  do { m = lo + Math.floor(Math.random() * (hi - lo + 1)); } while (m === last && guard-- > 0);
  return m;
}
export function setPickMode(v) {
  if (v !== 'random' && v !== 'scale') return;
  pickMode = v;
  try { localStorage.setItem('ydyi_practice_pick', v); } catch (e) {}
}
export function setRange(lo, hi) {
  lo = clamp(Math.round(lo), 21, 96); hi = clamp(Math.round(hi), 21, 96);
  if (hi < lo + 2) hi = lo + 2;
  rangeLo = lo; rangeHi = hi;
  try { localStorage.setItem('ydyi_practice_lo', String(lo)); } catch (e) {}
  try { localStorage.setItem('ydyi_practice_hi', String(hi)); } catch (e) {}
}

// —— 状态机 ——
let ctx = null, W = 0, H = 0;
let state = 'idle';            // idle | falling | listen | hold | result
let lastNow = 0, lastKey = undefined;
let phaseT = 0;                // 当前相位已耗时 ms(只在 live 推进)
let target = NaN, lastTarget = NaN;
let notes = [];                // 注入钢琴块的音符表：目标块+用户块 {t0,t1,midi,_live}
let tgtNote = null;            // 当前目标音符引用
let seg = null;                // 当前用户发声段 {t0Ams,durMs,quietMs,midis,note}
let attempt = null;            // 本轮评分用的段(目标落地后开始的第一段)
let lastDev = NaN, lastGrade = null, lastMiss = false;
let round = 0, streak = 0;

function resetSession() {
  state = 'idle'; phaseT = 0;
  tgtNote = null; seg = null; attempt = null;
  notes = [];
  lastDev = NaN; lastGrade = null; lastMiss = false;
  round = 0; streak = 0;
}
function beginRound(ams) {
  target = pickNext(pickMode, rangeLo, rangeHi, lastTarget);
  lastTarget = target;
  tgtNote = { t0: ams + FALL_MS, t1: ams + FALL_MS + TARGET_DUR_MS, midi: target };
  notes.push(tgtNote);
  if (notes.length > 600) notes.splice(0, notes.length - 600);
  attempt = null;
  lastDev = NaN; lastGrade = null; lastMiss = false;
  round++; phaseT = 0; state = 'falling';
}
// 结束当前用户段：出块定音；若它是 attempt 且正在 hold → 评分
function endSeg() {
  if (!seg) return;
  const s = seg; seg = null;
  const i = notes.indexOf(s.note);
  if (s.durMs < MIN_NOTE_MS) {
    if (i >= 0) notes.splice(i, 1);              // 杂音：撤块(必然未着陆过)
    if (attempt === s) { attempt = null; if (state === 'hold') { state = 'listen'; phaseT = 0; } }
    return;
  }
  if (i >= 0) { s.note.midi = Math.round(median(s.midis)); s.note.t1 = s.note.t0 + s.durMs; }
  if (attempt === s && state === 'hold') {
    const med = median(s.midis);
    lastDev = (med - target) * 100;
    const oct = Math.abs(med - target) >= 11.5;   // 差≥1个八度(留半音容差)
    lastGrade = oct ? { label: '错八度', tone: 3 } : gradeCents(lastDev);
    lastMiss = false;
    streak = lastGrade.tone <= 1 ? streak + 1 : 0;
    state = 'result'; phaseT = 0;
  }
}
function step(d, dt) {
  const ams = d.audioMs;
  phaseT += dt;
  if (state === 'falling') {
    if (tgtNote && ams >= tgtNote.t0) {
      // 目标落地=已弹响。若此刻你已经在吹(提前抢跑)，当前段直接算 attempt
      if (seg) { attempt = seg; state = 'hold'; }
      else { state = 'listen'; }
      phaseT = 0;
    }
  } else if (state === 'listen') {
    if (phaseT >= LISTEN_TIMEOUT_MS) {
      lastMiss = true; lastGrade = null; lastDev = NaN; streak = 0;
      state = 'result'; phaseT = 0;
    }
  } else if (state === 'result') {
    if (phaseT >= RESULT_MS) beginRound(ams);
  }
  // 用户发声段采集：任何相位都采集出块(视觉一致)；attempt 只认 listen 中开始的段
  if (d.voiced && Number.isFinite(d.midi)) {
    if (!seg) {
      seg = { t0Ams: ams, durMs: 0, quietMs: 0, midis: [],
              note: { t0: ams + FALL_MS, t1: ams + FALL_MS, midi: Math.round(d.midi), _live: true } };
      notes.push(seg.note);
      if (notes.length > 600) notes.splice(0, notes.length - 600);
      if (state === 'listen') { attempt = seg; state = 'hold'; }
    }
    seg.durMs += dt; seg.quietMs = 0;
    seg.midis.push(d.midi);
    seg.note.t1 = seg.note.t0 + seg.durMs;        // 还在吹：块顶持续生长
    const recent = seg.midis.length > 30 ? seg.midis.slice(-30) : seg.midis;
    seg.note.midi = Math.round(median(recent));   // 近30帧中位定音(着陆前完成)
    if (seg.durMs >= MAX_HOLD_MS) endSeg();       // 一直不停也强制出分
  } else if (seg) {
    seg.quietMs += dt;
    if (seg.quietMs >= QUIET_MS) endSeg();
  }
}

// —— 顶部评分浮层(画在钢琴块之上；纯状态函数无时间闪烁 → 暂停时逐帧静止) ——
const GRADE_COLOR = ['#4ade80', '#a3e635', '#fbbf24', '#f87171'];
function drawOverlay() {
  ctx.save();
  ctx.fillStyle = 'rgba(7,9,13,.55)';
  ctx.fillRect(0, 0, W, 56);
  ctx.fillStyle = 'rgba(230,233,238,.5)';
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('第 ' + Math.max(1, round) + ' 轮 · 连击 ' + streak +
    ' · 音域 ' + noteName(rangeLo) + '–' + noteName(rangeHi) +
    (pickMode === 'random' ? ' · 随机' : ' · 上行'), 12, 14);
  const tName = Number.isFinite(target) ? noteName(target) : '--';
  ctx.textAlign = 'center';
  if (state === 'idle' || !Number.isFinite(target)) {
    ctx.fillStyle = 'rgba(230,233,238,.6)';
    ctx.font = '15px "Segoe UI", sans-serif';
    ctx.fillText('开始录音后自动开始：目标音落下弹响 → 你模唱 → 自动评分', W / 2, 38);
  } else if (state === 'falling') {
    ctx.fillStyle = 'rgba(230,233,238,.75)';
    ctx.font = '600 17px "Segoe UI", sans-serif';
    ctx.fillText('听——目标音 ' + tName + ' 落下弹响后，你来模唱', W / 2, 38);
  } else if (state === 'listen') {
    ctx.fillStyle = 'rgba(230,233,238,.75)';
    ctx.font = '600 17px "Segoe UI", sans-serif';
    ctx.fillText('你来——模唱 ' + tName + '（你的音也会落下弹出，跟它对比）', W / 2, 38);
  } else if (state === 'hold') {
    ctx.fillStyle = 'rgba(230,233,238,.75)';
    ctx.font = '600 17px "Segoe UI", sans-serif';
    ctx.fillText('采集中…', W / 2, 38);
  } else if (state === 'result') {
    if (lastMiss) {
      ctx.fillStyle = '#f87171';
      ctx.font = '600 17px "Segoe UI", sans-serif';
      ctx.fillText('没听到 ' + tName + ' · 下一轮马上来', W / 2, 38);
    } else {
      const g = lastGrade || gradeCents(0);
      const dev = Number.isFinite(lastDev) ? Math.round(lastDev) : 0;
      ctx.fillStyle = GRADE_COLOR[g.tone] || '#fff';
      ctx.font = '700 20px "Segoe UI", sans-serif';
      ctx.fillText(tName + '   ' + g.label + '   ' + (dev > 0 ? '+' : '') + dev + '¢', W / 2, 38);
    }
  }
  ctx.restore();
}

export default {
  id: 'practice',
  name: '跟音练习',
  kind: 'full',

  init(c, w, h) {
    ctx = c; W = w; H = h;
    resetSession();
    lastNow = 0; lastKey = undefined;
    pb.init(c, w, h);
    try { pb.setSoundEnabled(true); } catch (e) {}   // 目标音必须出声；用户可再关
  },
  resize(w, h) { W = w; H = h; pb.resize(w, h); },
  setPickMode(v) { setPickMode(v); },
  setRange(lo, hi) { setRange(lo, hi); },

  frame(d, now) {
    if (!ctx || !d) return;
    const dt = lastNow ? clamp(now - lastNow, 0, 100) : 16.7;
    lastNow = now;
    if (d.resetKey !== undefined && d.resetKey !== lastKey) {
      lastKey = d.resetKey;
      resetSession();
    }
    const live = !!d.live;
    const active = live && d.liveRecActive && Number.isFinite(d.audioMs) && d.audioMs >= 0;
    if (active) step(d, dt);
    // 注入：仅录音活工程时把练习音符喂给钢琴块走原生下落块路径；其余场景原样透传
    let dd = d;
    if (active && notes.length) dd = Object.assign({}, d, { midiNotes: notes });
    pb.frame(dd, now);
    drawOverlay();
  },
};
