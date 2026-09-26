// ============================================================
// anim/piano-sound.mjs —— 琴声引擎（2026-09-13 自 pianoBlocks.mjs 原样抽出；同日加多音源）
//
// 动机：音准练习(跟音练习模板/回声模式)也要弹琴声，引擎必须共享。
// 本模块 = pianoBlocks 原声音引擎逐行搬家，不改任何行为/参数/存储键。
//
// 音源（2026-09-13 新增，多声源支持）：
//   - 默认仍是 Salamander Grand 采样(CC-BY 3.0, Yamaha C5 实录)：每 3 半音一张采样，
//     C3..A6；其余音高用 playbackRate=2^((目标-采样)/12) 插值。**默认路径与加多音源前逐位一致。**
//   - 其余音色来自 gleitz/midi-js-soundfonts（MIDI.js 预渲染 GM 音源）：
//       FluidR3_GM —— CC-BY 3.0；128 个 GM 音色；88 键全音域(A0..C8)。
//       单音 URL：{base}{instrument}-mp3/{Note}.mp3
//       ⚠️ 2026-09-14 修过一次：fetch 曾漏拼 {instrument}-mp3/ 段 → 27 个 GM 音色全部
//          404 掉合成器兜底（"音色失效"的真因），base 里必须含乐器文件夹。
//       ⚠️ 2026-09-14 起全部采样内置本地 vendor/soundfonts/（800 个 mp3 约 17MB，
//          「直接全弄到本地，不搞联网下载」），完全离线；加载失败仍退合成器兜底。
//       ⚠️ 命名规则与 Salamander 不同：gleitz 用【降号】Db/Eb/Gb/Ab/Bb，
//          Salamander(tonejs) 用【升号】Ds/Fs —— 故每个音源自带 style，不能共用同一个函数。
//          （实测：gleitz 的 Ds4/Fs4 均 404，Db4/Gb4 均 200；-ogg 变体取不到，只用 mp3。）
//       ⚠️ 音色名必须照 names.json 抄：lead_8_bass__lead 是【双下划线】。
//   - 音色表 TIMBRES 见下；面板下拉「音色」单选切换，存 localStorage 'ydyi_piano_timbre'。
//   - 加载失败一律退回内置合成器(三角波+倍频+包络)，断网也能弹。
//
// 消费方：anim/pianoBlocks.mjs(块命中弹奏) / anim/practice.mjs(目标音) /
//         app.mjs(回声模式)。对外接口：ensureAudio / playPianoNote /
//         setSoundEnabled / setPianoVolume / soundEnabled / soundStatus /
//         listTimbres / getTimbre / setTimbre。
// ============================================================

// ---- 采样源（2026-09-14 起全部内置本地：vendor/soundfonts/，完全离线）----
// 体积实测：Salamander 20 张约 1.2MB；每个 GM 音色 30 张约 0.44~0.75MB，26 个共约 15MB。
// 当初走 CDN 是怕仓库变大；实测量级可接受，故全部内置本地、不联网下载。
const SALAMANDER_BASE = './vendor/soundfonts/salamander/';
const GM_BASE = './vendor/soundfonts/FluidR3_GM/';

// 半音名 → 文件名前缀。两套命名：升号(Ds/Fs，tonejs) / 降号(Db/Gb，gleitz/midi-js)
const SHARP_PC = { 0: 'C', 1: 'Cs', 2: 'D', 3: 'Ds', 4: 'E', 5: 'F', 6: 'Fs', 7: 'G', 8: 'Gs', 9: 'A', 10: 'As', 11: 'B' };
const FLAT_PC = { 0: 'C', 1: 'Db', 2: 'D', 3: 'Eb', 4: 'E', 5: 'F', 6: 'Gb', 7: 'G', 8: 'Ab', 9: 'A', 10: 'Bb', 11: 'B' };
export function sampleName(style, midi) {
  const pc = ((midi % 12) + 12) % 12;
  const nm = (style === 'flat' ? FLAT_PC : SHARP_PC)[pc];
  return nm + (Math.floor(midi / 12) - 1) + '.mp3';
}

function rangeMids(from, to, step) { const a = []; for (let m = from; m <= to; m += step) a.push(m); return a; }
const MIDS_PIANO = rangeMids(48, 105, 3);   // 现状（C3..A6，20 张）——不动，保默认音色行为一致
const MIDS_FULL = rangeMids(21, 108, 3);    // 88 键全音域 A0..C8（30 张 ≈ 0.6MB/音色）
const MIDS_GM = MIDS_FULL;

// ---- 音色表 ----
// sus=true：持续型音色（GM 每张采样只有 ~1~2s，长音须在稳态尾段无缝循环补足）；
// sus=false：打击/衰减型，保留自然衰减，不循环（钢琴/八音盒/马林巴等）。
const GM = (id, label, group, inst, sus) => ({
  id, label, group, kind: 'sample', base: GM_BASE + inst + '-mp3/', inst, style: 'flat', midis: MIDS_GM, sus, minOk: 6,
});
export const TIMBRES = [
  { id: 'salamander', label: '钢琴 · Salamander Grand', group: '钢琴（默认）', kind: 'sample',
    base: SALAMANDER_BASE, inst: null, style: 'sharp', midis: MIDS_PIANO, sus: false, minOk: 8 },

  GM('gm_calliope', '吹管 Lead · calliope', '主音 Lead（东方味）', 'lead_3_calliope', true),
  GM('gm_square', '方波 Lead · square', '主音 Lead（东方味）', 'lead_1_square', true),
  GM('gm_sawtooth', '锯齿 Lead · sawtooth', '主音 Lead（东方味）', 'lead_2_sawtooth', true),
  GM('gm_chiff', '切分 Lead · chiff', '主音 Lead（东方味）', 'lead_4_chiff', true),
  GM('gm_charang', '恰朗 Lead · charang', '主音 Lead（东方味）', 'lead_5_charang', true),
  GM('gm_voice_lead', '人声 Lead · voice', '主音 Lead（东方味）', 'lead_6_voice', true),
  GM('gm_fifths', '五度 Lead · fifths', '主音 Lead（东方味）', 'lead_7_fifths', true),
  GM('gm_bass_lead', '低音 Lead · bass+lead', '主音 Lead（东方味）', 'lead_8_bass__lead', true),

  GM('gm_music_box', '八音盒', '清脆音色', 'music_box', false),
  GM('gm_celesta', '钢片琴 celesta', '清脆音色', 'celesta', false),
  GM('gm_glockenspiel', '钟琴 glockenspiel', '清脆音色', 'glockenspiel', false),
  GM('gm_vibraphone', '颤音琴 vibraphone', '清脆音色', 'vibraphone', false),
  GM('gm_marimba', '马林巴 marimba', '清脆音色', 'marimba', false),
  GM('gm_xylophone', '木琴 xylophone', '清脆音色', 'xylophone', false),

  GM('gm_koto', '筝 koto', '和风', 'koto', false),
  GM('gm_shamisen', '三味线 shamisen', '和风', 'shamisen', false),
  GM('gm_shanai', '唢呐 shanai', '和风', 'shanai', true),
  GM('gm_taiko', '太鼓 taiko', '和风', 'taiko_drum', false),

  GM('gm_tremolo_str', '颤音弦乐', '弦乐 / 人声', 'tremolo_strings', true),
  GM('gm_string_ens', '弦乐合奏', '弦乐 / 人声', 'string_ensemble_1', true),
  GM('gm_synth_strings', '合成弦乐', '弦乐 / 人声', 'synth_strings_1', true),
  GM('gm_synth_choir', '合成人声', '弦乐 / 人声', 'synth_choir', true),
  GM('gm_fiddle', '小提琴 fiddle', '弦乐 / 人声', 'fiddle', true),

  GM('gm_epiano', '电钢琴', '其它键盘', 'electric_piano_1', false),
  GM('gm_harpsichord', '大键琴', '其它键盘', 'harpsichord', false),
  GM('gm_synth_bass', '合成贝斯', '其它键盘', 'synth_bass_1', true),

  { id: 'sf2local', label: '本地音源 sf2 / sf3（自选文件）', group: '本地音源', kind: 'sf2',
    base: null, inst: null, style: null, midis: [], sus: true, minOk: 0 },

  { id: 'synth', label: '内置合成器（离线兜底）', group: '离线兜底', kind: 'synth',
    base: null, inst: null, style: null, midis: [], sus: true, minOk: 0 },
];

const DEFAULT_TIMBRE = 'salamander';
export function timbreById(id) { return TIMBRES.find((t) => t.id === id) || null; }

let actx = null, master = null;

// 只读出口（2026-09-15，供 app.mjs 录屏时取琴声做音频汇流）：
// 本模块自带一个独立 AudioContext（不共用 app 的），录制要拿到它的输出节点，
// 才能在它自己的上下文里挂 MediaStreamDestination 再桥接过去。
// 这两个函数不改变任何行为，也不触发创建——未初始化时返回 null，调用方自行判空。
export function getAudioContext() { return actx; }
export function getOutputNode() { return master; }

let soundOn = false;
let pianoVol = 0.9;              // 琴声主音量(默认偏大，用户可调)
try { const pv = parseFloat(localStorage.getItem('ydyi_piano_vol')); if (Number.isFinite(pv)) pianoVol = Math.max(0, Math.min(1.5, pv)); } catch (e) {}

let cur = (() => {
  try { const s = localStorage.getItem('ydyi_piano_timbre'); return timbreById(s) || timbreById(DEFAULT_TIMBRE); } catch (e) { return timbreById(DEFAULT_TIMBRE); }
})();

// 每个音源各自的加载槽：{ state: idle|loading|ready|fallback|synth, bufs: Map(midi→AudioBuffer), loaded, total }
const slots = new Map();
function slotOf(t) {
  let s = slots.get(t.id);
  if (!s) { s = { state: 'idle', bufs: new Map(), loaded: 0, total: t.midis.length, promise: null }; slots.set(t.id, s); }
  return s;
}
slotOf(cur);

// ---- 本地音源（kind:'sf2'）----
// 用户自选 .sf2/.sf3 文件（面板文件按钮），浏览器内由 SpessaSynth(Apache-2.0) 解码播放。
// 这样真·东方音源（THfont / SD-90 采样包）也能用，且文件不进仓库（授权灰区，只本地自用）。
// 依赖链（importmap 已配）：spessasynth_lib → spessasynth_core → stb-vorbis；
// AudioWorklet 处理器在 vendor/spessasynth/spessasynth_processor.min.js（addModule 一次）。
const SF2_WORKLET_URL = './vendor/spessasynth/spessasynth_processor.min.js';
let sf2Buf = null;             // 用户选入的音库 ArrayBuffer
let sf2Synth = null;           // SpessaSynth WorkletSynthesizer（懒建，失败置 null 走合成器）
let sf2Chan = 0;               // 轮转通道 0..15：同音高叠加时避免 noteOff 互相掐断
let sf2WorkletAdded = false;   // addModule 同一 URL 重复调用会 reject，做一次性标记

// 选入音库文件（app.mjs 面板文件按钮调用）。加载在 loadCurrent 里懒做。
export function setSf2Bank(buf) {
  sf2Buf = buf instanceof ArrayBuffer ? buf : null;
  if (sf2Synth) { try { sf2Synth = null; } catch (e) {} }   // 换文件重建（简单起见不热替换）
  const s = slotOf(cur);
  if (cur.kind === 'sf2' && s.state !== 'idle') { s.state = 'idle'; if (actx) loadCurrent(); }
}

async function loadSf2() {
  const s = slotOf(cur);
  try {
    if (!sf2Buf) { s.state = 'needfile'; return; }
    if (!sf2Synth) {
      if (!sf2WorkletAdded) {
        await actx.audioWorklet.addModule(SF2_WORKLET_URL);
        sf2WorkletAdded = true;
      }
      const { WorkletSynthesizer } = await import('spessasynth_lib');
      sf2Synth = new WorkletSynthesizer(actx);
      sf2Synth.connect(master);        // 走本引擎的音量/压限主链，与其它音源同一把音量
    }
    await sf2Synth.soundBankManager.addSoundBank(sf2Buf, 'ydyi-sf2');
    s.state = 'ready';
  } catch (e) {
    console.error('[piano-sound] 本地音源加载失败，退回合成器:', e);
    sf2Synth = null;
    s.state = 'fallback';
  }
}

export function soundEnabled() { return soundOn; }

export function soundStatus() {
  const s = slotOf(cur);
  // 前 4 个字段是角标在用的，其余为多音源新增
  return {
    soundOn,
    sampleState: s.state,
    loadedCount: s.loaded,
    sampleCount: s.total,
    timbre: cur.id,
    timbreLabel: cur.label,
    timbreCount: TIMBRES.length,
    tKind: cur.kind,
    sf2Loaded: !!sf2Buf,
  };
}

// ---- 音色选择（面板下拉用）----
export function listTimbres() { return TIMBRES.map((t) => ({ id: t.id, label: t.label, group: t.group })); }
export function getTimbre() { return cur.id; }
export function setTimbre(id) {
  const t = timbreById(id);
  if (!t || t.id === cur.id) return false;
  cur = t;
  try { localStorage.setItem('ydyi_piano_timbre', t.id); } catch (e) {}
  // 懒加载：音频上下文已就绪才拉采样；否则等第一次 ensureAudio
  const s = slotOf(t);
  if (actx && (s.state === 'idle')) loadCurrent();
  return true;
}

export function setSoundEnabled(v) {
  soundOn = !!v;
  try { localStorage.setItem('ydyi_piano_sound', soundOn ? '1' : '0'); } catch (e) {}
  if (soundOn) ensureAudio();
}

// ---- 播放倍速（2026-09-17）----
// 钢琴块是按**播放时间轴**（d.audioMs）触发音符的：倍速下时间轴自己会按倍率推进，
// 所以"何时弹"不用这里管；要管的只有**时值**——spawnOnsets 传进来的 durMs 是工程里的
// 原时长，不被倍速缩放的话 0.5× 会听到一串断奏、2× 会糊成一片。
// 由播放器域经 app.mjs 注入（域间不互相 import）；非播放态一律回到 1。
// ⚠ 只影响"什么时候抬键"，不改音高：MIDI/转谱的音高由音符本身决定，
//   所以倍速对它们是天然的"变速不变调"（界面据此对静音时间轴隐藏「变调」开关）。
let noteRate = 1;
export function setPlayRate(r) { noteRate = Number.isFinite(r) && r > 0 ? r : 1; }
export function getPlayRate() { return noteRate; }

export function setPianoVolume(v) {
  pianoVol = Math.max(0, Math.min(1.5, +v || 0));
  try { localStorage.setItem('ydyi_piano_vol', String(pianoVol)); } catch (e) {}
  if (master) master.gain.value = pianoVol;
}

export function ensureAudio() {
  if (!actx) {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      master = actx.createGain();
      master.gain.value = pianoVol;
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 12; comp.ratio.value = 6;
      comp.attack.value = 0.004; comp.release.value = 0.18;
      master.connect(comp); comp.connect(actx.destination);
    } catch (e) { slotOf(cur).state = 'fallback'; return; }
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  if (slotOf(cur).state === 'idle') loadCurrent();
}

// 加载当前音源的采样。同一音色只拉一次（promise 复用）；切回已加载过的音源零等待。
// 采样全部内置在 ./vendor/soundfonts/（2026-09-14），同源 fetch 无网络依赖。
function loadCurrent() {
  const t = cur, s = slotOf(t);
  if (t.kind === 'synth') { s.state = 'synth'; return Promise.resolve(); }
  if (t.kind === 'sf2') {
    if (s.state === 'ready' && sf2Synth) return Promise.resolve();
    if (s.state === 'loading' && s.promise) return s.promise;
    s.state = 'loading';
    s.promise = loadSf2();
    return s.promise;
  }
  if (s.state === 'loading' || s.state === 'ready') return s.promise || Promise.resolve();
  if (!actx) return Promise.resolve();
  s.state = 'loading'; s.loaded = 0;
  s.promise = Promise.allSettled(t.midis.map(async (m) => {
    const r = await fetch(t.base + sampleName(t.style, m));
    if (!r.ok) throw new Error('http ' + r.status);
    const ab = await r.arrayBuffer();
    s.loaded++;
    const buf = await actx.decodeAudioData(ab);
    normalizeBuf(buf);
    return [m, buf];
  })).then((res) => {
    s.bufs = new Map(res.filter((x) => x.status === 'fulfilled').map((x) => x.value));
    s.state = s.bufs.size >= (t.minOk || 6) ? 'ready' : 'fallback';
  });
  return s.promise;
}

// 峰值归一化：把采样波形拉到 0.95 峰值(getChannelData 可变，原地缩放)
// 顺带统一各音源响度（GM 各音色原始电平差很大）
function normalizeBuf(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak > 0 && peak < 0.95) {
    const s = 0.95 / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= s;
    }
  }
}

function nearestBuf(bufs, midi) {
  let bm = -1, bd = 1e9;
  for (const m of bufs.keys()) {
    const d = Math.abs(m - midi);
    if (d < bd) { bd = d; bm = m; }
  }
  return bm >= 0 ? [bm, bufs.get(bm)] : null;
}

// 弹一个音：delaySec=相对现在的提前量(按播放头对齐调度)；durMs=音符时值(抬键收音)
// 倍速下两者都按 noteRate 缩放（见上方 setPlayRate）：时间轴已经是倍速的，
// 这里只把"同一时间轴上的秒数"换算成真实世界的秒数。
export function playPianoNote(midi, delaySec, durMs) {
  if (!actx || actx.state !== 'running') return;
  const t0 = actx.currentTime + Math.max(0, delaySec) / noteRate;
  const hold = Math.max(0.25, durMs / 1000 / noteRate);
  const g = actx.createGain();
  g.connect(master);
  const s = slotOf(cur);
  // 本地音源（SpessaSynth）：noteOn/noteOff 无时间参数，延迟用 setTimeout 调度。
  // 精度受主线程影响（忙时可能晚几十 ms）——块落键对齐要求高的场景建议用采样型音色。
  if (s.state === 'ready' && cur.kind === 'sf2' && sf2Synth) {
    const ch = sf2Chan; sf2Chan = (sf2Chan + 1) % 16;   // 轮转通道：同音高叠加不互相掐
    try {
      sf2Synth.noteOn(ch, midi, 100);
      setTimeout(() => { try { sf2Synth.noteOff(ch, midi); } catch (e) {} }, Math.round(hold * 1000));
      return;
    } catch (e) { console.error('[piano-sound] sf2 弹奏失败:', e); }
  }
  if (s.state === 'ready') {
    const near = nearestBuf(s.bufs, midi);
    if (!near) return fallbackTone(midi, t0, hold, g);
    const [sm, buf] = near;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (midi - sm) / 12);
    // 持续型音源(GM lead/弦乐/人声)每张采样只有约 1~2s，长音会中途干断；
    // 只在【时值明显超过采样长度】时，于采样稳态尾段(70%~97%)做无缝循环补足。
    // 打击/衰减型(钢琴/八音盒/马林巴)不进这里 → 保留自然衰减，与加多音源前行为一致。
    if (cur.sus) {
      const sampleDur = buf.duration / src.playbackRate.value;
      if (hold > sampleDur * 0.9) { src.loop = true; src.loopStart = buf.duration * 0.7; src.loopEnd = buf.duration * 0.97; }
    }
    g.gain.setValueAtTime(0.9, t0);
    g.gain.setValueAtTime(0.9, t0 + hold);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + hold + 0.35);   // 抬键轻收
    src.connect(g);
    src.start(t0);
    src.stop(t0 + hold + 0.4);
  } else {
    fallbackTone(midi, t0, hold, g);
  }
}

// 兜底合成器：三角波主音 + 倍频泛音 + 钢琴式包络
function fallbackTone(midi, t0, hold, g) {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const o1 = actx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
  const o2 = actx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
  const g2 = actx.createGain(); g2.gain.value = 0.25;
  o1.connect(g); o2.connect(g2); g2.connect(g);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.8, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.25, t0 + Math.min(0.6, hold));
  g.gain.exponentialRampToValueAtTime(0.001, t0 + hold + 0.6);
  o1.start(t0); o2.start(t0);
  o1.stop(t0 + hold + 0.7); o2.stop(t0 + hold + 0.7);
}
