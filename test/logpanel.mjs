// test/logpanel.mjs —— app/logpanel.mjs（日志面板域）的特征测试
//
// 观察点走"外部可见效果"：#logPanel 的 .hidden 类、#lpCount 的条数文案。
// logFilterMin 是私有状态，不直接断言——它只通过"级别筛选后条数变化"间接体现。

import { installStubs } from './_harness.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
await import('../app.mjs');
const lp = await import('../app/logpanel.mjs');
const log = (await import('../log.mjs')).default;
const el = (id) => H.byId(id);
const count = () => parseInt(String(el('lpCount').textContent).replace(/[^\d]/g, ''), 10);

console.log('[logpanel] 日志面板域特征测试');

// ─────────── ① 初始：面板收起 ───────────
{
  ck('初始 #logPanel 带 hidden（桩从 index.html 播种）', el('logPanel').classList.contains('hidden'));
}

// ─────────── ② 打开：去 hidden + 立即渲染 ───────────
{
  lp.logTogglePanel(true);
  ck('logTogglePanel(true) → 去掉 hidden', !el('logPanel').classList.contains('hidden'));
  ck('打开时会渲染一次：#lpCount 给出条数', /^\d+ 条$/.test(el('lpCount').textContent), el('lpCount').textContent);
}

// ─────────── ③ 新增日志 → 刷新 → 条数增加 ───────────
{
  const before = count();
  log.info('test', '特征测试条目 A');
  lp.logRefresh();
  const after = count();
  ck('新增一条日志后计数 +1', after === before + 1, before + ' → ' + after);

  log.warn('test', '特征测试条目 B');
  log.error('test', '特征测试条目 C');
  lp.logRefresh();
  ck('再加两条后计数 +2', count() === after + 2, String(count()));
}

// ─────────── ④ 关闭 ───────────
{
  lp.logTogglePanel(false);
  ck('logTogglePanel(false) → 加回 hidden', el('logPanel').classList.contains('hidden'));
}

// ─────────── ⑤ 无参 toggle = 切换语义 ───────────
{
  lp.logTogglePanel();
  ck('无参 toggle → 打开', !el('logPanel').classList.contains('hidden'));
  lp.logTogglePanel();
  ck('无参 toggle → 收起', el('logPanel').classList.contains('hidden'));
  lp.logTogglePanel();
  ck('再 toggle → 又打开（不是单向）', !el('logPanel').classList.contains('hidden'));
  lp.logTogglePanel(false);
}

// ─────────── ⑥ 面板收起时不往列表里追加（省 DOM） ───────────
{
  const listBefore = el('lpList').children ? el('lpList').children.length : 0;
  log.info('test', '面板收起时的条目');
  ck('面板收起：onAppend 不追加', (el('lpList').children ? el('lpList').children.length : 0) === listBefore,
    String(el('lpList').children ? el('lpList').children.length : 0) + ' vs ' + String(listBefore));
  lp.logTogglePanel(true);
  ck('打开后重新渲染，把刚才那条也补上', count() >= 4, String(count()));
  lp.logTogglePanel(false);
}

// ─────────── ⑦ 对外只读：筛选项不导出 ───────────
{
  const fns = Object.keys(lp).filter((k) => typeof lp[k] === 'function').sort();
  const want = ['configureLogPanel', 'logBind', 'logRefresh', 'logTogglePanel'];
  ck('导出函数面 = 预期清单', JSON.stringify(fns) === JSON.stringify(want), JSON.stringify(fns));
  ck('筛选阈值私有（不导出 logFilterMin）', lp.logFilterMin === undefined && lp.LOG_SHOW_MAX === undefined);
}

console.log(`[logpanel] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
