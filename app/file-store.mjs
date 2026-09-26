// ============================================================
// app/file-store.mjs —— 存档存储（2026-09-19 定版：真相源 = 工作目录 archives/ 文件夹）
//
// 存档存储走服务端文件：每条存档 = 工作目录 archives/ 下的一个 .ydyi 文件。
// 每条存档 = archives/ 下的一个 .ydyi 文件（含音频 base64），增删改查全走
// server.mjs 的 /api/archives 接口。序列化/解析仍复用 proj/project.mjs 纯函数。
//
// 启动时 migrateFromIdb() 做一次性迁移：把浏览器 IndexedDB 里的旧存档全部写成
// 文件，然后整库删除；迁移之后浏览器侧不留任何存档数据。
// 服务不可用（没用 start-ydyi.bat 启动）时：列表报错、存/删/改一律失败，
// 明确提示"本机存档服务不可用"——不做静默降级，免得用户以为存上了。
// ============================================================

import { archiveFileName, idSuffix } from '../proj/mirror.mjs';
import * as idb from '../proj/project.mjs';

// null = 未探测；true/false = 本机存档服务是否可用
export let storeOk = null;
// 'down' = 请求发不出去或服务异常；'old' = 服务在线但对 /api 返回 404——
// 即 8000 端口上是**旧代码启动的进程**（旧进程每次读盘发静态文件，页面是新的，
// 唯独没有 /api 路由，最容易误判成"bat 坏了"）。
export let storeWhy = 'down';

let D = { log: { info() {}, warn() {}, error() {} } };   // 跨域注入 log，不反向 import

export function configureFileStore(deps) {
  if (deps && deps.log) D = deps;
}

const errUnavailable = () => new Error(storeWhy === 'old'
  ? '8000 端口上是旧版本的服务在响应（旧窗口还开着）。请关掉旧的 ydyi-server 窗口，重新双击 start-ydyi.bat'
  : '本机存档服务不可用（请用 start-ydyi.bat 启动）');

// 探测：meta 接口通 = 可用。失败后每次操作前都会重探（server 可能刚启动）。
export async function probeStore() {
  try {
    const r = await fetch('/api/archives-meta');
    storeOk = !!(r && r.ok);
    if (!storeOk) storeWhy = (r && r.status === 404) ? 'old' : 'down';
  } catch (e) { storeOk = false; storeWhy = 'down'; }
  return storeOk;
}

async function ensureApi() {
  if (storeOk !== true) await probeStore();
  return storeOk === true;
}

async function listFileNames() {
  const r = await fetch('/api/archives');
  if (!r.ok) throw errUnavailable();
  const data = await r.json();
  return ((data && data.files) || []).map((f) => f.file).filter(Boolean);
}

function findFileById(names, id) {
  const suf = idSuffix(id);
  return names.find((n) => n.toLowerCase().endsWith(suf)) || null;
}

// 列表（proj-panel / 曲库共用）。输出形状对齐旧 projectList()：
// {id,name,createdAt,kind,source,duration,audioName,hasAudio,noteCount}（+bytes 总大小展示用）
export async function listArchives() {
  if (!(await ensureApi())) throw errUnavailable();
  const r = await fetch('/api/archives-meta');
  if (!r.ok) { storeOk = false; throw errUnavailable(); }
  const data = await r.json();
  return ((data && data.files) || [])
    .filter((m) => m && m.id)   // 解析失败的坏文件跳过，不炸整表
    .map((m) => ({
      id: m.id, name: m.name || '(未命名)', createdAt: m.createdAt || 0,
      kind: m.kind || (m.noteCount > 0 ? 'midi' : 'audio'),
      source: m.source || null,
      audioName: m.audioName || '', audioMime: m.audioMime || '',
      duration: m.duration || 0, audioHash: m.audioHash || '',
      hasAudio: !!m.hasAudio, noteCount: m.noteCount || 0,
      bytes: m.size || 0,
    }));
}

// 取单条完整存档（含音频 Blob），供打开回放。不存在返回 null。
export async function getArchive(id) {
  if (!(await ensureApi())) throw errUnavailable();
  const names = await listFileNames();
  const fn = findFileById(names, id);
  if (!fn) return null;
  const r = await fetch('/api/archives/' + encodeURIComponent(fn));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  // audioDataUrl → audioBlob 在这里还原。
  // ⚠ 内嵌音频解析失败时，parseProjectFile 里那个空 catch 会静默降级成"无音频"，
  //   结果和"这条存档本来就没音频"长得一模一样（用户看到"无音频，仅查看整段曲线"，
  //   以为正常）。故这里必须出声。2026-09-22 补。
  const { proj, audioError } = idb.parseProjectFile(text);
  if (audioError) {
    D.log.warn('proj', '存档内嵌音频解析失败，将按「无音频」打开：' + audioError, { id, file: fn });
  }
  return proj;
}

// 写入/覆盖一条存档（手动存档与自动存档共用）。返回 true/false。
export async function saveArchive(rec) {
  if (!rec || !rec.id) return false;
  if (!(await ensureApi())) return false;
  try {
    // ⚠ projectToFile 在"includeAudio=true 但没有 audioBlob"时会静默产出不含声音的档案
    //   （它只写曲线）。那条路径本身合法（MIDI / 纯曲线工程），但值得留痕，
    //   免得日后排查"这条存档为什么没声音"时无从下手。2026-09-22 加。
    if (!rec.audioBlob) D.log.info('proj', '本条存档没有音频数据，只写曲线', { id: rec.id, name: rec.name });
    const text = await idb.projectToFile(rec, { includeAudio: true });
    const fn = archiveFileName(rec.id, rec.name);
    const r = await fetch('/api/archives/' + encodeURIComponent(fn), { method: 'PUT', body: text });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    D.log.info('proj', '已写入存档文件', { file: fn, bytes: text.length });
    return true;
  } catch (e) {
    storeOk = false;
    D.log.warn('proj', '写入存档文件失败：' + (e.message || e), { id: rec.id });
    return false;
  }
}

// 按 id 删除（文件名后缀含 id 前 8 位，改名也能对上号）。幂等。
export async function deleteArchive(id) {
  if (!id) return false;
  if (!(await ensureApi())) return false;
  try {
    const names = await listFileNames();
    const suf = idSuffix(id);
    const hits = names.filter((n) => n.toLowerCase().endsWith(suf));
    for (const f of hits) {
      const d = await fetch('/api/archives/' + encodeURIComponent(f), { method: 'DELETE' });
      if (!d.ok) throw new Error('删除 ' + f + ' 失败 HTTP ' + d.status);
    }
    return true;
  } catch (e) {
    storeOk = false;
    D.log.warn('proj', '删除存档文件失败：' + (e.message || e), { id });
    return false;
  }
}

// 改名 = 按 id 删旧文件 + 按新名写新文件（rec 为完整存档记录）。
export async function renameArchive(id, rec, newName) {
  if (!(await deleteArchive(id))) return false;
  return saveArchive({ ...rec, name: newName });
}

// 一次性迁移：IndexedDB 旧存档 → archives/ 文件，然后整库删除。
// 返回迁移条数；-1 = 服务不可用或无 IDB（无事可做）。服务没起时旧数据原样保留，
// 下次启动带服务再迁——绝不先删库后写文件。
export async function migrateFromIdb() {
  if (!(await ensureApi())) return -1;
  let old = [];
  try { old = await idb.projectList(); } catch (e) { return -1; }
  if (!old.length) { try { await idb.dropDatabase(); } catch (e) {} return 0; }
  const names = await listFileNames();
  let n = 0;
  for (const meta of old) {
    const suf = idSuffix(meta.id);
    if (names.some((f) => f.toLowerCase().endsWith(suf))) continue;   // 已有同名 id 的文件，不重写
    const rec = await idb.projectGet(meta.id);
    if (!rec) continue;
    if (await saveArchive(rec)) n++;
  }
  try { await idb.dropDatabase(); } catch (e) {}
  D.log.info('proj', '旧存档迁移完成（IndexedDB → archives/）', { migrated: n, total: old.length });
  return n;
}
