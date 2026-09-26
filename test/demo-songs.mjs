// ============================================================
// test/demo-songs.mjs —— 内置曲库守卫（node 直跑，无浏览器、无网络）
// 背景：2026-09-13 加「曲库」功能，demo/ 内置 10 首东方名曲 MIDI。
// 这里保证：每个文件都能被项目自己的 parseSMF 解析、有可弹的非鼓音符、
// 时长合理、音高在 MIDI 0..127 内 —— 防止损坏/空文件混进仓库。
// ============================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSMF } from '../dsp/smf.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo');
const files = readdirSync(dir).filter((f) => /\.midi?$/i.test(f)).sort();

// 清单与文件必须一一对应（app.mjs 的曲库列表读的就是 manifest.json）
let manifest = null;
try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch (e) { /* 下面报 FAIL */ }

let fails = 0;
const ck = (name, cond, extra = '') => {
  if (cond) console.log('  ok  ' + name + extra);
  else { fails++; console.error('  FAIL ' + name + extra); }
};

console.log(`[demo-songs] 内置曲库守卫（demo/ 共 ${files.length} 首）`);
ck('demo 目录非空（至少 5 首）', files.length >= 5);
ck('文件名带编号前缀（曲库按名排序展示）', files.every((f) => /^\d\d /.test(f)));
ck('manifest.json 可读且 songs 是数组', !!manifest && Array.isArray(manifest.songs));
if (manifest && Array.isArray(manifest.songs)) {
  const disk = [...files].sort();
  const listed = [...manifest.songs].sort();
  ck('manifest 与磁盘文件一一对应（无缺漏/无多余）',
    disk.length === listed.length && disk.every((f, i) => f === listed[i]),
    disk.length === listed.length ? '' : ` → 磁盘 ${disk.length} vs 清单 ${listed.length}`);
  ck('manifest 曲名带 .mid 扩展名（fetch 按名取文件）', manifest.songs.every((s) => /\.midi?$/i.test(s)));
  // 曲库按「东方 / 古典」分 tab（2026-09-14，app.mjs renderLibList 同一规则：
  // 文件名含 "(TH" 判为东方 Project）。这里守住两点：
  //   ① 两类都非空 —— 否则某个 tab 点开是空的，像坏了；
  //   ② 规则确实分得开 —— 不能出现"全是东方"或"全是古典"这种退化。
  const isEast = (s) => s.toLowerCase().includes('(th');
  const east = manifest.songs.filter(isEast).length;
  const classic = manifest.songs.length - east;
  ck('曲库分类：东方/古典两类都非空',
    east > 0 && classic > 0, ` → 东方 ${east} / 古典 ${classic}`);

  // titles 显示名映射（2026-09-14）：文件名里的「11 」这类编号是文件名自带的
  // （上面 /^\d\d / 那条守着），列表里不显示。app.mjs 的 libDisplayName
  // 优先读 titles，读不到才退回去扩展名 —— 所以这里必须守住：
  //   ① 每首歌都有显示名（缺一首，列表里就会冒出一条带编号的"漏网之鱼"）；
  //   ② 显示名不得再以编号开头（映射写错就白改了）；
  //   ③ 显示名非空且不等于原文件名（否则等于没映射）。
  // 这是典型的"静默失效"：漏映射不抛异常，只是列表里混着编号，肉眼难查。
  const titles = manifest.titles;
  ck('manifest 有 titles 显示名映射', !!titles && typeof titles === 'object' && !Array.isArray(titles));
  if (titles && typeof titles === 'object') {
    const missing = manifest.songs.filter((s) => typeof titles[s] !== 'string' || !titles[s].trim());
    ck('每首歌都有非空显示名（漏映射=列表冒编号）',
      missing.length === 0, missing.length ? ` → 缺 ${missing.length} 首: ${missing.slice(0, 3).join(' | ')}` : '');
    const stillNum = manifest.songs.filter((s) => titles[s] && /^\s*\d+\s/.test(titles[s]));
    ck('显示名不以编号开头', stillNum.length === 0,
      stillNum.length ? ` → ${stillNum.slice(0, 3).map((s) => titles[s]).join(' | ')}` : '');
    const same = manifest.songs.filter((s) => titles[s] === s);
    ck('显示名已剥掉扩展名/编号（不等于原文件名）', same.length === 0,
      same.length ? ` → ${same.slice(0, 3).join(' | ')}` : '');
    const extra = Object.keys(titles).filter((k) => !manifest.songs.includes(k));
    ck('titles 无多余键（没有对不上的文件名）', extra.length === 0,
      extra.length ? ` → ${extra.slice(0, 3).join(' | ')}` : '');
  }
}

for (const f of files) {
  const buf = readFileSync(join(dir, f));
  let parsed = null, err = null;
  try {
    parsed = parseSMF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch (e) { err = e; }
  ck(`可解析 ${f}`, !err && !!parsed, err ? ' → ' + (err.message || err) : '');
  if (!parsed) continue;
  const notes = [];
  for (const tr of parsed.tracks) { if (tr.isPercussion) continue; for (const n of tr.notes) notes.push(n); }
  const inRange = notes.every((n) => n.midi >= 0 && n.midi <= 127);
  ck(`  音符 ${notes.length} 个 / 时长 ${(parsed.durationMs / 1000).toFixed(0)}s / 音高域内`,
    notes.length >= 16 && parsed.durationMs > 5000 && inRange && parsed.durationMs < 600000,
    ` [format${parsed.format}]`);
}

if (fails) { console.error(`[demo-songs] ${fails} 项失败`); process.exit(1); }
console.log('[demo-songs] 全部通过');
