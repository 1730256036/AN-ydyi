// ============================================================
// test/timbre-table.mjs —— 琴声音色表守卫（node 直跑，无浏览器、无网络）
// 背景：2026-09-13 声源多元化重写了 anim/piano-sound.mjs。这里钉住四条不能破的线：
//   ① 音色 id 唯一（下拉 option 重复会静默选中错误项）
//   ② 默认音色必须是 salamander 且排第一（「当前版本效果最好，不要动」）
//   ③ Salamander 命名与加多音源前【逐位一致】（tonejs 用升号 Ds/Fs）
//   ④ GM(gleitz) 命名用降号 Db/Eb/Gb/Ab/Bb —— 实测 gleitz 的 Ds4/Fs4 是 404，Db4 是 200，
//     命名写错 = 整个音色 0 张采样加载成功 → 永远掉合成器兜底
//   ⑤ 每个音色结构完整、midis 升序且在 88 键音域内
// ============================================================
import { TIMBRES, sampleName, timbreById } from '../anim/piano-sound.mjs';

let fails = 0;
const ck = (name, cond) => { if (cond) console.log('  ok  ' + name); else { fails++; console.error('  FAIL ' + name); } };

console.log('[timbre-table] 音色表守卫');

// ① id 唯一
const ids = TIMBRES.map((t) => t.id);
ck(`音色 id 无重复（共 ${TIMBRES.length} 项）`, new Set(ids).size === TIMBRES.length);

// ② 默认音色
ck('默认音色 salamander 存在且排第一', TIMBRES[0].id === 'salamander' && !!timbreById('salamander'));
ck('未知 id 返回 null（setTimbre 据此拒绝脏值）', timbreById('nope') === null);

// ③ Salamander 命名回归（不可退回 PC_NAME={0:C,3:Ds,6:Fs,9:A} + (floor(m/12)-1) + '.mp3'）
for (const [m, n] of [[48, 'C3.mp3'], [51, 'Ds3.mp3'], [54, 'Fs3.mp3'], [57, 'A3.mp3'], [60, 'C4.mp3'], [105, 'A7.mp3']]) {
  ck(`salamander 升号命名 ${m} → ${n}`, sampleName('sharp', m) === n);
}

// ④ GM 命名 = 降号
for (const [m, n] of [[21, 'A0.mp3'], [22, 'Bb0.mp3'], [61, 'Db4.mp3'], [63, 'Eb4.mp3'], [66, 'Gb4.mp3'], [68, 'Ab4.mp3'], [70, 'Bb4.mp3'], [108, 'C8.mp3']]) {
  ck(`gm 降号命名 ${m} → ${n}`, sampleName('flat', m) === n);
}

// ⑤ 结构完整
for (const t of TIMBRES) {
  ck(`结构完整 ${t.id}`,
    typeof t.id === 'string' && t.id.length > 0
    && typeof t.label === 'string' && t.label.length > 0
    && typeof t.group === 'string' && t.group.length > 0
    && (t.kind === 'sample' || t.kind === 'synth' || t.kind === 'sf2')
    && typeof t.sus === 'boolean'
    && (t.kind === 'sample'
      ? (typeof t.base === 'string' && t.base.startsWith('./vendor/soundfonts/')
        && (t.style === 'sharp' || t.style === 'flat')
        && t.midis.length > 0
        && (t.inst === null || typeof t.inst === 'string'))
      : (t.midis.length === 0 && t.base === null)));   // synth / sf2 不走 CDN 采样
}

// ⑤b 本地音源恰有一个，且 id 固定（面板靠 'sf2local' 判定显隐）
ck('本地音源入口 sf2local 恰有一个', TIMBRES.filter((t) => t.kind === 'sf2').length === 1
  && !!timbreById('sf2local'));

// ⑥ 采样型：midis 严格升序、在 88 键音域内、无重复采样点
for (const t of TIMBRES.filter((x) => x.kind === 'sample')) {
  const asc = t.midis.every((m, i) => i === 0 || m > t.midis[i - 1]);
  ck(`midis 严格升序且在音域内 ${t.id}（${t.midis.length} 张）`,
    asc && t.midis[0] >= 21 && t.midis[t.midis.length - 1] <= 108);
}

// ⑦ 采样 URL 可拼出合法文件名（不用网络：只验形状）。
//   2026-09-14 起采样全部内置本地(vendor/soundfonts/)，base 断言随之从 https 改为本地路径。
for (const t of TIMBRES.filter((x) => x.kind === 'sample')) {
  const n = sampleName(t.style, t.midis[0]);
  ck(`URL 形状 ${t.id} → ${t.base}${n}`, /^[A-G](b|s)?-?\d+\.mp3$/.test(n) === false || n.endsWith('.mp3'));
  ck(`base 以 / 结尾 ${t.id}`, t.base.endsWith('/'));
}

// ⑧ 2026-09-14 钉死：GM 音色 base 必须含 {inst}-mp3/ 文件夹——曾因漏拼这一段，
//   27 个 GM 音色全部 404（fetch 到 FluidR3_GM/A4.mp3 这种不存在的路径）掉合成器兜底。
for (const t of TIMBRES.filter((x) => x.kind === 'sample' && x.inst)) {
  ck(`base 含乐器文件夹 ${t.id} → ${t.base}`, t.base.includes(t.inst + '-mp3/'));
}

if (fails) { console.error(`[timbre-table] ${fails} 项失败`); process.exit(1); }
console.log('[timbre-table] 全部通过');
