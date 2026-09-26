// ============================================================
// proj/project.mjs —— 音高工程(.ydyi)：结构 / 序列化 / IndexedDB / 导入导出
//
// 对标同类应用 .zcp：工程 = 音频(可选内嵌) + 整段分析帧序列 + 元信息。
// 有了工程，播放/拖动=按时间二分查表，轨迹模板可画整段曲线。
//
// 工程对象结构：
// {
//   format: 'ydyi', version: 1,
//   id: string,              // 存档用 uuid
//   name: string,            // 用户命名
//   createdAt: number,
//   kind: string,            // 'audio' | 'midi'（见 inferKind）
//   audioName: string,       // 原文件名
//   audioMime: string,
//   duration: number,        // 秒
//   audioHash: string,       // 音频指纹(短 hash)，用于"不匹配"校验
//   analysis: {              // analyze-pool 的 result 直接存(帧带全局 t)
//     sr, windowSize, hopMs,
//     frames: [{t, freq, voiced, prom, purity, rms, str}],
//     stats: { minHz, maxHz },
//     params: { kernel, sens, voicing, hopMs, energy }   // 口径留痕（2026-09-20 加）
//   },
//   // ⚠ `analysis.sr` = 分析时【解码缓冲】的采样率（decodeAudioData 会重采样到 AudioContext
//   // 的采样率，且随环境/设备变），**不是存档那份音频自身的采样率**（实测同一文件会写 48000
//   // 而音频是 44100）。要复现/重算：帧栅格认 `hopMs`(毫秒)，窗长认 `windowSize/sr`(秒)；
//   // 拿存档音频重算时帧移按 hopMs×当前 sr 求——别把 sr 当音频音频率（2026-09-20 澄清）。
//   // `analysis.params` 记录真正喂给检测器的 sens/能量门/内核：不记 → 曲线不可复现、
//   // 无法解释"重算后为什么变了"（2026-09-20 加）。
//   // env: 细粒度包络(computeEnv 产出，见 projectToFile)。**必须随存档落盘**：
//   // 分段器靠它看检测窗(93ms)看不见的吐音气口，丢了 → 重开存档分段比录完当场粗一档。
//   // midiNotes: [{midi,t0,t1,vel}]|null —— MIDI 工程/转谱结果的音符表。
//   // 与 analysis 二选一：音频工程用 analysis(查表画曲线)，MIDI 工程用 midiNotes
//   // (喂钢琴块渲染+弹奏)。两者都可同时存在(AI 转谱给音频工程挂 midiNotes)。
//   // audioBlob: Blob|null  —— 序列化时不进 JSON，IndexedDB 单独存字段
// }
//
// .ydyi 文件 = JSON + 内嵌 audio 的 dataURL/array？体积大。
// 决策：内嵌音频用 base64(Blob->dataURL) —— 自包含可分享(对标 zcp 自含)。
// 也可 options.noAudio 导出纯分析(小文件,用于只读曲线)。
// ============================================================

const DB_NAME = 'ydyi-projects';
const STORE = 'projects';
const MAGIC = 'ydyi-project';

let dbPromise = null;

// ---------- 音频指纹 ----------
export function audioHashFromBuffer(buffer) {
  // 抽取前后 + 中间若干样本，FNV-1a 32bit；只用于"同一段音频"一致性粗校验
  const ch = buffer.getChannelData(0);
  const n = ch.length;
  const picks = 800;
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(n / picks));
  for (let i = 0; i < n; i += step) {
    // 用 16bit 量化近似
    let v = ch[i] < 0 ? ch[i] * 0x8000 : ch[i] * 0x7fff;
    v = Math.floor(v) & 0xffff;
    for (let k = 0; k < 2; k++) { h ^= (v >> (k * 8)) & 0xff; h = (h * 0x01000193) >>> 0; }
  }
  return 'h' + h.toString(16).padStart(8, '0');
}

export function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- 存档类型 ----------
// 列表要按"这是什么"分组，但工程对象里没有一个字段直接说类型，
// 只能从内容推断。优先级：有音符表=midi；有音频 blob 或 bufferRef=audio；
// 只有分析帧(无音频的纯曲线存档)=audio(仍是音频工程，只是没带音频)。
// 注意必须容错：老存档没有 kind 字段，读出时按这里的规则补算，不写库(向后兼容)。
export const KIND_MIDI = 'midi';
export const KIND_AUDIO = 'audio';
export function inferKind(p) {
  if (!p) return KIND_AUDIO;
  if (p.kind === KIND_MIDI || p.kind === KIND_AUDIO) return p.kind;
  if (Array.isArray(p.midiNotes) && p.midiNotes.length) return KIND_MIDI;
  return KIND_AUDIO;
}

// ---------- 存档来源 ----------
// 录音 / 导入音频 / MIDI 是三种**来源**，是三件不同的事，必须在落库那一刻记下来。
// ⚠ originLabel 必须由落库时写死的 source 决定，不能靠**名字猜**——
//   只有自动命名的 "录音 HH:MM:SS" 能认出来，用户点「存当前」自己起名就一律掉进
//   兜底分支变成"导入音频"，录音被错标。凡是"事后从内容倒推来源"的设计都不可靠
//   （名字可改、可撞车），所以现在：落库时写死 source，读的时候只信它。
export const SOURCE_REC = 'rec';        // 麦克风录音
export const SOURCE_IMPORT = 'import';  // 导入的音频文件
export const SOURCE_MIDI = 'midi';      // MIDI 文件 / AI 转谱
// 兜底推断（仅用于**没有 source 的老存档**，以及异常输入）：
//   有音符表 → midi；名字以「录音 」开头 → rec；有 audioName → import。
export function inferSource(p) {
  if (!p) return SOURCE_IMPORT;
  if (p.source === SOURCE_REC || p.source === SOURCE_IMPORT || p.source === SOURCE_MIDI) return p.source;
  if (inferKind(p) === KIND_MIDI) return SOURCE_MIDI;
  // ⚠ 不要用 /^录音\b/：\b 是 ASCII 词边界，中文不参与词法 ⇒ 恒假
  // （本函数刚写时正是这么错的，被 test/project-archive.mjs 抓到）。
  if (typeof p.name === 'string' && /^录音[\s\u00a0]/.test(p.name)) return SOURCE_REC;
  return SOURCE_IMPORT;
}
// 存档来源标签（列表 tab 用它分类）。三档固定：录音 / 导入音频 / MIDI——
// 那是"没有音频的音频工程"这个内部状态，对用户没有意义（2026-09-14 去掉）。
export const SOURCE_LABELS = { [SOURCE_MIDI]: 'MIDI', [SOURCE_REC]: '录音', [SOURCE_IMPORT]: '导入音频' };
export function originLabel(p) {
  const src = inferSource(p);
  // MIDI·转谱：**音频**工程做过 AI 转谱后挂了音符表（来源仍是音频，只是标注出来）。
  // ⚠ 2026-09-18 修：旧条件是 `p.imported === false`，而全仓（含全部历史提交）
  //   从来没有写过 imported 字段 → 这个分支自诞生起就不可能成立，'MIDI·转谱' 形同虚设。
  //   改按"来源不是 MIDI + 有音符表"判断（AI 转谱只挂 midiNotes、不动 source）。
  if (src !== SOURCE_MIDI && p.midiNotes && p.midiNotes.length) return 'MIDI·转谱';
  return SOURCE_LABELS[src] || '导入音频';
}

// ---------- 序列化(.ydyi JSON) ----------
// audio: 'embed'(默认,blob base64 内嵌) | 'none'(不含音频)
// 序列化统一走 projectToFile(异步：内嵌音频需 FileReader 读 dataURL)。
// parseProjectFile 负责反向解析为 {proj(含 audioBlob), includeAudio}。
export function projectToFile(proj, { includeAudio = true } = {}) {
  return new Promise((resolve, reject) => {
    const base = {
      magic: MAGIC, version: 1,
      id: proj.id, name: proj.name, createdAt: proj.createdAt,
      kind: inferKind(proj),
      // source: 真实来源(rec/import/midi)。必须带走，否则导出的 .ydyi 重新导入后
      // 分类会退化成"按名字猜"，录音又会被错标成导入音频。
      source: inferSource(proj),
      audioName: proj.audioName, audioMime: proj.audioMime,
      duration: proj.duration, audioHash: proj.audioHash,
      analysis: proj.analysis || null,
      // env: 细粒度包络(computeEnv 产出)。分段器靠它看检测窗(93ms)看不见的吐音气口，
      // 不存 → 打开存档后钢琴块分段比当时粗一档，且"跟录完立刻看"不一致。
      env: proj.env || null,
      // MIDI 工程的音符表必须带走，否则导出的 .ydyi 打开是一张空曲谱。
      // 音频工程若做过 AI 转谱也会挂 midiNotes，同样保留(重开即见转谱结果)。
      midiNotes: Array.isArray(proj.midiNotes) && proj.midiNotes.length ? proj.midiNotes : null,
    };
    if (!includeAudio || !proj.audioBlob) { resolve(JSON.stringify(base)); return; }
    const fr = new FileReader();
    fr.onload = () => { resolve(JSON.stringify({ ...base, audioDataUrl: fr.result })); };
    fr.onerror = () => reject(fr.error || new Error('读取音频失败'));
    fr.readAsDataURL(proj.audioBlob);
  });
}

// 解析 .ydyi 文本 -> {proj(含 audioBlob 若有), includeAudio, audioError}
// audioError：内嵌音频存在但解析失败时的原因（null = 没这回事）。带出去是为了让上层能报——
// 空 catch 会让"音频坏了"和"本来没音频"变成同一件事，用户只看到"无音频"，以为正常。
export function parseProjectFile(text) {
  const o = JSON.parse(text);
  if (!o || o.magic !== MAGIC) throw new Error('不是有效的 .ydyi 工程文件');
  const proj = {
    format: 'ydyi', version: o.version || 1,
    id: o.id || makeId(), name: o.name || '未命名工程', createdAt: o.createdAt || Date.now(),
    audioName: o.audioName || '', audioMime: o.audioMime || '',
    duration: o.duration || 0, audioHash: o.audioHash || '',
    analysis: o.analysis || null,
    env: o.env || null,
    midiNotes: Array.isArray(o.midiNotes) && o.midiNotes.length ? o.midiNotes : null,
    kind: o.kind || null,
    // 老 .ydyi 没有 source：留 null，由 inferSource 按名字/内容兜底，不在这里瞎猜写死
    source: o.source || null,
    audioBlob: null,
  };
  let includeAudio = false;
  let audioError = null;
  if (o.audioDataUrl) {
    try {
      proj.audioBlob = dataUrlToBlob(o.audioDataUrl);
      includeAudio = true;
    } catch (e) {
      // 音频坏了但分析可用 → 工程照旧能打开，但把原因带出去给调用方报日志。
      // 若这里是空 catch，下层只能拿到 includeAudio=false，无法区分
      // "这条存档本来就没音频"和"音频解析失败"（2026-09-22 修）。
      audioError = (e && e.message) || String(e);
    }
  }
  return { proj, includeAudio, audioError };
}

export function dataUrlToBlob(durl) {
  const [head, b64] = durl.split(',');
  const mime = /data:(.*?)(;|$)/.exec(head)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ---------- IndexedDB 存档 ----------
// 不可用时（隐私模式、file:// 打开、被浏览器策略禁用）明确报错并带上原因，
// 不要留一个永远 pending 的 Promise —— 那会让面板"点了没任何反应"，
// 连错误都看不到（2026-09-14）。
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('当前环境不支持 IndexedDB（请用 http:// 打开页面，不要直接用 file:// 双击打开）'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      reject(new Error('无法打开本地数据库：' + (e && e.message || e)));
      return;
    }
    // 被卡住时不无限等：8 秒没结果就给一个能看懂的错
    const guard = setTimeout(() => reject(new Error('打开本地数据库超时（可能被浏览器的隐私/无痕模式拦住了）')), 8000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { clearTimeout(guard); resolve(req.result); };
    req.onerror = () => { clearTimeout(guard); reject(req.error || new Error('本地数据库打开失败')); };
    req.onblocked = () => { clearTimeout(guard); reject(new Error('本地数据库被另一个标签页占用（请关掉其它 ydyi 页面重试）')); };
  });
  // 失败不要让 dbPromise 永久缓存成 rejected：下次点击还有机会重试（比如用户换了 http 打开）
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    // ⚠ 不能用 `out.result !== undefined` 区分"请求对象 vs 现成结果"：
    //    get() 一个**不存在的 key** 时 result 就是 undefined → 旧写法会把 IDBRequest
    //    本身（truthy）当结果 resolve 出去，于是 app 那边 `if (!rec) → 存档不存在`
    //    永远走不到，反而拿着请求对象去当存档用（2026-09-18 修）。
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function projectList() {
  return tx('readonly', (s) => s.getAll()).then((arr) =>
    (arr || []).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt,
      kind: inferKind(p),
      source: inferSource(p),
      duration: p.duration, audioName: p.audioName,
      hasAudio: !!p.audioBlob,
      noteCount: Array.isArray(p.midiNotes) ? p.midiNotes.length : 0,
      analysis: p.analysis || null })));
}

export function projectSave(proj) {
  const rec = {
    id: proj.id || makeId(), name: proj.name, createdAt: proj.createdAt || Date.now(),
    kind: inferKind(proj),
    source: inferSource(proj),
    audioName: proj.audioName, audioMime: proj.audioMime,
    duration: proj.duration, audioHash: proj.audioHash,
    analysis: proj.analysis || null,
  };
  if (proj.env) rec.env = proj.env;   // 细粒度包络：回放分段的气口线索，见 projectToFile 注释
  // 音符表单独一档：MIDI 工程只靠它复现钢琴块，漏存 = 存档打开是空谱。
  if (Array.isArray(proj.midiNotes) && proj.midiNotes.length) rec.midiNotes = proj.midiNotes;
  if (proj.audioBlob) rec.audioBlob = proj.audioBlob;   // IDB 可直接存 Blob
  if (!proj.id) proj.id = rec.id;
  return tx('readwrite', (s) => { s.put(rec); return rec; });
}

export function projectGet(id) {
  return tx('readonly', (s) => s.get(id));
}

export function projectDelete(id) {
  return tx('readwrite', (s) => { s.delete(id); });
}

export function projectRename(id, name) {
  return tx('readwrite', (s) => {
    const g = s.get(id);
    g.onsuccess = () => { const r = g.result; if (r) { r.name = name; s.put(r); } };
  });
}

// 整库删除（2026-09-19 存档迁到 archives/ 文件夹后的一次性迁移收尾用）。
// 库不存在也当成功（幂等）；被其他标签页挡住时不无限等，直接放行。
export function dropDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(); return; }
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('删除本地数据库失败'));
    req.onblocked = () => resolve();
  });
}
