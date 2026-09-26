// ─────────────────────────────────────────────────────────────────────────────
// app/proj-panel.mjs —— 存档面板（列表 / 分类 tab / 搜索 / 用量提示）
//                      2026-09-15 从 app.mjs 抽成域模块（① 状态收敛第六域）
//
// 这里只装**面板的渲染与交互**：
//   projPanelVisible / projTogglePanel / projSyncSaveCurBtn / projRefreshList /
//   projRefreshTabs / projRow / projRefreshFoot / projTabOf / fmtAgo
//
// 刻意**不搬**的（留在 app.mjs）：projSaveCurrent / projBuildRecord / projAutoArchive /
// projOpenArchive / projImportFile / projOpenImport / projExportY / projBind ——
// 它们是**编排者**：要 decodeBuf（解码）、loadClip（装载）、importMidiNotes（建 MIDI 工程）、
// switchTemplate（切模板）这些跨域动作。面板通过注入的回调调它们，自己不碰这些依赖。
//
// ── 状态归属 ──
//   projQuery / projTab / PROJ_TABS 封在这里（前者跨重渲染保留，是典型的面板私有状态）。
//   curProject 留在 app.mjs（它被 capture / player / isProjPlayback 读，是共享的"当前工程"），
//   面板只通过 getProject() 只读它——这也是本次能"少改 5 处写点"的原因。
//
// ⚠️ 面板本身没有任何写 curProject 的路径，所以"面板一开就把工程改坏"这类 bug 结构上不存在。
// ─────────────────────────────────────────────────────────────────────────────

import log from '../log.mjs';
import * as proj from '../proj/project.mjs';

const docEl = (() => {
  const cache = {};
  return (id) => (cache[id] || (cache[id] = document.querySelector('#' + id)));
})();

let D = {
  getProject: () => null,
  openArchive: () => {},
  renameArchive: () => {},
  deleteArchive: () => {},
  setStatus: () => {},
  fmtDur: (s) => String(s),
  // 存档列表（2026-09-19 起来自 archives/ 文件夹，经 app.mjs 注入本模块的 listArchives）
  listArchives: async () => { throw new Error('存档存储未接线'); },
  // 曲库（我的歌单）相关：由 app.mjs 注入 lib 域的具名函数（面板不反向 import 别的域）
  libProjItem: (id, name) => ({ t: 'proj', id, n: name || '' }),
  libIsFav: () => false,
  libToggleFav: () => false,
  libPickGroup: () => {},
};
/** app.mjs 启动时接线（列表面/动作由 app 侧提供，避免反向依赖）。 */
export function configureProjPanel(deps) { D = Object.assign({}, D, deps); }

// ===== 存档面板（2026-09-14 重做）=====
// 分类按【来源】：录音 / 导入音频 / MIDI 是三件不同的事，用户找东西时说得出
// "那段录音"，说不出"audio 类型"。kind 只用来决定徽章颜色。
// ⚠ 2026-09-14：① 去掉"纯曲线"这一栏（那是"没带音频的工程"这个内部
// 状态，对用户没意义）；② 三栏不要堆在一起上下滚，改成**点 tab 只看这一类**。
let projQuery = '';              // 面板搜索词（跨重渲染保留）
let projTab = 'all';             // 当前分类 tab：'all' | 'midi' | 'rec' | 'import'
// tab 定义（顺序 = 显示顺序）。标签带条数，不点也知道各类有多少。
const PROJ_TABS = [
  { id: 'all', label: '全部', src: null },
  { id: 'midi', label: 'MIDI', src: proj.SOURCE_MIDI },
  { id: 'rec', label: '录音', src: proj.SOURCE_REC },
  { id: 'import', label: '导入音频', src: proj.SOURCE_IMPORT },
];

export function projPanelVisible() { const p = docEl('projPanel'); return !!p && !p.classList.contains('hidden'); }

export function projTogglePanel(want) {
  const p = docEl('projPanel');
  if (!p) return;
  // classList.toggle(token, force)：force=true 是**加上** token（= 隐藏），false 才是移除。
  // 所以这里必须传"是否隐藏"(!show)，不能传"是否显示"。
  // 旧写法 `show === undefined ? !projPanelVisible() : !show` 把可见性直接当 force 传了，
  // 点「存档」时算出来是 true → 每次点击都在追加 hidden → 面板永远打不开，
  // 且不抛任何异常（症状 = "点了没反应"）。写法对齐 logTogglePanel（那里是对的）。
  const show = want !== undefined ? !!want : p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  if (show) { projRefreshList(); projSyncSaveCurBtn(); }
}

// 「存当前」按钮：没有可存的内容就置灰，免得点了没反应还要去状态栏找原因
export function projSyncSaveCurBtn() {
  const b = docEl('ppSaveCur');
  if (!b) return;
  const cur = D.getProject();
  const ok = !!(cur && ((cur.midiNotes && cur.midiNotes.length)
    || (cur.analysis && cur.analysis.frames && cur.analysis.frames.length)));
  b.disabled = !ok;
  b.title = ok ? '把当前正在看/听的内容存成一条档案' : '当前没有可存的内容（先录一段、导入音频或 MIDI）';
}

// 把一条存档归到某个 tab。用 source（落库时写死的真实来源）判定，
// 不用 originLabel 的展示文案，也**不从名字倒推**。
export function projTabOf(p) {
  const src = p && p.source ? p.source : proj.inferSource(p);
  return src === proj.SOURCE_MIDI ? 'midi' : (src === proj.SOURCE_REC ? 'rec' : 'import');
}

export function fmtAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

export function projRefreshList() {
  const box = docEl('ppList');
  if (!box) return;
  D.listArchives().then((list) => {
    if (!projPanelVisible()) return;
    projRefreshFoot(list);
    // tab 计数基于**全量**（不受搜索词影响），否则搜一下就"录音 0 条"很吓人
    projRefreshTabs(list);
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<span class="pp-empty">还没有存档。<br>录一段音、导入一个音频或 MIDI，就会自动存成一个 .ydyi 文件，'
        + '以后随时点开重看/重听。<br>（存档放在项目目录的 archives\\ 文件夹里，每条一个文件，资源管理器直接可见。）</span>';
      return;
    }
    const cur = D.getProject();
    const curId = cur && cur.id;
    const q = projQuery.trim().toLowerCase();
    // 排序：最近打开/保存的在最上面（用户找的多半是刚弄的那条）
    const sorted = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // 过滤：先按当前 tab 的来源，再按搜索词。点「MIDI」就只看到 MIDI，
    // 不把所有类别堆在一起上下滚。
    const shown = sorted.filter((p) => {
      if (projTab !== 'all' && projTabOf(p) !== projTab) return false;
      if (q && !String(p.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
    if (!shown.length) {
      const d = document.createElement('div');
      d.className = 'pp-empty';
      const tabName = (PROJ_TABS.find((t) => t.id === projTab) || {}).label || '全部';
      d.textContent = q
        ? '「' + tabName + '」里没有匹配「' + projQuery + '」的存档'
        : '「' + tabName + '」里还没有存档';
      box.appendChild(d);
      return;
    }
    for (const p of shown) box.appendChild(projRow(p, curId === p.id));
  }).catch((e) => {
    // 失败必须在面板里显式说出来 —— 状态栏在最右边、11px，用户根本看不到，
    // 表现就是"点了没反应"（2026-09-14）。这里两种都写。
    const msg = (e && e.message) || String(e);
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'pp-empty';
    d.style.color = 'var(--rec, #f87171)';   // 项目里没有 --danger；错误色统一用 --rec
    d.textContent = '打开存档失败：' + msg;
    box.appendChild(d);
    D.setStatus('存档不可用：' + msg);
    log.error('proj', '读取存档列表失败：' + msg, {});
  });
}

// 分类 tab 条：全部 / MIDI / 录音 / 导入音频，各带条数，当前项加粗高亮。
// 每次都整条重建（条数会随增删变化，重建比逐个更新简单且不会漏刷新）。
export function projRefreshTabs(list) {
  const bar = docEl('ppTabs');
  if (!bar) return;
  const counts = { all: list.length, midi: 0, rec: 0, import: 0 };
  for (const p of list) counts[projTabOf(p)]++;
  bar.innerHTML = '';
  for (const t of PROJ_TABS) {
    const b = document.createElement('button');
    b.className = 'btn-mini pp-tab' + (projTab === t.id ? ' on' : '');
    b.textContent = t.label + ' ' + counts[t.id];
    b.title = '只看' + t.label + '（共 ' + counts[t.id] + ' 条）';
    b.addEventListener('click', () => { projTab = t.id; projRefreshList(); });
    bar.appendChild(b);
  }
}

function projRow(p, isCurrent) {
  const row = document.createElement('div');
  row.className = 'pp-item' + (isCurrent ? ' cur' : '');

  const badge = document.createElement('span');
  badge.className = 'pp-badge ' + proj.inferKind(p);
  badge.textContent = proj.originLabel(p);

  const main = document.createElement('div');
  main.className = 'pp-main';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.title = '点击打开';
  nm.textContent = p.name + (isCurrent ? ' · 当前' : '');
  nm.addEventListener('click', () => D.openArchive(p.id));
  const meta = document.createElement('span');
  meta.className = 'meta';
  const bits = [];
  if (p.duration > 0) bits.push(D.fmtDur(p.duration));
  if (proj.inferKind(p) === proj.KIND_MIDI) bits.push((p.noteCount || 0) + ' 音符');
  else if (p.analysis && p.analysis.frames) bits.push(p.analysis.frames.length + ' 帧');
  bits.push(p.hasAudio ? '含音频' : '无音频');
  bits.push(fmtAgo(p.createdAt));
  meta.textContent = bits.filter(Boolean).join(' · ');
  main.append(nm, meta);

  const bOpen = document.createElement('button');
  bOpen.className = 'btn-mini accent'; bOpen.textContent = '打开';
  bOpen.addEventListener('click', () => D.openArchive(p.id));
  // 曲库（我的歌单）入口（2026-09-16）：曲库与存档不再重复 —— 存档是仓库，
  // 曲库是"我挑出来反复听/练的歌单"。这里给两个动作：☆ 一键收藏、＋歌单挑分组。
  const libItem = D.libProjItem(p.id, p.name);
  const bFav = document.createElement('button');
  bFav.className = 'btn-mini';
  const syncFav = () => {
    const on = D.libIsFav(libItem);
    bFav.textContent = on ? '★' : '☆';
    bFav.title = on ? '已在曲库·收藏里（点一下移出）' : '加入曲库·收藏';
    bFav.style.color = on ? 'var(--accent)' : '';
  };
  syncFav();
  bFav.addEventListener('click', () => {
    const on = D.libToggleFav(libItem);
    syncFav();
    D.setStatus(on ? '★ 已加入曲库·收藏：' + p.name : '已从曲库·收藏移出：' + p.name);
  });
  const bGrp = document.createElement('button');
  bGrp.className = 'btn-mini'; bGrp.textContent = '＋歌单';
  bGrp.title = '把这条放进曲库里的某个分组歌单（可多选，也能就地新建分组）';
  bGrp.addEventListener('click', () => D.libPickGroup(libItem, p.name));
  const bRen = document.createElement('button');
  bRen.className = 'btn-mini'; bRen.textContent = '改名';
  bRen.addEventListener('click', () => D.renameArchive(p.id));
  const bDel = document.createElement('button');
  bDel.className = 'btn-mini'; bDel.textContent = '删';
  bDel.title = '删除这条存档（音频/音符一并删除，无法恢复）';
  bDel.addEventListener('click', () => D.deleteArchive(p.id));

  row.append(badge, main, bOpen, bFav, bGrp, bRen, bDel);
  return row;
}

// 面板底部用量提示：IndexedDB 里存了多少、浏览器还允许占用多少。
// 录音存档是实打实占空间的（1 分钟 webm 约 0.5~1MB）。存档=archives/ 文件夹里的
// .ydyi 文件 → 大小直接用服务端 meta 回报的文件字节数合计，不估浏览器配额。
export function projRefreshFoot(list) {
  const foot = docEl('ppFoot');
  if (!foot) return;
  const n = list ? list.length : 0;
  const withAudio = (list || []).filter((p) => p.hasAudio).length;
  let txt = '共 ' + n + ' 条存档';
  if (withAudio) txt += '（其中 ' + withAudio + ' 条含音频）';
  const bytes = (list || []).reduce((s, p) => s + (p.bytes || 0), 0);
  if (bytes > 0) {
    const mb = (v) => (v / 1048576).toFixed(v > 104857600 ? 0 : 1);
    txt += '，共 ' + mb(bytes) + 'MB';
  }
  txt += '。存档就是 archives\\ 文件夹里的 .ydyi 文件（每条一个，资源管理器直接可见、可拷走备份）。'
    + '浏览器里不再保存存档（曲库收藏与界面设置除外）；服务没启动（没用 start-ydyi.bat）时列表读不到，但文件不会丢。';
  foot.textContent = txt;
}

/** app.mjs 启动时调用：绑定面板的搜索框（其余按钮由 app 侧的 projBind 接）。 */
export function bindProjPanel() {
  const search = docEl('ppSearch');
  if (search) search.addEventListener('input', () => { projQuery = search.value || ''; projRefreshList(); });
}
