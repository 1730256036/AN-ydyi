// ============================================================
// proj/exporters.mjs —— 工程数据导出（纯函数，不碰 DOM）
// 目的：把已经算出来的音高数据变成"能拿走的文件"。
// 除了音频(wav/webm)与转谱 MIDI，曲线本身也要有出口；
// 这里补上 CSV（Excel / pandas / R 都能直接读）。
//
// 输入契约（与 dsp/analyze.mjs / 录音帧同构）：
//   帧 frames = [{ t(ms), freq(Hz, 0=无), voiced, prom, purity, rms, str }]
//   音符 notes = [{ t0(ms), t1(ms), midi, vel }]
// 输出：字符串（不含 BOM，BOM 由调用方按需拼；见 WITH_BOM）。
//
// 数值一律用 toFixed 输出，不用 String(n)：
//   rms 这类极小值 String(1e-7) === '1e-7'，指数写法会让 Excel/pandas 当文本，
//   列直接废掉。toFixed 永远是定点小数。
// ============================================================
import { NAME } from '../dsp/core.mjs';

// Excel 打开 UTF-8 CSV 需要 BOM，否则中文/日文工程名变乱码。
export const WITH_BOM = '\ufeff';

// 一个空字段（区别于数字 0）——用空串，Excel/pandas 都按缺失值处理。
const NA = '';

export const FRAME_HEAD = 't_ms,freq_hz,midi,note,cents,voiced,prom,purity,rms,str';
export const NOTE_HEAD  = 't0_ms,t1_ms,dur_ms,midi,note,vel';

// ⚠️ 这里不用 dsp/core.mjs 的 freqToNote().cents。
// 它写的是 `1200 * log2(midiExact / round(midiExact))` —— 拿"半音序号之比"当频率比，
// 而正确关系是 cents = 1200 * log2(f / f_nearestSemitone) = 100 * (midiExact - round(midiExact))。
// 序号与频率只在小偏移下近似线性，故它整体偏小：A4 附近约 1/4、高音区约 1/6
// （实测 445Hz 真值 +19.6¢，该函数给 +4.9¢）。dsp/detect.mjs 与 core.centsOf 用的是正确公式，
// 只有显示读数受影响；导出是数据，不能带错值，故此处自算。
// 这里不复用 freqToNote（待 core 的 cents 基准修好再议）。
function pitchOf(freq) {
  if (!(freq > 0)) return null;
  const midiExact = 69 + 12 * Math.log2(freq / 440);
  const m = Math.round(midiExact);
  return {
    midiExact,
    midi: m,
    name: NAME[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1),
    cents: 100 * (midiExact - m),          // 相对最近半音，∈ [-50, 50]
  };
}

// 频率 -> { midi, note, cents } 三列的文本；无有效频率时全空。
function pitchCols(freq) {
  const p = pitchOf(freq);
  if (!p) return [NA, NA, NA];
  // voiced=false 但带桥接频率的帧：仍给出频率与音名（曲线要连续），
  // 该帧是否算"真发声"由 voiced 列单独表达，不在 pitch 列里做二次判断。
  return [p.midiExact.toFixed(2), p.name, p.cents.toFixed(1)];
}

const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : NA);

// 音高帧表 -> CSV 文本
export function framesToCsv(frames) {
  const out = [FRAME_HEAD];
  if (Array.isArray(frames)) {
    for (const f of frames) {
      if (!f) continue;
      const freq = Number.isFinite(f.freq) ? f.freq : 0;
      const [midi, note, cents] = pitchCols(freq);
      out.push([
        Number.isFinite(f.t) ? Math.round(f.t) : NA,
        freq > 0 ? freq.toFixed(2) : NA,
        midi, note, cents,
        f.voiced === false ? 0 : (f.voiced ? 1 : 0),
        num(f.prom, 2), num(f.purity, 3), num(f.rms, 6), num(f.str, 3),
      ].join(','));
    }
  }
  return out.join('\r\n') + '\r\n';
}

// 音符表（MIDI 工程 / AI 转谱 / 检测分段）-> CSV 文本
export function notesToCsv(notes) {
  const out = [NOTE_HEAD];
  if (Array.isArray(notes)) {
    for (const n of notes) {
      if (!n || !Number.isFinite(n.midi)) continue;
      const t0 = Number.isFinite(n.t0) ? n.t0 : NA;
      const t1 = Number.isFinite(n.t1) ? n.t1 : NA;
      const dur = (Number.isFinite(n.t0) && Number.isFinite(n.t1)) ? (n.t1 - n.t0) : NaN;
      const m = Math.round(n.midi);
      out.push([
        Number.isFinite(t0) ? Math.round(t0) : NA,
        Number.isFinite(t1) ? Math.round(t1) : NA,
        Number.isFinite(dur) ? Math.round(dur) : NA,
        String(m),
        NAME[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1),
        num(n.vel, 3),
      ].join(','));
    }
  }
  return out.join('\r\n') + '\r\n';
}

// 文件名里的时间戳：2026-09-15_08-37-55（不含 ':' 与 '.'，Windows 文件名安全）
export function stampName(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
         `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
