// test/library.mjs —— app/library.mjs（曲库 = 我的歌单）的特征测试
//
// 曲库的面板是惰性构建的，状态私有，所以观察方式走"外部可见效果"：
//   - libDisplayName 是导出的纯函数，直接断言（它承载着"编号剥离"那段历史坑）
//   - 面板 DOM 从 H.createdEls / document.body.children 里找（桩会记录）
//   - 歌单状态用 libGroupsSnapshot() 只读快照断言，localStorage 断言持久化
//
// 2026-09-16 曲库升级为"收藏 + 自建分组歌单"（与存档分工：存档=仓库，曲库=歌单），
// 本文件随之改：tab 顺序变为 收藏 → 自建分组… → 东方 → 古典 → 文件夹 → ＋新建分组，
// 用 dataset.mode 定位 tab（不按下标），并含歌单相关断言。
// 不要"用正则剥编号"，所以这里专门钉住那三个反例。

import { installStubs } from './_harness.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
await import('../app.mjs');
const lib = await import('../app/library.mjs');
const el = (id) => H.byId(id);

console.log('[library] 曲库（我的歌单）特征测试');

// ─────────── ① 未加载 manifest：显示名只是去掉扩展名 ───────────
{
  ck('无 titles 映射 → 去 .mid', lib.libDisplayName('11 月光.mid') === '11 月光', lib.libDisplayName('11 月光.mid'));
  ck('无 titles 映射 → 去 .midi', lib.libDisplayName('12 x.midi') === '12 x');
  ck('无扩展名 → 原样', lib.libDisplayName('naked') === 'naked');
  // 这三条是"别用正则剥编号"的书面依据（2026-09-14 明确要求）
  ck('★不误剥：2 Unlimited - No Limit', lib.libDisplayName('2 Unlimited - No Limit.mid') === '2 Unlimited - No Limit',
    lib.libDisplayName('2 Unlimited - No Limit.mid'));
  ck('★不误剥：2001 太空漫游', lib.libDisplayName('2001 太空漫游.mid') === '2001 太空漫游');
  ck('★不误剥：02 U.N.オーエン（后接拉丁字母）', lib.libDisplayName('02 U.N.オーエンは彼女なのか.mid') === '02 U.N.オーエンは彼女なのか');
}

// ─────────── ② 打开面板：惰性构建 DOM ───────────
let panel = null, tabs = null, fileIn = null, listEl = null;
const tabOf = (mode) => (tabs.children || []).find((e) => e.dataset && e.dataset.mode === mode);
{
  // 换一个会返回真 manifest 的 fetch（桩默认 reject，为的是让 RVC 探测快速失败）
  globalThis.fetch = async (url) => {
    if (/manifest\.json/.test(String(url))) {
      return { ok: true, json: async () => ({ songs: ['01 a (TH).mid', '11 b.mid'], titles: { '01 a (TH).mid': 'A 曲' } }) };
    }
    return { ok: false, status: 404 };
  };
  const before = H.createdEls.length;
  await lib.showLibPanel();
  ck('打开曲库：创建了面板 DOM', H.createdEls.length > before, String(H.createdEls.length - before));
  panel = (document.body.children || []).filter((e) => e.className === 'lib-panel' || e.id === 'created:div').pop();
  ck('打开曲库：面板已挂到 body（class=lib-panel）', !!panel && panel.className === 'lib-panel');
  ck('打开曲库：面板置为 flex', !!panel && panel.style.display === 'flex', panel && panel.style.display);

  tabs = panel && panel.children && panel.children[2];
  listEl = panel && panel.children && panel.children[4];
  ck('面板第 3 个子节点是 tab 容器（结构固定：head/search/tabs/分组工具/list/文件夹框）',
    !!(tabs && tabs.children && tabs.children.length >= 5), tabs && tabs.children ? String(tabs.children.length) : '(无)');
  ck('★tab 顺序：收藏 → 自建分组 → 东方 → 古典 → 文件夹 → ＋新建分组',
    !!tabOf('fav') && !!tabOf('east') && !!tabOf('classic') && !!tabOf('folder')
    && tabs.children[0].dataset.mode === 'fav'
    && tabs.children[tabs.children.length - 1].textContent === '＋ 新建分组',
    (tabs.children || []).map((e) => e.textContent).join(' | '));
  ck('默认停在「收藏」tab（曲库=歌单，先看自己的收藏）', tabs.children[0].classList._s.has('on'));
}

// ─────────── ③ manifest 加载后：titles 映射 + tab 计数 ───────────
{
  ck('titles 映射优先于文件名', lib.libDisplayName('01 a (TH).mid') === 'A 曲', lib.libDisplayName('01 a (TH).mid'));
  ck('无映射的文件名照旧去扩展名', lib.libDisplayName('11 b.mid') === '11 b');
  ck('★tab「东方」计数正确（含 "(TH" 判东方）', tabOf('east').textContent === '东方 1', tabOf('east').textContent);
  ck('★tab「古典」计数正确', tabOf('classic').textContent === '古典 1', tabOf('classic').textContent);
  ck('tab「文件夹」初始为 0', tabOf('folder').textContent === '文件夹 0', tabOf('folder').textContent);
  ck('收藏（初始空）计数 0', tabOf('fav').textContent === '收藏 0', tabOf('fav').textContent);
  ck('空收藏给出"去哪收藏"的提示',
    (listEl.children || []).some((e) => /存档/.test(e.textContent || '') && /☆/.test(e.textContent || '')),
    (listEl.children || []).map((e) => e.textContent).join(' | '));
}

// ─────────── ④ 载入本地文件夹：过滤 + 排序 + 计数 + 状态栏 ───────────
{
  fileIn = (panel.children || []).find((e) => e.type === 'file');
  ck('文件夹选择框已创建（webkitdirectory）', !!fileIn);
  ck('文件夹选择框属性正确', !!fileIn && fileIn.multiple === true && fileIn.getAttribute('webkitdirectory') === '');

  fileIn.files = [{ name: '05 z.mid' }, { name: '02 a.MID' }, { name: '忽略我.txt' }, { name: '09 q.midi' }];
  const h = fileIn.__listeners && fileIn.__listeners.change && fileIn.__listeners.change[0];
  ck('文件夹选择框有 change 监听', typeof h === 'function');
  h();
  ck('★只收 .mid/.midi（txt 被过滤）→ 文件夹计数 3', tabOf('folder').textContent === '文件夹 3', tabOf('folder').textContent);
  ck('载入文件夹后自动切到「文件夹」tab', tabOf('folder').classList._s.has('on'));
  ck('载入后状态栏给出条数', /3 首 MIDI/.test(el('recStatus').textContent), el('recStatus').textContent);

  fileIn.files = [{ name: 'a.txt' }, { name: 'b.wav' }];
  h();
  ck('全是非 MIDI → 计数归 0', tabOf('folder').textContent === '文件夹 0', tabOf('folder').textContent);
  ck('全是非 MIDI → 状态栏告知原因', /没有 \.mid/.test(el('recStatus').textContent), el('recStatus').textContent);
}

// ─────────── ⑤ 收藏：内置曲也能一键收藏（☆ 在东方/古典行上）───────────
{
  tabOf('east').__listeners.click[0]();            // 切到东方 tab
  const row = (listEl.children || []).find((e) => (e.children || []).some((c) => c.className === 'nm'));
  const nm = row && row.children.find((c) => c.className === 'nm');
  const fav = row && row.children.find((c) => c.className && c.className.indexOf('fav') === 0);
  ck('内置曲行有 ☆ 收藏按钮', !!fav && fav.textContent === '☆', fav && fav.textContent);
  ck('未收藏时 ☆ 是淡的（off）', !!fav && /off/.test(fav.className), fav && fav.className);

  fav.__listeners.click[0]({ stopPropagation() {} });
  ck('★点 ☆ 后进入收藏', lib.libIsFav(lib.libDemoItem('01 a (TH).mid')) === true);
  ck('★收藏落盘 localStorage（ydyi_lib_groups 里有 fav 组与条目）', (() => {
    const a = JSON.parse(globalThis.localStorage.getItem('ydyi_lib_groups') || '[]');
    const f = a.find((g) => g.id === 'fav');
    return !!f && f.items.length === 1 && f.items[0].t === 'demo' && f.items[0].f === '01 a (TH).mid';
  })(), globalThis.localStorage.getItem('ydyi_lib_groups'));
  ck('★收藏后 tab 计数 +1', tabOf('fav').textContent === '收藏 1', tabOf('fav').textContent);
  ck('状态栏确认收藏', /已收藏/.test(el('recStatus').textContent), el('recStatus').textContent);

  tabOf('fav').__listeners.click[0]();             // 切到收藏 tab 看条目
  const frow = (listEl.children || []).find((e) => e.className && e.className.indexOf('librow') === 0);
  ck('收藏 tab 里能看到这条（显示名走 titles 映射）',
    !!frow && (frow.children || []).some((c) => c.textContent === 'A 曲'),
    frow && (frow.children || []).map((c) => c.textContent).join('/'));
  const rm = frow && frow.children.find((c) => c.className === 'rm');
  ck('收藏 tab 的条目带 ✕ 移出按钮', !!rm);
  rm.__listeners.click[0]({ stopPropagation() {} });
  ck('★✕ 移出后收藏为空', lib.libGroupsSnapshot().find((g) => g.id === 'fav').n === 0);
  ck('移出后 tab 计数归 0', tabOf('fav').textContent === '收藏 0', tabOf('fav').textContent);
}

// ─────────── ⑥ 自建分组 + 从"存档条目"加入（含 ＋歌单 选择器）───────────
{
  const addBtn = tabs.children[tabs.children.length - 1];
  addBtn.__listeners.click[0]();                   // prompt 被桩成返回 '重命名测试'
  const snap = lib.libGroupsSnapshot();
  const g = snap.find((x) => x.id !== 'fav');
  ck('★新建分组：建出一个非收藏分组', !!g, JSON.stringify(snap.map((x) => x.name)));
  ck('新建分组后停在它的 tab 上', tabOf(g.id).classList._s.has('on'), tabOf(g.id) && tabOf(g.id).textContent);
  ck('空分组给出"用 ＋歌单 放进来"的提示',
    (listEl.children || []).some((e) => /＋歌单/.test(e.textContent || '')),
    (listEl.children || []).map((e) => e.textContent).join(' | '));
  ck('分组工具行出现「重命名分组 / 删除分组」', (() => {
    const tools = panel.children[3];
    return /重命名分组/.test((tools.children || []).map((e) => e.textContent).join('|'))
      && /删除分组/.test((tools.children || []).map((e) => e.textContent).join('|'));
  })());

  // 把一条"存档条目"放进这个分组（存档面板点 ＋歌单 走的就是这个函数）
  lib.openLibGroupPicker(lib.libProjItem('proj-1', '录音 12_00'), '录音 12_00');
  const picker = (document.body.children || []).filter((e) => e.className === 'libpicker').pop();
  ck('＋歌单：弹出归属选择器', !!picker);
  const btnOf = (pred) => (picker.children || []).map((b) => b.children && b.children[0]).find(pred);
  const gBtn = btnOf((b) => b && b.textContent.indexOf(g.name) === 0);
  ck('选择器里列出该分组', !!gBtn, (picker.children || []).map((e) => (e.children && e.children[0] || {}).textContent).join(' | '));
  gBtn.__listeners.click[0]();
  const gAfter = lib.libGroupsSnapshot().find((x) => x.id === g.id);
  ck('★点一下即把存档条目加入分组', gAfter.n === 1 && gAfter.items[0].t === 'proj' && gAfter.items[0].id === 'proj-1',
    JSON.stringify(gAfter.items));
  // ⚠ 每次点击后选择器会**重建**（innerHTML 清空重画）——必须重新找"最新一代"的按钮。
  // 复用旧按钮对象 = 拿着过期闭包（inIt 已被翻过）连点，只会一直移出（踩过）。
  {
    const onBtn = btnOf((b) => b && b.textContent.indexOf('✓ ' + g.name) === 0);
    ck('选择器里该项已标 ✓（表示在组内）', !!onBtn, onBtn && onBtn.textContent);
    if (onBtn) onBtn.__listeners.click[0]();            // 移出
    const offBtn = btnOf((b) => b && b.textContent.indexOf(g.name) === 0);
    ck('移出后该按钮回到未选中态（无 ✓）', !!offBtn && !/✓/.test(offBtn.textContent), offBtn && offBtn.textContent);
    if (offBtn) offBtn.__listeners.click[0]();          // 再加回
    ck('★移出再加回：仍只有 1 条（不重复）', lib.libGroupsSnapshot().find((x) => x.id === g.id).n === 1,
      JSON.stringify(lib.libGroupsSnapshot().find((x) => x.id === g.id).items));
  }

  // 分组列表里这条的显示：读不到存档清单（本环境没有 IndexedDB）→ 不许谎报"已删除"
  lib.showLibPanel();
  await H.sleep(30);
  tabOf(g.id).__listeners.click[0]();
  const grow = (listEl.children || []).find((e) => e.className && e.className.indexOf('librow') === 0);
  ck('★存档条目显示加入时记下的名字（读不到存档库时也不谎报"已删除"）',
    !!grow && (grow.children || []).some((c) => c.textContent === '录音 12_00')
      && !/删除/.test((grow.children || []).map((c) => c.textContent).join('')),
    grow && (grow.children || []).map((c) => c.textContent).join('/'));

  // 删分组：只删歌单，不动存档
  const delBtn = (panel.children[3].children || []).find((e) => e.textContent === '删除分组');
  delBtn.__listeners.click[0]();
  ck('★删除分组后回到收藏 tab 且分组消失',
    lib.libGroupsSnapshot().every((x) => x.id === 'fav') && tabOf('fav').classList._s.has('on'),
    JSON.stringify(lib.libGroupsSnapshot().map((x) => x.name)));
  ck('收藏组永不被删', lib.libGroupsSnapshot()[0].id === 'fav');
}

// ─────────── ⑦ 开合切换 ───────────
{
  lib.toggleLibPanel();
  ck('toggle → 收起（display=none）', panel.style.display === 'none', panel.style.display);
  lib.toggleLibPanel();
  ck('toggle → 再开（display=flex）', panel.style.display === 'flex', panel.style.display);
  lib.hideLibPanel();
  ck('hideLibPanel → 收起', panel.style.display === 'none');
}

// ─────────── ⑧ 对外只读：面板与曲目表都拿不到 ───────────
{
  const fns = Object.keys(lib).filter((k) => typeof lib[k] === 'function').sort();
  const want = ['configureLibrary', 'hideLibPanel', 'libDemoItem', 'libDisplayName', 'libGroupsSnapshot',
    'libIsFav', 'libProjItem', 'libToggleFav', 'openLibGroupPicker', 'showLibPanel', 'toggleLibPanel'].sort();
  ck('导出函数面 = 预期清单', JSON.stringify(fns) === JSON.stringify(want), JSON.stringify(fns));
  ck('没有导出任何内部状态（面板/曲目表/当前 tab/分组表都私有）',
    lib.libPanel === undefined && lib.libSongs === undefined && lib.libMode === undefined
    && lib.libTitles === undefined && lib.libGroups === undefined);
}

console.log(`[library] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
