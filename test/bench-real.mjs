// ============================================================
// test/bench-real.mjs —— 真实录音基准（不进 npm test：依赖本地大文件、耗时数秒）
//
// 用法：node test/bench-real.mjs [wav路径] [midi路径]
// 默认：samples/7rvc 人声干声 wav + samples/AI转谱版 mid（同源配对）。
//
// 做法：离线跑 createDetector（与实时/离线分析同一份门控实现，默认内核 yin-dual），
// 逐窗产出 freq/voiced，与 MIDI 参照音符比对音高一致性。
//
// ⚠️ 口径说明：参照 MIDI 本身是 AI 转谱产物，不是人工标注真值，
// 所以这里测的是"检测输出与参照的一致性"，八度错/时间轴漂移/大片漏检
// 这类粗错能有效暴露；十音分级的绝对精度结论不能只凭本表。
// ============================================================
import fs from 'node:fs';
import { createDetector } from '../dsp/detect.mjs';
import { centsOf, freqToNote } from '../dsp/core.mjs';
import { parseSMF } from '../dsp/smf.mjs';

const DEF_WAV = 'samples/7rvc彷徨いの冥 - 少女フラクタル柚木梨沙_Vocals_dry.wav';
const DEF_MID = 'samples/AI转谱版6rvc彷徨いの冥 - 少女フラクタル柚木梨沙_Vocals_dry.mid';
const wavPath = process.argv[2] || DEF_WAV;
const midPath = process.argv[3] || DEF_MID;

const N = 4096, HOP = 2048;          // 基准用 46ms 步进（实时是逐 rAF，这里只求统计量）
const EDGE_GUARD_MS = 40;            // 音符前后沿 ±40ms 不计分（避开起振/释放的对齐误差）
const MIN_NOTE_MS = 80;              // 过短音符不参与参照

// ---------- WAV 读取（PCM 16/24/32 整型 + IEEE float32，混成单声道） ----------
function readWav(path) {
  const b = fs.readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('不是 WAV 文件: ' + path);
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(off + 8),
        ch: b.readUInt16LE(off + 10),
        sr: b.readUInt32LE(off + 12),
        bits: b.readUInt16LE(off + 22),
      };
    } else if (id === 'data') { dataOff = off + 8; dataLen = sz; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 缺 fmt/data 块');
  const { format, ch, sr, bits } = fmt;
  const nFrames = Math.floor(dataLen / (bits / 8) / ch);
  const pcm = new Float32Array(nFrames);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const base = dataOff;
  for (let i = 0; i < nFrames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const p = base + (i * ch + c) * (bits / 8);
      let v = 0;
      if (format === 3 && bits === 32) v = dv.getFloat32(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) {
        v = (dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608;
      } else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
      acc += v;
    }
    pcm[i] = acc / ch;
  }
  return { pcm, sr };
}

// ---------- 参照音符表 ----------
function loadRef(path) {
  const buf = fs.readFileSync(path);
  const smf = parseSMF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const notes = smf.tracks.filter(t => !t.isPercussion).flatMap(t => t.notes)
    .filter(n => n.t1 - n.t0 >= MIN_NOTE_MS)
    .map(n => ({ t0: n.t0, t1: n.t1, f: 440 * 2 ** ((n.midi - 69) / 12), midi: n.midi }))
    .sort((a, b) => a.t0 - b.t0);
  return notes;
}

// ---------- 主流程 ----------
console.log(`基准文件: ${wavPath}\n参照 MIDI: ${midPath}\n`);
const t0 = performance.now();
const { pcm, sr } = readWav(wavPath);
const notes = loadRef(midPath);
console.log(`音频 ${(pcm.length / sr).toFixed(1)}s @${sr}Hz | 参照音符 ${notes.length} 个\n`);

// 噪声地板：窗 RMS 的 10 分位数（与 analyze.mjs 的自适应思路一致）
const rmsList = [];
for (let p = 0; p + N <= pcm.length; p += HOP) {
  let s = 0; for (let i = 0; i < N; i++) s += pcm[p + i] * pcm[p + i];
  rmsList.push(Math.sqrt(s / N));
}
rmsList.sort((a, b) => a - b);
const floorRms = rmsList[Math.floor(rmsList.length * 0.1)] || 0;

const det = createDetector({ sampleRate: sr, fmin: 40, fmax: 8000, windowSize: N, voicing: 85, sens: 70 });
det.setEnergy({ mode: 'auto', envRms: floorRms });

// 参照查表：音符覆盖窗中心时间且离前后沿 ≥ EDGE_GUARD_MS 才有效
function refAt(tMs) {
  let lo = 0, hi = notes.length - 1, ans = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (notes[mid].t0 <= tMs) { ans = notes[mid]; lo = mid + 1; } else hi = mid - 1; }
  return (ans && tMs < ans.t1 - EDGE_GUARD_MS && tMs > ans.t0 + EDGE_GUARD_MS) ? ans : null;
}

const tD0 = performance.now();
let total = 0, voiced = 0, both = 0;
const errs = [];
let octErr = 0, histNotes = new Map(), octByRef = new Map();
for (let p = 0; p + N <= pcm.length; p += HOP) {
  const r = det.processWindow(pcm.subarray(p, p + N));
  total++;
  if (r.voiced) voiced++;
  const tMs = ((p + N / 2) / sr) * 1000;
  const ref = refAt(tMs);
  if (!r.voiced || !(r.freq > 0) || !ref) continue;
  const e = centsOf(r.freq, ref.f);
  both++; errs.push(e);
  if (Math.abs(e) > 600) { octErr++; octByRef.set(ref.midi, (octByRef.get(ref.midi) || 0) + 1); }
  histNotes.set(ref.midi, (histNotes.get(ref.midi) || 0) + 1);
}
const tD1 = performance.now();

errs.sort((a, b) => a - b);
const q = (x) => errs.length ? errs[Math.floor(errs.length * x)] : NaN;
const within = (c) => errs.length ? errs.filter(e => Math.abs(e) <= c).length / errs.length : NaN;

console.log('— 检测概况 —');
console.log(`  发声帧: ${voiced}/${total} (${(voiced / total * 100).toFixed(0)}%)`);
console.log(`  参照覆盖帧(发声∩音符内): ${both}  | 音高分布: ${[...histNotes.entries()].sort((a, b) => a[0] - b[0]).map(([m, c]) => freqToNote(440 * 2 ** ((m - 69) / 12)).name + freqToNote(440 * 2 ** ((m - 69) / 12)).oct + '×' + c).join(' ')}`);
console.log('\n— 与参照 MIDI 的一致性（参照本身为 AI 转谱，见文件头口径说明）—');
console.log(`  偏差中位数: ${q(0.5).toFixed(1)}¢   p90: ${q(0.9).toFixed(1)}¢`);
console.log(`  ≤50¢ 占比: ${(within(50) * 100).toFixed(1)}%   ≤100¢: ${(within(100) * 100).toFixed(1)}%`);
console.log(`  八度级错误(>600¢): ${(octErr / Math.max(1, both) * 100).toFixed(1)}%`);
if (octByRef.size) {
  const nn = (m) => { const n = freqToNote(440 * 2 ** ((m - 69) / 12)); return n.name + n.oct; };
  const top = [...octByRef.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([m, c]) => `${nn(m)}×${c}`).join(' ');
  console.log(`    ↳ 按参照音符分布: ${top}（参照本身是 AI 转谱，检测器/参照谁错需人工抽查才能定）`);
}
console.log(`\n— 性能 —`);
console.log(`  检测耗时 ${(tD1 - tD0).toFixed(0)}ms / 音频 ${(pcm.length / sr).toFixed(1)}s → 实时率 ${(pcm.length / sr) / ((tD1 - tD0) / 1000)}×`);
