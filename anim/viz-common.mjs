// ============================================================
// anim/viz-common.mjs —— 视觉模板公共工具（纯函数 + 常量）
//
// 供 anim/*.mjs 复用，集中解决三件各模板都会写到的事：
//   1) 数值/音高换算（clamp / 半音 / 音名 / 音高类配色）
//   2) 对数频率轴（20Hz~20kHz 压成画布坐标，线性轴低频会挤成一条缝）
//   3) 感知均匀配色表（spectrogram 用 inferno/turbo，瀑布图不靠彩虹糊）
//
// 约定：本文件【无状态】——不持有 ctx/W/H，不碰 DOM。画布状态各模板自己管。
// 配色统一走 256 级 LUT（Uint8Array），比每像素算插值快，且能直接喂 ImageData。
// ============================================================

// ---------- 数学 ----------
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------- prom(峰突出度 dB) → 0~1 ----------
// 全项目唯一一处 prom 归一化刻度，要拿 prom 调观感都走这里（目前仅 pitchOrb 两处消费：
// 热力图累积、星尘粒子发射量/扩散/音头爆发量）。
// 实测锚点（dsp 探针，真实素材）：门控下限 6~16dB；口哨 p10/50/90 = 42/51/55；
// 人声 31/59/72；纯净音 90~115。取 20dB→0、70dB→1，真实素材落中段（口哨 0.44~0.70），
// 既不是贴 1 也不浪费下半区。
// ⚠ 提醒：调用方不要各自写死 `prom/40`、`prom/34`——那是照着旧
// mpm/pyin 内核"0~30 的假 prom"定的刻度。三内核统一成真实 dB 后，这两个系数让真实素材
// 恒贴 1（纯音/口哨全程满格），"随声音质量呼吸"的效果实际被压平。改刻度前先读这段。
export const PROM_LO = 20, PROM_HI = 70;
export const promNorm = (prom) => clamp01(((Number.isFinite(prom) ? prom : 0) - PROM_LO) / (PROM_HI - PROM_LO));

// ---------- rms(时域幅度) → 0~1（真响度刻度）----------
// 用途：曲线"响度呼吸"与背景能量柱（2026-09-22）。这里不能用 promNorm——
// prom 是"峰突出度(音高显著度)"不是音量，唱得响但音高稳时它并不高，语义不符。
// 刻度：dB 域线性映射 [-60dB, -15dB] → [0,1]（detect.dbOf = 20log10(rms)+90 的另一套零点，
// 这里用标准 20log10 定义，与门控阈值无耦合）：
//   rms 0.001 → 0.00（纯底噪）；0.01 → 0.44；0.1 → 0.89；0.316 → 1.0。
// ⚠ 与 promNorm 一样是"全项目唯一一处 rms 归一化刻度"，要拿去调观感都走这里。
export const RMS_FLOOR_DB = -60, RMS_CEIL_DB = -15;
export const rmsNorm = (r) => {
  const v = Number.isFinite(r) && r > 0 ? r : 1e-9;
  return clamp01((20 * Math.log10(v) - RMS_FLOOR_DB) / (RMS_CEIL_DB - RMS_FLOOR_DB));
};
// 帧率无关的指数逼近：每帧朝目标走 1-e^(-dt·rate) 比例（rate 越大越快）
export const approach = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));

// ---------- 音高 ----------
export const A4 = 440;
export const midiOf = (f) => 69 + 12 * Math.log2(f / A4);
export const freqOfMidi = (m) => A4 * Math.pow(2, (m - 69) / 12);
export const pclassOf = (m) => ((Math.round(m) % 12) + 12) % 12;
export const BLACK_PC = [1, 3, 6, 8, 10];
export const isBlackMidi = (m) => BLACK_PC.includes(pclassOf(m));
export const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const octOf = (m) => Math.floor(Math.round(m) / 12) - 1;
// MIDI -> 'C4' / 'A#5'
export const noteName = (m) => {
  if (!Number.isFinite(m)) return '--';
  const r = Math.round(m);
  return NAMES[pclassOf(r)] + octOf(r);
};
// 音高类配色：与 anim/pianoBlocks.mjs 同一套色（hsl(pc*30)），
// 让"同一个音在哪个模板里都是同一个颜色"成为全应用一致的语言。
export const pcHue = (pc) => (((pc % 12) + 12) % 12) * 30;
export const pcHsl = (pc, s = 85, l = 58, a = 1) =>
  (a >= 1 ? `hsl(${pcHue(pc)} ${s}% ${l}%)` : `hsla(${pcHue(pc)} ${s}% ${l}% / ${a})`);

// ---------- 通用常量 ----------
export const BG = '#0b0f14';        // 与 index.html 的 --stage 同色（未覆盖区域自然融合）
export const ACCENT = '#7dd3fc';    // 应用主强调色（冷青）
