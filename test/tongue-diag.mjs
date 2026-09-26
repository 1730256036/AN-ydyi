// ============================================================
// test/tongue-diag.mjs —— 快吐/包络诊断台（node 直跑，不发信号）
// 用法：node test/tongue-diag.mjs <录音.wav>（如 samples/快吐口哨录音 14_11_22.wav）
// 作用：对真实录音跑完整检测管线，量出同音 run 内部 rms 谷深分布——
//       用真实数据定 SPLIT_DEPTH_DB 阈值，而不是拍脑袋。
// 输出：每个 ≥300ms 同音 run 的时长、谷深分布(≥2/3/4/6dB 的谷数)、
//       音高锯齿密度(方向反转/秒)，并给出阈值建议。
// ============================================================
import { readFileSync } from 'node:fs';
import { analyzePCM } from '../dsp/analyze.mjs';

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
  if (fmt.bits !== 16) throw new Error('仅支持 16bit PCM(导出的就是 16bit)');
  const n = Math.floor(data.size / 2 / fmt.ch);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += dv.getInt16(data.off + (i * fmt.ch + c) * 2, true);
    pcm[i] = s / fmt.ch / 32768;
  }
  return { pcm, sr: fmt.sr };
}

// ---- 主流程 ----
const path = process.argv[2];
if (!path) { console.error('用法：node test/tongue-diag.mjs <录音.wav>'); process.exit(1); }
const { pcm, sr } = decodeWav(path);
console.log(`载入 ${path}: ${fmtDur(pcm.length / sr)} · ${sr}Hz`);
const frames = analyzePCM(pcm, sr, {}, null).frames;
console.log(`检测帧 ${frames.length}，发声帧 ${frames.filter(f => f.voiced && f.freq > 0).length}`);

// 复刻分段器 v3 的 run 构建(滞回吸附)，然后量每个 run 的包络谷深与锯齿密度
const dbOf = (rms) => 20 * Math.log10(rms + 1e-9) + 90;
const HYST_SEMI = 0.55, GAP_MS = 90;
const runs = [];
let cur = null, curMidi = NaN;
for (const f of frames) {
  if (!(f.voiced && Number.isFinite(f.freq) && f.freq > 0)) continue;
  const mf = 69 + 12 * Math.log2(f.freq / 440);
  let m = Math.round(mf);
  if (Number.isFinite(curMidi) && Math.abs(mf - curMidi) <= HYST_SEMI) m = curMidi;
  if (cur && (m !== cur.midi || f.t - cur.lastT > GAP_MS)) { runs.push(cur); cur = null; }
  if (!cur) { cur = { midi: m, t0: f.t, lastT: f.t, pts: [] }; curMidi = m; }
  cur.lastT = f.t;
  cur.pts.push({ t: f.t, mf, rms: f.rms });
}
if (cur) runs.push(cur);

const long = runs.filter(r => r.lastT - r.t0 >= 300);
console.log(`\n≥300ms 同音 run：${long.length} 个（这些就是"快吐糊成长块"的候选）\n`);
let v3 = 0, v4 = 0, v6 = 0;
for (const r of long) {
  const vs = r.pts.map(p => ({ t: p.t, mf: p.mf, rms: p.rms }));
  // 谷深：与 splitByValleys 同款算法
  const depths = [];
  for (let i = 1; i < vs.length - 1; i++) {
    if (vs[i].rms < vs[i - 1].rms && vs[i].rms <= vs[i + 1].rms) {
      let pl = i - 1; while (pl > 0 && vs[pl - 1].rms <= vs[pl].rms) pl--;
      let pr = i + 1; while (pr < vs.length - 1 && vs[pr + 1].rms <= vs[pr].rms) pr++;
      depths.push(20 * Math.log10(Math.max(vs[pl].rms, vs[pr].rms) / vs[i].rms));
    }
  }
  // 锯齿密度：midiFloat 方向反转 / 秒
  let rev = 0;
  for (let i = 2; i < vs.length; i++) {
    const d1 = vs[i - 1].mf - vs[i - 2].mf, d2 = vs[i].mf - vs[i - 1].mf;
    if (d1 * d2 < 0) rev++;
  }
  const dur = (r.lastT - r.t0) / 1000;
  const d3 = depths.filter(d => d >= 3).length, d4 = depths.filter(d => d >= 4).length;
  v3 += d3; v4 += d4; v6 += depths.filter(d => d >= 6).length;
  const maxDepth = depths.length ? Math.max(...depths).toFixed(1) : '-';
  console.log(`run midi=${r.midi} ${Math.round(r.t0 / 100) / 10}~${Math.round(r.lastT / 100) / 10}s ` +
    `时长${Math.round((r.lastT - r.t0) / 100) / 10}s · 谷数(≥3dB)=${d3} ≥4dB=${d4} ≥6dB=${depths.filter(d => d >= 6).length} · 最深${maxDepth}dB · 锯齿${(rev / dur).toFixed(1)}次/s`);
}
console.log(`\n全曲谷深统计：≥3dB ${v3} 个 · ≥4dB ${v4} 个 · ≥6dB ${v6} 个`);
console.log('→ 若 ≥3dB 远多于 ≥6dB 且与快吐段吻合：SPLIT_DEPTH_DB 应降到 3~4');
console.log('→ 若锯齿密度在快吐段明显偏高：需叠加音高锯齿切分线索');

function fmtDur(s) { return `${Math.floor(s / 60)}分${Math.round(s % 60)}秒`; }
