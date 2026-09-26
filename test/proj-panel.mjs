// test/proj-panel.mjs —— app/proj-panel.mjs（存档面板域）的特征测试
//
// 这个域的两个纯函数（projTabOf / fmtAgo）是"分类口径"与"时间显示"的落点，
// 直接断言；面板开合、tab 条数、用量提示喂假 list 断言（它们都接受 list 参数）；
// 列表加载的**失败分支**在 node 里必现（没有 IndexedDB），正好把
// "错误必须显示在面板里、不能只写状态栏"这条 2026-09-14 的教训钉住。

import { installStubs } from './_harness.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
await import('../app.mjs');                       // 走真实接线
const panel = await import('../app/proj-panel.mjs');
const projMod = await import('../proj/project.mjs');
const el = (id) => H.byId(id);

console.log('[proj-panel] 存档面板域特征测试');

// ─────────── ① projTabOf：按 source 归类，不从名字倒推 ───────────
{
  ck('source=MIDI → tab "midi"', panel.projTabOf({ source: projMod.SOURCE_MIDI }) === 'midi');
  ck('source=录音 → tab "rec"', panel.projTabOf({ source: projMod.SOURCE_REC }) === 'rec');
  ck('source=导入音频 → tab "import"', panel.projTabOf({ source: projMod.SOURCE_IMPORT }) === 'import');
  ck('无 source 时兜底仍返回三个 tab 之一',
    ['midi', 'rec', 'import'].includes(panel.projTabOf({ name: 'x' })), panel.projTabOf({ name: 'x' }));
}

// ─────────── ② fmtAgo：时间格式化 ───────────
{
  ck('空时间戳 → 空串', panel.fmtAgo(0) === '' && panel.fmtAgo(null) === '');
  const t = new Date(2026, 0, 2, 3, 4).getTime();   // 2026-01-02 03:04
  ck('格式化补零到 "YYYY-MM-DD HH:MM"', panel.fmtAgo(t) === '2026-01-02 03:04', panel.fmtAgo(t));
}

// ─────────── ③ 面板开合（force 方向钉死） ───────────
{
  ck('初始 #projPanel 带 hidden', el('projPanel').classList.contains('hidden'));
  ck('初始面板不可见', panel.projPanelVisible() === false);
  panel.projTogglePanel(true);
  ck('projTogglePanel(true) → 去掉 hidden', !el('projPanel').classList.contains('hidden'));
  ck('projTogglePanel(true) → visible', panel.projPanelVisible() === true);
  panel.projTogglePanel(false);
  ck('projTogglePanel(false) → 加回 hidden', el('projPanel').classList.contains('hidden'));
  panel.projTogglePanel();
  ck('无参 toggle → 打开（不是单向）', panel.projPanelVisible() === true);
  panel.projTogglePanel();
  ck('再 toggle → 收起', panel.projPanelVisible() === false);
}

// ─────────── ④ tab 条数与文案 ───────────
{
  const list = [
    { source: projMod.SOURCE_REC, name: 'a' },
    { source: projMod.SOURCE_REC, name: 'b' },
    { source: projMod.SOURCE_MIDI, name: 'c' },
    { source: projMod.SOURCE_IMPORT, name: 'd' },
  ];
  panel.projRefreshTabs(list);
  const bar = el('ppTabs');
  const labels = (bar.children || []).map((b) => b.textContent);
  ck('tab 共 3+1 项（全部/MIDI/录音/导入音频）', labels.length === 4, JSON.stringify(labels));
  ck('「全部」计数 = 4', labels[0] === '全部 4', labels[0]);
  ck('「MIDI」计数 = 1', labels[1] === 'MIDI 1', labels[1]);
  ck('「录音」计数 = 2', labels[2] === '录音 2', labels[2]);
  ck('「导入音频」计数 = 1', labels[3] === '导入音频 1', labels[3]);
  ck('默认高亮「全部」', /(^|\s)on(\s|$)/.test(bar.children[0].className), bar.children[0].className);
}

// ─────────── ⑤ 用量提示 ───────────
{
  panel.projRefreshFoot([{ hasAudio: true }, { hasAudio: false }, { hasAudio: true }]);
  const txt = el('ppFoot').textContent;
  ck('底部提示含总条数', /共 3 条存档/.test(txt), txt);
  ck('底部提示含"含音频"条数', /其中 2 条含音频/.test(txt), txt);
  ck('底部提示说明"存档=archives 文件夹里的文件"（2026-09-19 定版口径）',
    /archives/.test(txt) && /文件夹/.test(txt) && /不再保存/.test(txt) && !/存档保存在浏览器本地，关页面/.test(txt), txt);
  panel.projRefreshFoot([]);
  ck('空列表提示不崩且为 0 条', /共 0 条存档/.test(el('ppFoot').textContent));
}

// ─────────── ⑥ 「存当前」按钮的可用性跟随当前工程 ───────────
{
  // 通过注入接口换"当前工程"（面板只读它，从不写）
  const mk = (cur) => { panel.configureProjPanel({ getProject: () => cur }); panel.projSyncSaveCurBtn(); };
  mk(null);
  ck('无当前工程 → 按钮置灰', el('ppSaveCur').disabled === true);
  ck('置灰时 title 说明原因', /没有可存的内容/.test(el('ppSaveCur').title), el('ppSaveCur').title);
  mk({ name: 'x', analysis: { frames: [] } });
  ck('有工程但零帧 → 仍置灰', el('ppSaveCur').disabled === true);
  mk({ name: 'x', analysis: { frames: [1, 2] } });
  ck('有分析帧 → 可存', el('ppSaveCur').disabled === false);
  mk({ name: 'm', midiNotes: [{}, {}] });
  ck('MIDI 工程（只有音符表）→ 也可存', el('ppSaveCur').disabled === false);
  ck('可存时 title 给出提示', /存成一条档案/.test(el('ppSaveCur').title), el('ppSaveCur').title);
}

// ─────────── ⑦ 列表加载失败必须显示在面板里（2026-09-14） ───────────
{
  panel.projTogglePanel(true);        // 打开面板
  el('ppList').children = [];
  panel.projRefreshList();
  await H.sleep(30);                  // projectList 是异步的
  const kids = el('ppList').children || [];
  ck('加载失败后面板里出现一条错误说明（不能只写状态栏）', kids.length > 0, String(kids.length));
  const txt = kids.length ? kids[kids.length - 1].textContent : '';
  ck('错误文案指明"打开存档失败"', /打开存档失败/.test(txt), txt);
  ck('状态栏同时也给了提示', /存档不可用|IndexedDB/.test(el('recStatus').textContent), el('recStatus').textContent);
  panel.projTogglePanel(false);
}

// ─────────── ⑧ 对外只读：面板状态不导出 ───────────
{
  const fns = Object.keys(panel).filter((k) => typeof panel[k] === 'function').sort();
  const want = ['bindProjPanel', 'configureProjPanel', 'fmtAgo', 'projPanelVisible',
    'projRefreshFoot', 'projRefreshList', 'projRefreshTabs', 'projSyncSaveCurBtn',
    'projTabOf', 'projTogglePanel'];
  ck('导出函数面 = 预期清单', JSON.stringify(fns) === JSON.stringify(want), JSON.stringify(fns));
  ck('面板私有状态不导出（projQuery / projTab / PROJ_TABS）',
    panel.projQuery === undefined && panel.projTab === undefined && panel.PROJ_TABS === undefined);
}

console.log(`[proj-panel] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
