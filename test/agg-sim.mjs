// 显示级聚合验证（anim/pitchTrail.mjs aggregateItems）：
//   1) 1s 内 50 帧(20ms 间隔) 440±抖动 → 按 250ms 桶聚合成 ~4-5 点；
//   2) 组内含离群点(如 3000Hz) 中位数仍近 440(抗单帧爆点)；
//   3) agg<=0 原样返回，不做任何改动。
import { aggregateItems } from '../anim/pitchTrail.mjs';

let bad = 0;
const check = (n, ok, d) => { console.log(`  ${ok ? '✓' : '✗'} ${n}  ${d || ''}`); if (!ok) bad++; };

console.log('显示级聚合（aggregateItems）\n');

// 1) 桶数量正确
{
  const items = [];
  for (let t = 0; t < 10000; t += 20) items.push({ t, f: 440 + (t % 7 === 0 ? 4000 : (t % 3) * 3 - 3) });
  const out = aggregateItems(items, 250);
  const slots = Math.ceil(10000 / 250);
  check('250ms 桶 → 点数≈槽数', out.length <= slots + 1 && out.length >= slots - 2, `in=${items.length} out=${out.length} (期望≈${slots})`);
  const out1 = aggregateItems(items, 1000);
  check('1000ms 桶 → ~10 点', out1.length <= 11, `out=${out1.length}`);
}

// 2) 中位数抗离群
{
  const items = [];
  for (let t = 0; t < 1000; t += 20) items.push({ t, f: t === 300 ? 3000 : 440 });   // 1 个 3000Hz 爆点
  const out = aggregateItems(items, 1000);
  check('桶内混入爆点 → 中位数仍≈440', out.length === 1 && Math.abs(out[0].f - 440) < 100, `f=${out[0].f.toFixed(0)}`);
}

// 3) agg<=0 原样
{
  const items = [{ t: 0, f: 440 }, { t: 20, f: 441 }];
  check('agg=0 原样返回', aggregateItems(items, 0) === items && aggregateItems(items, 0).length === 2, '');
}

if (bad) { console.log(`\n失败 ${bad} 项`); process.exit(1); }
console.log('\n完成。聚合逻辑符合预期。');