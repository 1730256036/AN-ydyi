// ─────────────────────────────────────────────────────────────────────────────
// app/logpanel.mjs —— 调试日志面板（2026-09-15 从 app.mjs 抽成域模块）
//
// 面板只渲染内存里最近的日志(最多 LOG_SHOW_MAX 条，防大 DOM)；
// 完整内容(跨会话+摘要)走「导出 .log」。新日志到达时增量追加，不做整表重渲染
// （拖滑块这类高频 debug 也不会把整表重画）。
//
// 状态归属（① 状态收敛）：唯一可变状态 logFilterMin 封在这里，不导出——
// 外部只需要 logBind() 一个入口把事件接上。
//
// 跨域依赖由 configureLogPanel 注入：fmtClock（时间格式化，是 app 侧的共享纯函数）、
// setStatus（状态栏文案）。log 模块本身是 import，不是域。
// ─────────────────────────────────────────────────────────────────────────────

import log from '../log.mjs';

const docEl = (() => {
  const cache = {};
  return (id) => (cache[id] || (cache[id] = document.querySelector('#' + id)));
})();

let D = { fmtClock: (t) => String(t), setStatus: () => {} };
/** app.mjs 启动时接线。 */
export function configureLogPanel(deps) { D = Object.assign({}, D, deps); }

const LOG_LEVEL_NUM = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
let logFilterMin = 0;
const LOG_SHOW_MAX = 400;

function logPanelVisible() { const p = docEl('logPanel'); return !!p && !p.classList.contains('hidden'); }
export function logTogglePanel(force) {
  const p = docEl('logPanel');
  if (!p) return;
  // ⚠️ classList.toggle(token, force) 里 force=true 是"加上"该 token。
  // 这里传的是 `!show`，所以语义是"不显示时加 hidden"——写反方向会让面板永远打不开，
  // 且不抛任何异常（症状 = "点了没反应"）。存档面板就踩过这个坑。
  const show = force !== undefined ? force : p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  if (show) logRefresh();
}
function logRow(entry) {
  const row = document.createElement('div');
  row.className = 'lp-row lv-' + entry.level;
  row.append(
    Object.assign(document.createElement('span'), { className: 't', textContent: D.fmtClock(entry.ts) + ' ' }),
    Object.assign(document.createElement('span'), { className: 'lv', textContent: '[' + entry.level.padEnd(5) + '] ' }),
    Object.assign(document.createElement('span'), { className: 'cat', textContent: '{' + entry.cat + '} ' }),
    document.createTextNode(entry.msg),
  );
  if (entry.data !== undefined) {
    try {
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = '  ' + JSON.stringify(entry.data);
      row.appendChild(d);
    } catch (e) { /* data 序列化失败就只显示消息本身 */ }
  }
  return row;
}
export function logRefresh() {
  const box = docEl('lpList');
  if (!box) return;
  box.innerHTML = '';
  const all = log.entries().filter((e) => LOG_LEVEL_NUM[e.level] >= logFilterMin);
  const skip = Math.max(0, all.length - LOG_SHOW_MAX);
  if (skip > 0) {
    const more = document.createElement('div');
    more.className = 'lp-row lp-more';   // lp-more 让"增量追加"路径认得出这行占位（见 onAppend）
    more.textContent = `（前面还有 ${skip} 条未显示，完整内容请「导出 .log」）`;
    box.appendChild(more);
  }
  const frag = document.createDocumentFragment();
  for (const e of all.slice(skip)) frag.appendChild(logRow(e));
  box.appendChild(frag);
  const cnt = docEl('lpCount');
  if (cnt) cnt.textContent = all.length + ' 条';
  if (docEl('lpFollow') && docEl('lpFollow').checked) box.scrollTop = box.scrollHeight;
}
export function logBind() {
  const bBtn = docEl('btnLog'); if (bBtn) bBtn.addEventListener('click', () => logTogglePanel());
  const bClose = docEl('lpClose'); if (bClose) bClose.addEventListener('click', () => logTogglePanel(false));
  const bExp = docEl('lpExport');
  if (bExp) bExp.addEventListener('click', () => {
    log.exportText().then((text) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      a.download = 'log-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.log';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      D.setStatus('✓ 已导出日志 ' + a.download);
    }).catch((e) => D.setStatus('日志导出失败：' + (e.message || e)));
  });
  const bClr = docEl('lpClear');
  if (bClr) bClr.addEventListener('click', () => {
    if (!confirm('清空全部日志（含历史会话）？导出后再清空更稳妥。')) return;
    log.clear().then(logRefresh);
    D.setStatus('日志已清空');
  });
  for (const r of document.querySelectorAll('input[name=lpLevel]')) {
    r.addEventListener('change', () => {
      logFilterMin = r.value ? (LOG_LEVEL_NUM[r.value] || 0) : 0;
      logRefresh();
    });
  }
  // 面板开着时增量追加（拖滑块这类高频 debug 也不会整表重渲染）
  log.onAppend((e) => {
    if (!logPanelVisible()) return;
    if (LOG_LEVEL_NUM[e.level] < logFilterMin) return;
    const box = docEl('lpList');
    if (!box) return;
    // 整表渲染时 0 号位可能是"（前面还有 N 条未显示）"占位行——一开始增量追加，它的计数就过期了。
    // 旧写法判 `> LOG_SHOW_MAX + 1` 却从 firstChild 删起：第一次追加就把占位行本身删掉，
    // 提示消失、lpCount 也不再更新。2026-09-18 修：先摘掉过期的占位行，再按上限从最旧端裁。
    const first = box.children[0];
    if (first && /lp-more/.test(first.className || '')) box.removeChild(first);
    box.appendChild(logRow(e));
    while (box.children.length > LOG_SHOW_MAX) box.removeChild(box.firstChild);
    const cnt = docEl('lpCount');
    if (cnt) cnt.textContent = log.entries().filter((x) => LOG_LEVEL_NUM[x.level] >= logFilterMin).length + ' 条';
    if (docEl('lpFollow') && docEl('lpFollow').checked) box.scrollTop = box.scrollHeight;
  });
}
