// ============================================================
// test/mirror-name.mjs —— proj/mirror.mjs（存档文件夹镜像的文件名规则）守卫
//
// 为什么值得守：server.mjs（PUT 校验）与前端（拼文件名）共用这份规则，
// 两边一旦错位就会出现"存得下、删不掉"或"穿越校验误放行"。纯函数 node 直跑。
// ============================================================
import { sanitizeNamePart, idSuffix, archiveFileName, isSafeArchiveName, isArchiveApiPath } from '../proj/mirror.mjs';

let fails = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[mirror-name] 存档镜像文件名规则');

// ---------- sanitizeNamePart ----------
const s = sanitizeNamePart('我的录音 12:30 <试>');
ck('结果不含任何非法/控制字符', !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(s), s);
ck('ASCII 非法字符逐个换 _', sanitizeNamePart('a:b<c>d*e') === 'a_b_c_d_e', sanitizeNamePart('a:b<c>d*e'));
ck('中文与普通空格原样保留', sanitizeNamePart('录音 12点') === '录音 12点', sanitizeNamePart('录音 12点'));
ck('连续空格压成一个', sanitizeNamePart('a   b c') === 'a b c', sanitizeNamePart('a   b c'));
ck('控制字符(如 \\t)也算非法换成 _', sanitizeNamePart('a\tb') === 'a_b', sanitizeNamePart('a\tb'));
ck('结尾的点/空格去掉(Windows 硬规则)', sanitizeNamePart('名字...') === '名字', sanitizeNamePart('名字...'));
ck('全非法 → 变下划线串(不空就不兜底)', sanitizeNamePart('???*') === '____', sanitizeNamePart('???*'));
ck('空 → archive', sanitizeNamePart('') === 'archive');
ck('超长截到 60 且截完不带尾点', (() => {
  const t = sanitizeNamePart('长'.repeat(80) + '...');
  return t.length === 60 && !/[.\s]$/.test(t);
})());
ck('含换行/控制字符也被换掉', !/[\x00-\x1f]/.test(sanitizeNamePart('a\nb\x00c')));

// ---------- idSuffix ----------
ck('id 后缀取前 8 位小写', idSuffix('0a95a4a6-e6e9-4817') === '_0a95a4a6.ydyi', idSuffix('0a95a4a6-e6e9-4817'));
ck('id 后缀剥掉非字母数字', idSuffix('p 1a2b!') === '_p1a2b.ydyi', idSuffix('p 1a2b!'));
ck('空 id → 空后缀主体', idSuffix('') === '_.ydyi');

// ---------- archiveFileName ----------
const fn = archiveFileName('0a95a4a6-e6e9-4817-a5db-df88f0d03e86', '录音 08:00:00');
ck('文件名 = 名字_id8.ydyi', fn === '录音 08_00_00_0a95a4a6.ydyi', fn);
ck('产出文件名能通过 isSafeArchiveName（自洽）', isSafeArchiveName(fn), fn);

// ---------- isSafeArchiveName（server 端校验，防穿越） ----------
ck('正常名放行', isSafeArchiveName('abc_12345678.ydyi'));
ck('.YDYI 大写后缀放行', isSafeArchiveName('abc_12345678.YDYI'));
ck('拒绝路径分隔', !isSafeArchiveName('a/b_12345678.ydyi'));
ck('拒绝反斜杠', !isSafeArchiveName('a\\b_12345678.ydyi'));
ck('拒绝 ..', !isSafeArchiveName('a..b_12345678.ydyi'));
ck('拒绝 .. 穿越拼装', !isSafeArchiveName('../../etc_12345678.ydyi'));
ck('拒绝非 .ydyi 后缀', !isSafeArchiveName('abc_12345678.exe'));
ck('拒绝控制字符', !isSafeArchiveName('a\x00b_12345678.ydyi'));
ck('拒绝首尾空白/点开头', !isSafeArchiveName(' .ydyi_12345678.ydyi'.trim() === '.ydyi_12345678.ydyi' ? '.ydyi_12345678.ydyi' : 'x'));
ck('拒绝过短名(装不下 id8)', !isSafeArchiveName('a_.ydyi'));
ck('拒绝超长名', !isSafeArchiveName('x'.repeat(201) + '_12345678.ydyi'));
ck('拒绝非字符串', !isSafeArchiveName(123) && !isSafeArchiveName(null));

// ---------- /g 正则状态雷回归 ----------
ck('连续多次 isSafeArchiveName 结果稳定(/g lastIndex 回归)', (() => {
  for (let i = 0; i < 5; i++) {
    if (!isSafeArchiveName('ok_' + '1234567' + i + '.ydyi'.slice(0, 5))) return false;  // 见下：直接测干净名
  }
  for (let i = 0; i < 5; i++) {
    if (isSafeArchiveName('bad\\' + i + '_12345678.ydyi')) return false;
    if (!isSafeArchiveName('good' + i + '_12345678.ydyi')) return false;
  }
  return true;
})());

// ---------- isArchiveApiPath（server 路由分发；2026-09-19 曾漏 archives-meta 酿成事故） ----------
ck('GET 列表路径放行', isArchiveApiPath('/api/archives'));
ck('★meta 路径放行（漏它=前端永远误判旧版本，2026-09-19 事故回归守卫）', isArchiveApiPath('/api/archives-meta'));
ck('单条操作路径放行', isArchiveApiPath('/api/archives/abc_12345678.ydyi'));
ck('相似但无关路径拒绝', !isArchiveApiPath('/api/archivesX') && !isArchiveApiPath('/api/archives-meta2'));
ck('静态文件夹路径不属于接口', !isArchiveApiPath('/archives/a.ydyi'));
ck('普通页面路径拒绝', !isArchiveApiPath('/') && !isArchiveApiPath('/index.html'));

console.log(fails ? `\n[mirror-name] ${fails} 项失败` : '\n[mirror-name] 全部通过');
process.exit(fails ? 1 : 0);
