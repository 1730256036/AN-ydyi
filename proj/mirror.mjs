// ============================================================
// proj/mirror.mjs —— 存档文件夹镜像：文件名规则（纯函数，零依赖）
//
// server.mjs（/api/archives 校验）与前端 app/file-store.mjs（拼文件名）
// 共用同一份规则，避免两边各写一套导致"存得下、删不掉"之类的错位。
//
// 文件名形状：`<存档名>_<id 前 8 位>.ydyi`
//   - 存档名给人看；id 后缀保证唯一 + 删除/改名时能按 id 定位文件
//     （改名后旧文件靠 id 后缀找到并清掉，不靠名字——名字会变）。
//   - 纯函数、无 DOM/window，node 与浏览器都可 import。
// ============================================================

// Windows 文件名非法字符 + 控制字符（含 DEL）
// ⚠ 两个常量分开：replace 用 /g 版本；test 必须用无 /g 版本（/g 的 .test() 有
//   lastIndex 状态，同一对象跨调用会间歇性误判——经典雷）。
const ILLEGAL = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
const HAS_ILLEGAL = /[\\/:*?"<>|\x00-\x1f\x7f]/;

// 存档名 → 文件名主体片段：非法字符换 _、压空白、去首尾空白与点（Windows 不许结尾是点）、限长
export function sanitizeNamePart(s) {
  let t = String(s || '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/[.\s]+$/, '');        // 结尾的点/空格（Windows 保留名之外的硬规则）
  if (t.length > 60) t = t.slice(0, 60).replace(/[.\s]+$/, '');
  return t || 'archive';
}

// id → 文件名后缀（"_abcdef12.ydyi"，小写）。删除/改名按这个后缀定位文件。
export function idSuffix(id) {
  return '_' + String(id || '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8).toLowerCase() + '.ydyi';
}

export function archiveFileName(id, name) {
  return sanitizeNamePart(name) + idSuffix(id);
}

// server 端校验：只放行"干净的 <name>_<id8>.ydyi"，防路径穿越与非法字符。
// 规则收紧到能通过 sanitize+idSuffix 产出的形状即可（文件名本来就是本模块生成的）。
export function isSafeArchiveName(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 5 + 1 + 8 || name.length > 200) return false;   // 最短: 1字名+_(1)+id8(8)+.ydyi(5)
  if (!/\.ydyi$/i.test(name)) return false;
  if (HAS_ILLEGAL.test(name)) return false;
  if (name.includes('..')) return false;
  if (name !== name.trim() || name.startsWith('.')) return false;
  return true;
}

// server 路由分发：哪些路径归"存档接口"处理。⚠ 单一真相源——曾因分发处漏了
// '/api/archives-meta'（只写了 /api/archives 和 /api/archives/ 前缀）导致 meta 接口
// 永远 404、前端永远误判"旧版本服务"（2026-09-19 事故）。加新接口必须在这里登记，
// 且 test/mirror-name.mjs 有守卫。
export function isArchiveApiPath(p) {
  return p === '/api/archives'
    || p === '/api/archives-meta'
    || (typeof p === 'string' && p.startsWith('/api/archives/'));
}
