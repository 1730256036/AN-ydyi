// ─────────────────────────────────────────────────────────────────────────────
// app/library.mjs —— 曲库 =「我的歌单」（2026-09-16 从"内置曲 + 文件夹浏览器"
//                    升级为 收藏夹 + 自建分组歌单）
//
// 为什么这么改（2026-09-16）：曲库与存档功能重叠 —— 两边都是"点一下就播的列表"。
// 现在分工明确：
//   存档 = 全部素材的仓库（录音/导入音频/MIDI 自动落库，一个不落）；
//   曲库 = 我挑出来想反复听/练的歌单（收藏 + 自建分组），条目**只存指针**，
//          可指向存档里的某条，也可指向内置 demo 曲。
//
// 数据模型（localStorage 'ydyi_lib_groups'，只存指针，几十字节）：
//   [{ id:'fav'|'g…', name:'收藏'|自定义, items:[{t:'proj',id,n}|{t:'demo',f}] }]
//   - 'fav' 是固定存在的「收藏」分组（不可删；可清空）——一键收藏的落点
//   - 同一条目可同时属于多个分组（不做互斥）
//   - 存 n（加入时的名字）是兜底：存档万一读不到（隐私模式/被清）也还能显示个名字
// 为什么不用 IndexedDB：只存指针，不值得为它升级 ydyi-projects 的 DB 版本
//   （proj/project.mjs 那套有 60 项守卫，版本升级的风险远大于收益）。
//
// 内置曲仍是 demo/manifest.json 列出的东方/古典两类；文件夹浏览保留（本地只读）。
// 面板 tab 顺序：收藏 → 自建分组… → 东方 → 古典 → 文件夹 → ＋新建分组
//
// 状态归属（① 状态收敛）：面板/搜索/文件夹/tab 计数等可变状态全封在这里，一个都不导出
// （外部只读快照函数 + 具名动作）。面板惰性构建（showLibPanel 时才建），顶层不查 DOM。
//
// 跨域依赖一律由 configureLibrary 注入（不反向 import 别的域，避免成环）：
//   setStatus / importMIDI / openArchive（曲库里点存档条目 = 存档面板里点"打开"）
//   / archiveList（取存档清单，用于显示名与"已删除"检测）。
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_DIR = './demo/';
const LS_GROUPS = 'ydyi_lib_groups';
const FAV_ID = 'fav';
const FAV_NAME = '收藏';

let D = {
  setStatus: () => {},
  importMIDI: async () => {},
  openArchive: () => {},
  archiveList: async () => [],
};
/** app.mjs 启动时接线：注入状态栏、MIDI 导入、存档打开与清单。 */
export function configureLibrary(deps) { D = Object.assign({}, D, deps); }

let libPanel = null, libListEl = null, libSearchEl = null, libFolderIn = null;
let libGToolsEl = null;     // 分组工具行（重命名/删除分组；非自定义分组时留空）
let libTabsEl = null;       // tab 容器（刷新计数要按顺序取按钮）
let libSongs = [];          // 内置示范曲文件名（manifest.json）
let libTitles = {};         // 文件名 → 显示名（manifest.json 的 titles，显式映射，零误伤）
let libFolderSongs = [];    // 文件夹曲目 { name, file }
let libMode = FAV_ID;       // 'fav' | 自定义分组 id | 'east' | 'classic' | 'folder'
let libArchives = null;     // Map(id → 存档条目)（打开面板时拉一次；null=还没拉到）

// ===== 歌单数据（localStorage）=====
function readLS(k) { try { return globalThis.localStorage.getItem(k); } catch (e) { return null; } }
function writeLS(k, v) { try { globalThis.localStorage.setItem(k, v); } catch (e) {} }

let libGroups = [];
// 表是否已从 localStorage 读过。**这是数据安全的开关**：
// 存档面板的 ☆ / ＋歌单 是经注入直连 libToggleFav / openLibGroupPicker 的，
// 不需要先打开曲库面板；而 saveGroups() 是"整表写回"。若此时还没读过表，
// 内存里就是一串空数组 → 一次收藏会把用户既有收藏与全部自建分组覆盖掉
// （2026-09-17 扫出，2026-09-18 修）。故所有读写入口先过 ensureGroups()。
let groupsLoaded = false;
function ensureGroups() { if (!groupsLoaded) loadGroups(); }
/** 条目形状校验 + 归一（外部/旧数据一律过一遍，别把脏数据带进渲染） */
function normItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (it.t === 'demo' && typeof it.f === 'string' && it.f) return { t: 'demo', f: it.f };
  if (it.t === 'proj' && typeof it.id === 'string' && it.id) {
    return { t: 'proj', id: it.id, n: typeof it.n === 'string' ? it.n : '' };
  }
  return null;
}
function sameItem(a, b) {
  if (!a || !b || a.t !== b.t) return false;
  return a.t === 'demo' ? a.f === b.f : a.id === b.id;
}
function loadGroups() {
  groupsLoaded = true;               // 幂等：重复调用只是又读一遍，不会丢内存里的改动
  libGroups = [];
  try {
    const arr = JSON.parse(readLS(LS_GROUPS) || '[]');
    if (Array.isArray(arr)) {
      for (const g of arr) {
        if (!g || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string' || !Array.isArray(g.items)) continue;
        libGroups.push({ id: g.id, name: g.name, items: g.items.map(normItem).filter(Boolean) });
      }
    }
  } catch (e) { /* 坏数据 → 从空开始，不打扰用户 */ }
  if (!libGroups.some((g) => g.id === FAV_ID)) libGroups.unshift({ id: FAV_ID, name: FAV_NAME, items: [] });
}
function saveGroups() {
  writeLS(LS_GROUPS, JSON.stringify(libGroups));
  renderLibTabs();
  if (libPanel && libPanel.style.display !== 'none') renderLibList();
}
function favGroup() {
  ensureGroups();
  let f = libGroups.find((g) => g.id === FAV_ID);
  if (!f) { f = { id: FAV_ID, name: FAV_NAME, items: [] }; libGroups.unshift(f); }
  return f;
}
export function libIsFav(item) {
  ensureGroups();
  const f = libGroups.find((g) => g.id === FAV_ID);
  return !!f && f.items.some((it) => sameItem(it, item));
}
/** ☆ 收藏开关：返回 true=刚加入，false=刚移出 */
export function libToggleFav(item) {
  const f = favGroup();
  const i = f.items.findIndex((it) => sameItem(it, item));
  if (i >= 0) { f.items.splice(i, 1); saveGroups(); return false; }
  const n = normItem(item);
  if (n) f.items.push(n);
  saveGroups();
  return true;
}
// —— 分组增删改（内部用；外部入口是 tab 行的「＋新建分组」与选择器）——
function addToGroup(gid, item) {
  const g = libGroups.find((x) => x.id === gid);
  if (!g || g.items.some((it) => sameItem(it, item))) return false;
  const n = normItem(item);
  if (!n) return false;
  g.items.push(n); saveGroups(); return true;
}
function removeFromGroup(gid, item) {
  const g = libGroups.find((x) => x.id === gid);
  if (!g) return false;
  const i = g.items.findIndex((it) => sameItem(it, item));
  if (i < 0) return false;
  g.items.splice(i, 1); saveGroups(); return true;
}
function createGroup(name) {
  const nm = String(name || '').trim() || ('分组 ' + (libGroups.filter((g) => g.id !== FAV_ID).length + 1));
  const g = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: nm, items: [] };
  libGroups.push(g); saveGroups(); return g;
}
function renameGroup(gid, name) {
  const g = libGroups.find((x) => x.id === gid);
  if (!g || g.id === FAV_ID) return false;          // 收藏是固定名，不给改
  const nm = String(name || '').trim();
  if (!nm) return false;
  g.name = nm; saveGroups(); return true;
}
function deleteGroup(gid) {
  if (gid === FAV_ID) return false;                  // 收藏不可删（可清空）
  const i = libGroups.findIndex((g) => g.id === gid);
  if (i < 0) return false;
  libGroups.splice(i, 1);
  if (libMode === gid) libMode = FAV_ID;
  saveGroups(); return true;
}
/** 只读快照（测试/外部观察用；改状态一律走上面的具名函数） */
export function libGroupsSnapshot() {
  ensureGroups();      // 没读过表就返回空快照会骗到调用方（测试与"导出/统计"都看它）
  return libGroups.map((g) => ({ id: g.id, name: g.name, items: g.items.slice(), n: g.items.length }));
}
export const libProjItem = (id, name) => ({ t: 'proj', id, n: name || '' });
export const libDemoItem = (f) => ({ t: 'demo', f });

async function ensureLibSongs() {
  if (libSongs.length) return;
  try {
    const r = await fetch(DEMO_DIR + 'manifest.json');
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.songs)) libSongs = j.songs.filter((x) => typeof x === 'string');
      if (j.titles && typeof j.titles === 'object') libTitles = j.titles;
    }
  } catch (e) { /* file:// 或清单缺失 → 列表空，不弹错误打扰 */ }
}
// 存档清单：只用来把 proj 条目显示成"名字 + 来源"，并识别"存档已被删除"。
// 每次打开面板都重查一遍（在存档里改过名/删过档，曲库这边得跟上）；
// 读不到（IDB 不可用/隐私模式）就**保持旧值或 null**——那时不许断言"已删除"，
// 否则会把"读不出库"误报成"这条存档没了"。
async function loadArchives() {
  try {
    const list = await D.archiveList();
    libArchives = new Map((list || []).map((p) => [p.id, p]));
  } catch (e) { /* 保持原状 */ }
}

export function toggleLibPanel() {
  if (libPanel && libPanel.style.display !== 'none') hideLibPanel(); else showLibPanel();
}
export async function showLibPanel() {
  if (!libPanel) buildLibPanel();
  libPanel.style.display = 'flex';
  renderLibTabs();
  renderLibList();                 // 先用现有数据画一版（不等网络/IDB）
  await Promise.all([ensureLibSongs(), loadArchives()]);
  // ⚠ 必须在 ensureLibSongs 之后刷新 tab 计数：buildLibPanel 里算计数时曲目还没加载，
  // 会显示"东方 0 / 古典 0"。这里补一次。
  renderLibTabs();
  renderLibList();
}
export function hideLibPanel() { if (libPanel) libPanel.style.display = 'none'; closeLibGroupPicker(); }

// ===== 条目描述（列表显示用）=====
function projItemInfo(it) {
  const rec = libArchives ? libArchives.get(it.id) : null;
  if (rec) {
    const bits = [];
    if (rec.duration > 0) bits.push(fmtSec(rec.duration));
    if (rec.kind === 'midi') bits.push((rec.noteCount || 0) + ' 音符');
    else if (rec.analysis && rec.analysis.frames) bits.push(rec.analysis.frames.length + ' 帧');
    bits.push(rec.source === 'midi' ? 'MIDI' : rec.source === 'rec' ? '录音' : '导入音频');
    return { label: rec.name || it.n || '(未命名)', meta: bits.join(' · '), missing: false };
  }
  if (libArchives) return { label: it.n || '(未命名存档)', meta: '存档已被删除', missing: true };
  return { label: it.n || ('存档 ' + String(it.id).slice(0, 8)), meta: '存档', missing: false };
}
function fmtSec(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

// ===== 打开一个曲库条目 =====
function openItem(it) {
  if (it.t === 'demo') {
    fetch(DEMO_DIR + encodeURIComponent(it.f))
      .then(async (r) => {
        if (!r.ok) throw new Error('http ' + r.status);
        const ab = await r.arrayBuffer();
        // archive:false：内置曲不入「我的存档」（2026-09-19）——
        // 内置曲永远在曲库里，点开只是播放，不该在存档列表里堆副本。
        await D.importMIDI(new File([ab], it.f, { type: 'audio/midi' }), { archive: false });
      })
      .catch((e) => D.setStatus('曲库载入失败：' + (e && e.message || e)));
    return;
  }
  // 存档条目：走存档面板的同一条路（解码/纯曲线/MIDI 都由它处理）
  D.openArchive(it.id);
}

// ===== 面板构建 =====
function buildLibPanel() {
  if (!document.getElementById('librow-style')) {
    const st = document.createElement('style');
    st.id = 'librow-style';
    st.textContent = '.librow{padding:5px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;'
      + 'overflow:hidden;text-overflow:ellipsis}.librow:hover{background:rgba(127,127,127,.18)}'
      + '.libhead{padding:6px 8px 2px;font-size:11px;opacity:.6}'
      + '.librow{display:flex;align-items:center;gap:6px}'
      + '.librow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}'
      + '.librow .mt{opacity:.45;font-size:11px;white-space:nowrap}'
      + '.librow.gone .nm{opacity:.5;text-decoration:line-through}'
      + '.librow .rm{border:none;background:transparent;color:inherit;opacity:.5;cursor:pointer;'
      + 'font-size:13px;padding:0 4px}.librow .rm:hover{opacity:1;color:#f87171}'
      + '.librow .fav{border:none;background:transparent;color:#7dd3fc;cursor:pointer;font-size:13px;padding:0 4px}'
      + '.librow .fav.off{color:inherit;opacity:.35}.librow .fav:hover{opacity:1}'
      + '.libpicker{position:fixed;right:18px;top:60px;width:260px;z-index:80;background:var(--surface);'
      + 'color:var(--ink);border:1px solid var(--hair-strong);border-radius:10px;padding:10px;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.3);font-size:13px}'
      + '.libpicker .pk-h{font-size:12px;opacity:.7;margin-bottom:6px;line-height:1.5}'
      + '.libpicker .pk-b{display:flex;align-items:center;gap:6px;padding:4px 0}'
      + '.libpicker .pk-b>button{flex:1}';
    document.head.appendChild(st);
  }
  libPanel = document.createElement('div');
  // 用 class（不是 id）作为"纯净模式隐藏"的钩子：index.html 的 `body.pure .lib-panel`。
  // 面板挂 document.body（不在 #app 内）且只有内联样式，不给钩子就没法被选择器命中
  // → 纯净模式下它会一直悬在画面上（2026-09-16 修）。
  // ⚠ 别改成 .id：测试桩用 id='created:div' 标记"由 JS 造出来的元素"，
  //   test/library.mjs 靠这个标记从 body.children 里认面板，覆盖 id 会让它找不到面板。
  libPanel.className = 'lib-panel';
  libPanel.style.cssText = 'position:fixed;left:14px;top:60px;width:380px;max-height:74vh;display:none;'
    + 'flex-direction:column;background:var(--surface);color:var(--ink);border:1px solid var(--hair);'
    + 'border-radius:12px;padding:10px;z-index:70;box-shadow:0 6px 24px rgba(0,0,0,.28);font-size:13px';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:600';
  head.appendChild(document.createTextNode('曲库'));
  const sp = document.createElement('span'); sp.style.flex = '1'; head.appendChild(sp);
  const folderBtn = document.createElement('button');
  folderBtn.className = 'btn-mini'; folderBtn.textContent = '打开文件夹';
  folderBtn.title = '选一个装满 MIDI 的文件夹（例如东方 MIDI 合集）。文件只在本地读取，不会上传。';
  folderBtn.addEventListener('click', () => libFolderIn.click());
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-mini'; closeBtn.textContent = '×'; closeBtn.title = '收起曲库';
  closeBtn.addEventListener('click', hideLibPanel);
  head.appendChild(folderBtn); head.appendChild(closeBtn);
  libPanel.appendChild(head);

  libSearchEl = document.createElement('input');
  libSearchEl.type = 'search'; libSearchEl.placeholder = '搜索曲名…';
  libSearchEl.style.cssText = 'background:var(--surface);color:var(--ink);border:1px solid var(--hair);'
    + 'border-radius:6px;padding:4px 8px;font-size:12px;outline:none;margin-bottom:6px';
  libSearchEl.addEventListener('input', renderLibList);
  libPanel.appendChild(libSearchEl);

  libTabsEl = document.createElement('div');
  libTabsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px';
  libPanel.appendChild(libTabsEl);

  // 分组工具行（重命名/删除）：位置固定（永远是第 4 个子节点），无内容时留空，
  // 免得列表容器索引随模式变化。所有内容每次由 renderLibTabs 重建。
  libGToolsEl = document.createElement('div');
  libGToolsEl.style.cssText = 'display:flex;gap:6px;margin-bottom:6px';
  libPanel.appendChild(libGToolsEl);

  libListEl = document.createElement('div');
  libListEl.style.cssText = 'overflow:auto;min-height:120px;max-height:56vh';
  libPanel.appendChild(libListEl);

  libFolderIn = document.createElement('input');
  libFolderIn.type = 'file'; libFolderIn.multiple = true;
  libFolderIn.setAttribute('webkitdirectory', '');
  libFolderIn.style.display = 'none';
  libFolderIn.addEventListener('change', () => {
    const all = Array.from(libFolderIn.files || []);
    libFolderSongs = all.filter((f) => /\.midi?$/i.test(f.name))
      .map((f) => ({ name: f.name.replace(/\.midi?$/i, ''), file: f }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    libMode = 'folder'; renderLibTabs(); renderLibList();
    D.setStatus(libFolderSongs.length ? '✓ 曲库：文件夹载入 ' + libFolderSongs.length + ' 首 MIDI' : '该文件夹里没有 .mid 文件');
  });
  libPanel.appendChild(libFolderIn);
  document.body.appendChild(libPanel);

  loadGroups();
  renderLibTabs();
}

// ===== tab 条（收藏 / 自建分组 / 东方 / 古典 / 文件夹 / ＋新建分组）=====
const isEastName = (s) => /\(TH/i.test(s);
const EAST_SONGS = () => libSongs.filter(isEastName);
const CLASSIC_SONGS = () => libSongs.filter((s) => !isEastName(s));

function renderLibTabs() {
  if (!libTabsEl) return;
  libTabsEl.innerHTML = '';
  libGToolsEl.innerHTML = '';
  const mkTab = (id, label) => {
    const b = document.createElement('button');
    b.className = 'btn-mini'; b.textContent = label; b.dataset.mode = id;
    if (libMode === id) b.classList.add('on');
    b.addEventListener('click', () => { libMode = id; renderLibTabs(); renderLibList(); });
    libTabsEl.appendChild(b);
    return b;
  };
  // 我的歌单在前（收藏 → 自建分组），内置在后（东方/古典/文件夹）
  mkTab(FAV_ID, FAV_NAME + ' ' + (libGroups.find((g) => g.id === FAV_ID) || { items: [] }).items.length);
  for (const g of libGroups.filter((g) => g.id !== FAV_ID)) mkTab(g.id, g.name + ' ' + g.items.length);
  mkTab('east', '东方 ' + EAST_SONGS().length);
  mkTab('classic', '古典 ' + CLASSIC_SONGS().length);
  mkTab('folder', '文件夹 ' + libFolderSongs.length);
  const add = document.createElement('button');
  add.className = 'btn-mini'; add.textContent = '＋ 新建分组';
  add.title = '新建一个分组歌单（把存档里的曲子分门别类，像内置的东方/古典那样）';
  add.addEventListener('click', () => {
    const nm = prompt('新分组名称：', '');
    if (nm === null) return;
    const g = createGroup(nm);
    libMode = g.id;
    renderLibTabs(); renderLibList();
    D.setStatus('✓ 已新建分组「' + g.name + '」——到「📚 存档」里点「＋歌单」把曲子放进来');
  });
  libTabsEl.appendChild(add);
  // 当前是自建分组 → 给出重命名/删除
  if (libMode !== FAV_ID && libGroups.some((g) => g.id === libMode)) {
    const g = libGroups.find((x) => x.id === libMode);
    const bn = document.createElement('button');
    bn.className = 'btn-mini'; bn.textContent = '重命名分组';
    bn.addEventListener('click', () => {
      const nm = prompt('分组名称：', g.name);
      if (nm === null) return;
      if (renameGroup(g.id, nm)) { renderLibTabs(); D.setStatus('✓ 分组已改名为「' + g.name + '」'); }
    });
    const bd = document.createElement('button');
    bd.className = 'btn-mini'; bd.textContent = '删除分组';
    bd.title = '删除这个分组（只删歌单本身，存档与音频都不受影响）';
    bd.addEventListener('click', () => {
      if (!confirm('删除分组「' + g.name + '」？（只删歌单，存档和音频都还在）')) return;
      const nm = g.name;
      deleteGroup(g.id);
      renderLibTabs(); renderLibList();
      D.setStatus('已删除分组「' + nm + '」');
    });
    libGToolsEl.appendChild(bn); libGToolsEl.appendChild(bd);
  } else if (libMode === FAV_ID) {
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:11px;opacity:.5';
    hint.textContent = '收藏 = 一键攒起来的曲子；要分类就「＋ 新建分组」';
    libGToolsEl.appendChild(hint);
  }
}

// 曲库列表的显示名：优先读 manifest.json 的 titles 显式映射。
// ⚠ 只是显示层处理，不改文件名（文件名带编号是排序稳定的约定，
// test/demo-songs.mjs 有断言守着）。
// 历史现象：古典那批文件名是 11..20 连续编号，直接展示就成了"古典从 11 开始"，
// 看着像漏了 1~10（2026-09-14 报）。东方/古典各自一个 tab，各自从 01 起才合理。
// ⚠ 别用正则去剥编号：实测 /^\s*\d+\s*[.\-_]?\s*/ 会把 `2 Unlimited - No Limit`
//   削成 `Unlimited - No Limit`；收紧成"数字+空格+后接 CJK"后又会漏剥
//   `02 U.N.オーエンは彼女なのか`（后接拉丁 U）、误剥 `2001 太空漫游`。
//   正则无法可靠区分「编号」与「曲名开头的数字」→ 只能显式声明。
export function libDisplayName(s) {
  if (libTitles[s]) return libTitles[s];
  return String(s).replace(/\.midi?$/i, '');
}

function renderLibList() {
  if (!libListEl) return;
  const q = (libSearchEl.value || '').trim().toLowerCase();
  const match = (n) => !q || String(n).toLowerCase().includes(q);
  libListEl.innerHTML = '';
  const addHead = (t) => {
    const d = document.createElement('div'); d.className = 'libhead'; d.textContent = t;
    libListEl.appendChild(d);
  };
  const addRow = (label, onclick) => {
    const d = document.createElement('div'); d.className = 'librow'; d.textContent = label;
    d.addEventListener('click', onclick);
    libListEl.appendChild(d);
  };
  // —— 自定义歌单（含收藏）：条目可能是"存档"或"内置曲" ——
  const g = libGroups.find((x) => x.id === libMode);
  if (g) {
    const rows = g.items.map((it) => {
      const info = it.t === 'demo'
        ? { label: libDisplayName(it.f), meta: '内置曲', missing: false }
        : projItemInfo(it);
      return { it, ...info, hit: match(info.label) };
    });
    const shown = rows.filter((r) => r.hit);
    addHead(g.name + ' ' + shown.length + '/' + rows.length + ' 条');
    if (!rows.length) {
      addHead(g.id === FAV_ID
        ? '收藏还是空的：到「📚 存档」里点 ☆ 收藏，或在东方/古典里点 ☆'
        : '这个分组还是空的：到「📚 存档」里点「＋歌单」把曲子放进来');
      return;
    }
    for (const r of shown) {
      const row = document.createElement('div');
      row.className = 'librow' + (r.missing ? ' gone' : '');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = r.label;
      const mt = document.createElement('span'); mt.className = 'mt'; mt.textContent = r.meta;
      const rm = document.createElement('button');
      rm.className = 'rm'; rm.textContent = '✕'; rm.title = '从这个歌单里移出（不影响存档本身）';
      rm.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeFromGroup(g.id, r.it);
        renderLibTabs(); renderLibList();
        D.setStatus('已从「' + g.name + '」移出：' + r.label);
      });
      row.appendChild(nm); row.appendChild(mt); row.appendChild(rm);
      row.title = r.missing ? '这条存档已被删除，点 ✕ 移出即可' : '点一下播放/打开';
      row.addEventListener('click', () => {
        if (r.missing) { D.setStatus('这条存档已被删除：' + (r.it.n || '') + '（点 ✕ 从歌单移出）'); return; }
        openItem(r.it); hideLibPanel();
      });
      libListEl.appendChild(row);
    }
    return;
  }
  // —— 内置曲（东方/古典）与文件夹 ——
  if (libMode === 'east' || libMode === 'classic') {
    const arr = libSongs.filter((s) => (libMode === 'east' ? isEastName(s) : !isEastName(s)));
    // 搜索同时匹配「显示名」与「原始文件名」，这样搜 "月光" 和搜 "11" 都能命中。
    const shown = arr.filter((s) => match(libDisplayName(s)) || match(s));
    addHead((libMode === 'east' ? '东方 Project' : '古典名曲') + ' ' + shown.length + '/' + arr.length + ' 首');
    for (const s of shown) {
      const row = document.createElement('div');
      row.className = 'librow';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = libDisplayName(s);
      const it = libDemoItem(s);
      const fav = document.createElement('button');
      const syncFav = () => {
        const on = libIsFav(it);
        fav.className = 'fav' + (on ? '' : ' off');
        fav.textContent = on ? '★' : '☆';
        fav.title = on ? '已收藏（点一下取消）' : '收藏到曲库·收藏';
      };
      syncFav();
      fav.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const on = libToggleFav(it);
        syncFav(); renderLibTabs();
        D.setStatus(on ? '★ 已收藏：' + libDisplayName(s) : '已取消收藏：' + libDisplayName(s));
      });
      row.appendChild(nm); row.appendChild(fav);
      row.addEventListener('click', () => { openItem(it); hideLibPanel(); });
      libListEl.appendChild(row);
    }
    if (q && !shown.length) addHead('没有匹配「' + q + '」的曲子');
  } else {
    const shown = libFolderSongs.filter((x) => match(x.name));
    addHead('文件夹 ' + shown.length + '/' + libFolderSongs.length + ' 首');
    // 文件夹条目是本地 File（每次都要重选文件夹），没法持久化 → 不给收藏按钮
    for (const x of shown.slice(0, 300)) addRow(x.name, () => { D.importMIDI(x.file); hideLibPanel(); });
    if (shown.length > 300) addHead('…只显示前 300 首，请用搜索框缩小范围');
    if (!libFolderSongs.length) addHead('还没打开文件夹：点右上「打开文件夹」选你的 MIDI 目录');
  }
}

// ===== 归属选择器（从存档面板点「＋歌单」时弹出）=====
// 一个浮层，列出全部分组：点一下＝加入/移出（可多分组），另有「＋新建分组」。
let libPicker = null;
function closeLibGroupPicker() {
  if (libPicker) { try { libPicker.remove(); } catch (e) {} libPicker = null; }
}
/**
 * 打开"把某条目放进哪个歌单"的选择器。
 * item: {t:'proj'|'demo', …}；label: 显示用的名字；onChanged: 每次改动后的回调（刷新星标等）
 */
export function openLibGroupPicker(item, label, onChanged) {
  ensureGroups();        // 没过这道守卫，下面列的就是空表 → 点一下反而把整表覆盖（见 ensureGroups 注释）
  closeLibGroupPicker();
  const wrap = document.createElement('div');
  wrap.className = 'libpicker';
  const paint = () => {
    wrap.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'pk-h';
    h.textContent = '把「' + (label || '这条') + '」放进歌单：点一下加入/移出，可同时属于多个分组';
    wrap.appendChild(h);
    for (const g of libGroups) {
      const inIt = g.items.some((it) => sameItem(it, item));
      const b = document.createElement('button');
      b.className = 'btn-mini' + (inIt ? ' accent' : '');
      b.textContent = (inIt ? '✓ ' : '') + g.name + '（' + g.items.length + '）';
      b.addEventListener('click', () => {
        if (inIt) removeFromGroup(g.id, item); else addToGroup(g.id, item);
        paint(); if (onChanged) onChanged();
      });
      const box = document.createElement('div'); box.className = 'pk-b';
      box.appendChild(b); wrap.appendChild(box);
    }
    const add = document.createElement('button');
    add.className = 'btn-mini accent'; add.textContent = '＋ 新建分组…';
    add.addEventListener('click', () => {
      const nm = prompt('新分组名称：', '');
      if (nm === null) return;
      const g = createGroup(nm);
      addToGroup(g.id, item);
      renderLibTabs();
      paint(); if (onChanged) onChanged();
      D.setStatus('✓ 已新建分组「' + g.name + '」并把这条放了进去');
    });
    const ab = document.createElement('div'); ab.className = 'pk-b'; ab.appendChild(add); wrap.appendChild(ab);
    const cl = document.createElement('button');
    cl.className = 'btn-mini'; cl.textContent = '完成';
    cl.addEventListener('click', closeLibGroupPicker);
    const cb = document.createElement('div'); cb.className = 'pk-b'; cb.appendChild(cl); wrap.appendChild(cb);
  };
  paint();
  document.body.appendChild(wrap);
  libPicker = wrap;
  // 点别处关闭（延迟一帧挂，免得刚打开就被同一次点击关掉）
  const onDoc = (ev) => {
    if (!libPicker) { document.removeEventListener('pointerdown', onDoc); return; }
    if (ev && ev.target && libPicker.contains && libPicker.contains(ev.target)) return;
    closeLibGroupPicker();
    document.removeEventListener('pointerdown', onDoc);
  };
  setTimeout(() => { try { document.addEventListener('pointerdown', onDoc); } catch (e) {} }, 0);
}
