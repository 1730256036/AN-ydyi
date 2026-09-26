// ============================================================
// test/seg-ab.mjs —— 钢琴块分段 A/B 回归（node 直跑，不发信号不起服务）
// 用法：node test/seg-ab.mjs [录音.wav]（默认 samples/快吐口哨录音 14_11_22.wav）
// 目的：对同一段真实录音，把 方案A(v4 先分段后定音) 与 旧版(v3 逐帧吸附)
//       跑完整分段，打印两套块列表 + 差异统计，供人工判读新版是否更像原音频。
// 原则：只动分段逻辑对比，检测/能量门/桥接一律用同一份 analyzePCM 帧。
// ============================================================
import { readFileSync } from 'node:fs';
import { analyzePCM } from '../dsp/analyze.mjs';
import { computeEnv } from '../dsp/envelope.mjs';
import { segmentPoints } from '../anim/pianoBlocks.mjs';

// ---- 极简 WAV 解析(PCM16，ydyi 导出格式) ----
function decodeWav(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46464952) throw new Error('不是 RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { ch: dv.getUint16(off + 10, true), sr: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === 'data') { data = { off: off + 8, size }; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt/data 块');
  if (fmt.bits !== 16) throw new Error('仅支持 16bit PCM');
  const n = Math.floor(data.size / 2 / fmt.ch);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += dv.getInt16(data.off + (i * fmt.ch + c) * 2, true);
    pcm[i] = s / fmt.ch / 32768;
  }
  return { pcm, sr: fmt.sr };
}

const noteOf = (m) => ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// ---- 旧版 v3 完整分段（复刻 b83a915 的 run 构建 + 同一后处理，颤动/质量折叠按默认【关】）----
const GAP_MS = 90, MERGE_GAP_MS = 110, MIN_NOTE_MS = 30, HYST_SEMI = 0.55;
const SPLIT_DEPTH_DB = 4, ENV_SPLIT_DB = 3;

function legacySegmentPoints(pts, env, preCuts) {
  const cutTimes = [];
  if (preCuts) { for (const t of preCuts) cutTimes.push(t); }
  else if (env && env.length > 4) {
    for (let i = 2; i < env.length - 2; i++) {
      if (env[i].rms < env[i - 1].rms && env[i].rms <= env[i + 1].rms) {
        let pl = i - 1; while (pl > 1 && env[pl - 1].rms <= env[pl].rms) pl--;
        let pr = i + 1; while (pr < env.length - 2 && env[pr + 1].rms <= env[pr].rms) pr++;
        const depth = 20 * Math.log10(Math.max(env[pl].rms, env[pr].rms) / env[i].rms);
        if (depth >= ENV_SPLIT_DB) cutTimes.push(env[i].t);
      }
    }
  }
  const frameQ = (p) => Math.max(0, Math.min(1, p.purity * 0.6 + Math.min(1, p.prom / 18) * 0.4));
  const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const runFrom = (midi, pts) => ({ midi, t0: pts[0].t, lastT: pts[pts.length - 1].t, pts, q: med(pts.map(frameQ)) });

  // 1) 旧：滞回吸附 + 切 run
  const runs = [];
  let cur = null, curMidi = NaN, ci = 0, prevT = -Infinity;
  for (const p of pts) {
    while (ci < cutTimes.length && cutTimes[ci] <= prevT) ci++;
    const cutBefore = ci < cutTimes.length && cutTimes[ci] < p.t;
    const mf = 69 + 12 * Math.log2(p.f / 440);
    let m = Math.round(mf);
    if (Number.isFinite(curMidi) && Math.abs(mf - curMidi) <= HYST_SEMI) m = curMidi;
    if (cur && (cutBefore || m !== cur.midi || p.t - cur.lastT > GAP_MS)) {
      if (cutBefore) cur.cutNext = true;
      runs.push({ ...cur, q: med(cur.q) }); cur = null;
    }
    if (!cur) { cur = { midi: m, t0: p.t, lastT: p.t, pts: [], q: [] }; curMidi = m; if (cutBefore) cur.cutPrev = true; }
    cur.lastT = p.t; cur.pts.push(p);
    cur.q.push(frameQ(p));
    prevT = p.t;
  }
  if (cur) runs.push({ ...cur, q: med(cur.q) });

  // 2) 包络深谷切分
  const split = [];
  for (const r of runs) {
    const vs = (r.pts || []).filter(p => typeof p.rms === 'number' && p.rms > 0);
    if (vs.length < 5) { split.push(r); continue; }
    const cuts = [];
    for (let i = 1; i < vs.length - 1; i++) {
      if (vs[i].rms < vs[i - 1].rms && vs[i].rms <= vs[i + 1].rms) {
        let pl = i - 1; while (pl > 0 && vs[pl - 1].rms <= vs[pl].rms) pl--;
        let pr = i + 1; while (pr < vs.length - 1 && vs[pr + 1].rms <= vs[pr].rms) pr++;
        const depth = 20 * Math.log10(Math.max(vs[pl].rms, vs[pr].rms) / vs[i].rms);
        if (depth >= SPLIT_DEPTH_DB && i >= 2 && i <= vs.length - 3) cuts.push(i);
      }
    }
    if (!cuts.length) { split.push(r); continue; }
    const pieces = [];
    let segStart = 0;
    for (const c of cuts) {
      if (c > segStart) pieces.push(vs.slice(segStart, c));
      segStart = c + 1;
    }
    if (segStart < vs.length) pieces.push(vs.slice(segStart));
    pieces.forEach((pp, k) => {
      const piece = runFrom(r.midi, pp);
      if (k > 0 || r.cutPrev) piece.cutPrev = true;
      if (k < pieces.length - 1 || r.cutNext) piece.cutNext = true;
      split.push(piece);
    });
  }

  // 3+4) 颤动/质量折叠：默认关（与产品未勾选"颤音合并"一致）→ split 原样
  // 5) 过滤 + 同音近邻合并
  const notes = split
    .filter(r => r.lastT - r.t0 >= MIN_NOTE_MS)
    .map(r => ({ midi: r.midi, t0: r.t0, t1: r.lastT, cutPrev: r.cutPrev, cutNext: r.cutNext }));
  const merged = [];
  for (const n of notes) {
    const last = merged[merged.length - 1];
    if (last && last.midi === n.midi && n.t0 - last.t1 < MERGE_GAP_MS && !(n.cutPrev || last.cutNext)) last.t1 = n.t1;
    else merged.push(n);
  }
  return merged;
}

// ---- 打印块列表 ----
function fmtNotes(notes) {
  return notes.map(n => `${noteOf(n.midi)}(${Math.round(n.midi)})@${n.t0}~${n.t1}+${n.t1 - n.t0}ms`).join('\n  ');
}
function summary(name, notes) {
  let adjSame = 0;
  for (let i = 1; i < notes.length; i++) if (notes[i].midi === notes[i - 1].midi) adjSame++;
  const dur = notes.reduce((s, n) => s + (n.t1 - n.t0), 0);
  console.log(`\n[${name}] 块数=${notes.length} 相邻同音块对=${adjSame} 总时长=${dur}ms 平均=${notes.length ? (dur / notes.length / 1000).toFixed(2) : 0}s`);
  if (notes.length) console.log('  ' + fmtNotes(notes));
}

// ---- 主流程 ----
const path = process.argv[2] || 'samples/快吐口哨录音 14_11_22.wav';
const { pcm, sr } = decodeWav(path);
console.log(`载入 ${path}: ${(pcm.length / sr).toFixed(1)}s · ${sr}Hz`);
const { frames } = analyzePCM(pcm, sr, {}, null);
const voiced = frames.filter(f => f.voiced && Number.isFinite(f.freq) && f.freq > 0);
console.log(`检测帧 ${frames.length}，发声帧 ${voiced.length}（${(voiced.length / Math.max(1, frames.length) * 100).toFixed(0)}%）`);
const pts = voiced.map(f => ({ t: f.t, f: f.freq, rms: f.rms, prom: f.prom, purity: f.purity }));
const env = computeEnv(pcm, sr);

const oldNotes = legacySegmentPoints(pts, env, null);
const newNotes = segmentPoints(pts, env, null);

summary('旧 v3 逐帧吸附', oldNotes);
summary('新 v4 先分段后定音', newNotes);

// 差异统计
const onlyOld = oldNotes.filter(n => !newNotes.some(m => m.midi === n.midi && Math.abs(m.t0 - n.t0) < 80 && Math.abs(m.t1 - n.t1) < 80));
const onlyNew = newNotes.filter(n => !oldNotes.some(m => m.midi === n.midi && Math.abs(m.t0 - n.t0) < 80 && Math.abs(m.t1 - n.t1) < 80));
console.log(`\n差异：旧有而新无 ${onlyOld.length} 块，新有而旧无 ${onlyNew.length} 块`);
if (onlyOld.length) console.log('  旧有而新无：\n  ' + fmtNotes(onlyOld));
if (onlyNew.length) console.log('  新有而旧无：\n  ' + fmtNotes(onlyNew));