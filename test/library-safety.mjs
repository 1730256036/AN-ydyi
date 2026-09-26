// ============================================================
// test/library-safety.mjs —— 曲库歌单的「数据安全」守卫（2026-09-18 建）
//
// 由来：loadGroups() 只在 buildLibPanel()
// 里被调一次，而存档面板的 ☆ / ＋歌单 是经注入**直连** libToggleFav / openLibGroupPicker
// 的，不需要先打开曲库面板。于是「刷新页面 → 不进曲库 → 直接给存档点 ☆」会拿一份
// **空表**去 saveGroups()（整表写回 localStorage）→ 用户既有收藏与全部自建分组被覆盖丢失，
// 同一根因下 libIsFav 还恒返回 false（已收藏的行显示空心 ☆）。
//
// 为什么不能塞进 test/library.mjs：那个文件每次都是先 showLibPanel() 再操作，
// 「没打开过面板」这条路径在它里面根本走不到——测试自己铺的前置条件把真实路径盖住了。
// 所以这里另起一个进程、**故意不打开面板**，也不 import app.mjs，只走 library 域自己的入口。
//
// 观察方式：localStorage（持久化的唯一真相源）只读快照 + libGroupsSnapshot()。
// ============================================================
import { installStubs } from './_harness.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
const LS = 'ydyi_lib_groups';

// ① 种入"上一次会话留下的歌单"：一条收藏 + 一个自建分组（收藏里那条 + 分组里那条都要活到最后）
globalThis.localStorage.setItem(LS, JSON.stringify([
  { id: 'fav', name: '收藏', items: [{ t: 'demo', f: '01 a (TH).mid' }] },
  { id: 'g1', name: '练声', items: [{ t: 'proj', id: 'p1', n: '录音 21:00' }] },
]));

// ② import 时机刻意放在种数据之后，且全程不开面板
const lib = await import('../app/library.mjs');
const read = () => JSON.parse(globalThis.localStorage.getItem(LS) || '[]');
const group = (id) => read().find((g) => g.id === id) || null;
const has = (gid, pred) => { const g = group(gid); return !!g && g.items.some(pred); };

console.log('[library-safety] 不开曲库面板时的歌单数据安全');

// ─────────── ③ 读入口：既有数据必须认得出来 ───────────
{
  ck('★libIsFav 认出既有收藏（未开面板；旧实现恒 false）',
    lib.libIsFav({ t: 'demo', f: '01 a (TH).mid' }) === true);
  ck('★libGroupsSnapshot 反映既有歌单（未开面板）', lib.libGroupsSnapshot().length === 2,
    JSON.stringify(lib.libGroupsSnapshot().map((g) => g.id)));
}

// ─────────── ④ 写入口：收藏不许把整表覆盖 ───────────
{
  const r = lib.libToggleFav({ t: 'proj', id: 'p9', n: '新录音' });
  ck('收藏：返回「刚加入」', r === true, String(r));
  ck('收藏：新条目进了收藏组', has('fav', (i) => i.id === 'p9'), JSON.stringify(group('fav')));
  ck('★收藏：原有收藏条目还在（没被清空）', has('fav', (i) => i.f === '01 a (TH).mid'),
    JSON.stringify(group('fav')));
  ck('★收藏：自建分组 g1 及其条目完好 —— 本次修的核心（旧实现这里整组消失）',
    !!group('g1') && group('g1').items.length === 1 && group('g1').items[0].id === 'p1',
    JSON.stringify(read()));
  ck('收藏：分组总数仍是 2（没被清成 1 个）', read().length === 2,
    JSON.stringify(read().map((g) => g.id)));
}

// ─────────── ⑤ 取消收藏：同样不许弄丢别的组 ───────────
{
  const r = lib.libToggleFav({ t: 'proj', id: 'p9', n: '新录音' });
  ck('再点一次 = 移出收藏', r === false, String(r));
  ck('★移出后：g1 依旧完好', !!group('g1') && group('g1').items.length === 1);
  ck('移出后：原有收藏条目也还在', has('fav', (i) => i.f === '01 a (TH).mid'));
}

// ─────────── ⑥ 「＋歌单」选择器：整条链都要在"没开过面板"的前提下成立 ───────────
{
  const before = H.createdEls.length;
  lib.openLibGroupPicker({ t: 'proj', id: 'p8', n: '录音 B' }, '录音 B', null);
  const btns = H.createdEls.slice(before)
    .filter((e) => e.className === 'btn-mini' && /练声/.test(e.textContent || ''));
  ck('★选择器列出了既有自建分组「练声」（旧实现列的是空表 → 点一下就覆盖整表）',
    btns.length === 1, '命中 ' + btns.length + ' 个：' +
    JSON.stringify(H.createdEls.slice(before).map((e) => e.textContent).filter(Boolean)));
  if (btns.length === 1) {
    const l = btns[0].__listeners.click || [];
    ck('选择器按钮挂上了点击监听', l.length > 0);
    try { if (l[0]) l[0](); } catch (e) { /* 桩缺 DOM 只影响这条，下面用存储断言兜 */ }
  }
  ck('★加入后 g1 变成 2 条', !!group('g1') && group('g1').items.length === 2,
    JSON.stringify(group('g1')));
  ck('★加入后收藏组与原有条目仍完好', has('fav', (i) => i.f === '01 a (TH).mid'), JSON.stringify(group('fav')));
  ck('加入后分组总数仍是 2', read().length === 2, JSON.stringify(read().map((g) => g.id)));
}

console.log(`[library-safety] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
