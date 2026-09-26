// ============================================================
// test/piano-blocks-seg.mjs —— 钢琴块音符分段离线单测
// 只测 segmentPoints 纯逻辑(不发信号不起服务)。
// 分段器：吸附→run→包络谷切分→过滤→同音合并。
//   1. 稳定长音 → 单音符
//   2. 小幅颤音(±0.4 半音，不跨半音边界) → 仍 1 块
//   3. 滑音逐半音(各 200ms) → 5 块阶梯
//   4. 滑音中间音 60ms → 保留成阶梯块(转音可见)
//   5. 快速装饰音回原音 → 3 块(装饰音独立成块)
//   6. 静音间隙 >GAP_MS → 断成两块
//   7. 同音高近邻(<MERGE_GAP_MS)合并
//   8. <MIN_NOTE_MS 的碎点丢弃
//   9. 出块算法两档互证：颗粒(默认) vs 经典
// ============================================================
import { segmentPoints, setBlockAlgo } from '../anim/pianoBlocks.mjs';

const fOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.error(`✗ ${name}\n  got ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
}

// 1. 稳定长音 1s
{
  const pts = [];
  for (let t = 0; t <= 1000; t += 23) pts.push({ t, f: fOf(69) });
  const n = segmentPoints(pts);
  eq('长音=1块', n.length, 1);
  eq('长音 midi', n[0].midi, 69);
  eq('长音 t0', n[0].t0, 0);
  eq('长音 t1', n[0].t1, 989);
}

// 2. 颤音 ±0.4 半音 5Hz，1s → 仍 1 块(不跨边界天然一块)
{
  const pts = [];
  for (let t = 0; t <= 1000; t += 10)
    pts.push({ t, f: fOf(69 + 0.4 * Math.sin(2 * Math.PI * 5 * t / 1000)) });
  const n = segmentPoints(pts);
  eq('颤音不碎块(1块)', n.length, 1);
  eq('颤音 midi 不漂移', n[0].midi, 69);
}

// 3. 滑音 C4→E4 每 200ms 升半音 → 5 块阶梯
{
  const pts = [];
  for (let step = 0; step < 5; step++)
    for (let t = step * 200; t < (step + 1) * 200; t += 23) pts.push({ t, f: fOf(60 + step) });
  const n = segmentPoints(pts);
  eq('滑音块数=5', n.length, 5);
  eq('滑音 midi 序列', n.map(x => x.midi), [60, 61, 62, 63, 64]);
}

// 4. 滑音中间音 60ms(C4→C#4 60ms→D4) → 中间音保留为阶梯块 ★转音可见
{
  const pts = [];
  for (let t = 0; t <= 300; t += 23) pts.push({ t, f: fOf(60) });
  for (let t = 323; t <= 380; t += 23) pts.push({ t, f: fOf(61) });
  for (let t = 403; t <= 700; t += 23) pts.push({ t, f: fOf(62) });
  const n = segmentPoints(pts);
  eq('滑音中间音=3块', n.length, 3);
  eq('滑音中间音序列', n.map(x => x.midi), [60, 61, 62]);
}

// 5. 快速装饰音回原音(69→72 50ms→69) → 3 块，装饰音独立 ★v2 新行为
{
  const pts = [];
  for (let t = 0; t <= 300; t += 23) pts.push({ t, f: fOf(69) });
  for (let t = 323; t <= 371; t += 23) pts.push({ t, f: fOf(72) });
  for (let t = 394; t <= 700; t += 23) pts.push({ t, f: fOf(69) });
  const n = segmentPoints(pts);
  eq('装饰音=3块', n.length, 3);
  eq('装饰音序列', n.map(x => x.midi), [69, 72, 69]);
}

// 6. 交替短块(69/70 各 1 半音)：已无任何自动折叠 → 每个音各自成 5 块
{
  const pts = [];
  let t = 0;
  const seq = [[69, 150], [70, 80], [69, 150], [70, 80], [69, 150]];
  for (const [m, dur] of seq)
    for (let k = 0; k < dur; k += 23) { pts.push({ t, f: fOf(m) }); t += 23; }
  eq('交替短块保持独立5块', segmentPoints(pts).length, 5);
  // setBlockAlgo：未知档位回退颗粒；切回颗粒后行为不变
  setBlockAlgo('nonsense');
  eq('setBlockAlgo(未知值)回退颗粒档=独立5块', segmentPoints(pts).length, 5);
  setBlockAlgo('grain');
  eq('切回颗粒档=独立5块', segmentPoints(pts).length, 5);
}

// 7. 静音 300ms 间隙 → 2 块
{
  const pts = [];
  for (let t = 0; t <= 500; t += 23) pts.push({ t, f: fOf(69) });
  for (let t = 801; t <= 1300; t += 23) pts.push({ t, f: fOf(69) });
  const n = segmentPoints(pts);
  eq('间隙断成2块', n.length, 2);
  eq('第二块起点', n[1].t0, 801);
}

// 8. 同音高间隔 60ms(<MERGE_GAP_MS) → 合并 1 块
{
  const pts = [];
  for (let t = 0; t <= 300; t += 23) pts.push({ t, f: fOf(69) });
  for (let t = 360; t <= 700; t += 23) pts.push({ t, f: fOf(69) });
  const n = segmentPoints(pts);
  eq('同音近邻合并', n.length, 1);
  eq('合并后 t1', n[0].t1, 682);
}

// 9. 开头 23ms 碎点丢弃，不产生短块
{
  const pts = [{ t: 0, f: fOf(69) }, { t: 23, f: fOf(69) }];
  for (let t = 1000; t <= 1200; t += 23) pts.push({ t, f: fOf(72) });
  const n = segmentPoints(pts);
  eq('碎点丢弃后 1 块', n.length, 1);
  eq('碎点丢弃后 midi', n[0].midi, 72);
  eq('碎点丢弃后 t0', n[0].t0, 1000);
}

// 10. 单帧级音高跳变(1帧噪声)夹在长音中间 → 丢弃并合并回 1 块
{
  const pts = [];
  for (let t = 0; t <= 300; t += 23) pts.push({ t, f: fOf(69) });
  pts.push({ t: 323, f: fOf(75) });
  for (let t = 346; t <= 700; t += 23) pts.push({ t, f: fOf(69) });
  const n = segmentPoints(pts);
  eq('单帧噪声丢弃', n.length, 1);
  eq('噪声丢弃后 midi', n[0].midi, 69);
}

// 11. ★v3 快吐：同音间 rms 深谷(谷深≥6dB) → 切成 2 块
{
  const pts = [];
  for (let t = 0; t <= 290; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  for (let t = 300; t <= 322; t += 11) pts.push({ t, f: fOf(69), rms: 0.03, prom: 4, purity: 0.4 });   // 吐音气口
  for (let t = 345; t <= 700; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  const n = segmentPoints(pts);
  eq('快吐深谷切分=2块', n.length, 2);
  eq('快吐两块同音', n.every(x => x.midi === 69), true);
  eq('快吐第一块在气口前结束', n[0].t1 <= 300, true);
}

// 12. ★v3 长音包络平稳(rms 无深谷) → 不误切，仍 1 块
{
  const pts = [];
  for (let t = 0; t <= 700; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  const n = segmentPoints(pts);
  eq('平稳长音不误切', n.length, 1);
}

// 13a. 低可信短错块(A-B-A，B 质量差)：已无质量折叠档 → 恒保持独立 3 块
{
  const hi = { rms: 0.10, prom: 15, purity: 0.9 };
  const lo = { rms: 0.02, prom: 3, purity: 0.3 };
  const pts = [];
  for (let t = 0; t <= 300; t += 23) pts.push({ t, f: fOf(69), ...hi });
  for (let t = 323; t <= 400; t += 23) pts.push({ t, f: fOf(72), ...lo });
  for (let t = 423; t <= 700; t += 23) pts.push({ t, f: fOf(69), ...hi });
  const n = segmentPoints(pts);
  eq('低可信错块保持独立3块', n.length, 3);
  eq('错块音高不被吞', n.map(x => x.midi).join(','), '69,72,69');
}

// 13b. ★v3 高可信短装饰音(A-B-A，B 质量好) → 保留 3 块(装饰音不误杀)
{
  const pts = [];
  for (let t = 0; t <= 300; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  for (let t = 323; t <= 400; t += 23) pts.push({ t, f: fOf(72), rms: 0.10, prom: 15, purity: 0.9 });
  for (let t = 423; t <= 700; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  const n = segmentPoints(pts);
  eq('高可信装饰音=3块', n.length, 3);
}

// 14. ★v3 吸附滞回：边界附近(69.45/69.55)高频抖动 → 滞回锁格，1 块
{
  const pts = [];
  let t = 0, i = 0;
  while (t < 600) { pts.push({ t, f: fOf(i++ % 2 ? 69.45 : 69.55) }); t += 23; }
  const n = segmentPoints(pts);
  eq('滞回锁格=1块', n.length, 1);
}

// 15. ★v3.1 包络气口切分：桥接帧把两个同音气口焊死(数据上无间隙)，
//     但细粒度包络有深谷 → 强制切成 2 块
{
  const pts = [];
  for (let t = 0; t <= 500; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  for (let t = 523; t <= 560; t += 23) pts.push({ t, f: fOf(69), rms: 0.02, prom: 3, purity: 0.4 });  // 气口(桥接帧)
  for (let t = 583; t <= 1000; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  const env = [];
  for (let t = 0; t <= 1050; t += 5) {
    const inGap = t >= 510 && t <= 570;
    env.push({ t, rms: inGap ? 0.02 : 0.10 });
  }
  const n = segmentPoints(pts, env);
  eq('包络气口切分=2块', n.length, 2);
  eq('切分第一块止于气口前', n[0].t1 <= 523, true);
}

// 16. ★v3.1 无包络(旧输入)时桥接帧焊死 → 维持 1 块(向后兼容确认)
{
  const pts = [];
  for (let t = 0; t <= 500; t += 23) pts.push({ t, f: fOf(69) });
  for (let t = 523; t <= 560; t += 23) pts.push({ t, f: fOf(69) });
  for (let t = 583; t <= 1000; t += 23) pts.push({ t, f: fOf(69) });
  const n = segmentPoints(pts);
  eq('无包络时维持旧行为=1块', n.length, 1);
}

// 17. ★v3.1 包络无深谷(平稳长音) → 不误切
{
  const pts = [];
  for (let t = 0; t <= 1000; t += 23) pts.push({ t, f: fOf(69), rms: 0.10, prom: 15, purity: 0.9 });
  const env = [];
  for (let t = 0; t <= 1050; t += 5) env.push({ t, rms: 0.10 });
  const n = segmentPoints(pts, env);
  eq('包络无谷不误切', n.length, 1);
}

// 18. ★v4 半音内较大抖动(±0.6 半音，超旧滞回 0.55 边界) → 段内投票吸收，仍 1 块
//     （逐帧吸附下这批点会碎成 C4/C#4 交替的 4~6 块）
{
  const pts = [];
  const seq = [69.58, 69.05, 69.62, 68.95, 69.48, 68.88, 69.55, 69.12, 68.62, 69.42, 68.98, 69.40];
  for (const f of seq) pts.push({ t: pts.length * 23, f: fOf(f) });
  const n = segmentPoints(pts);
  eq('大抖动≠碎块(1块)', n.length, 1);
  eq('大抖动音高=69', n[0].midi, 69);
}

// 19. ★v4 长音中单帧 +1.5 半音离群 → 2 帧确认门槛吸收，1 块
//     （逐帧吸附：单帧超过滞回换格 → 产生一个 ≈46ms 的碎块）
{
  const pts = [];
  for (let t = 0; t <= 300; t += 23) pts.push({ t, f: fOf(69) });
  pts.push({ t: 323, f: fOf(70.5) });
  for (let t = 346; t <= 700; t += 23) pts.push({ t, f: fOf(69) });
  const n = segmentPoints(pts);
  eq('单帧离群吸收=1块', n.length, 1);
  eq('离群吸收后 midi=69', n[0].midi, 69);
}

// 20. ★v4 legato 换音：无静音无包络谷，音高持续阶跃后稳定 → 按持续偏离切成 2 块
{
  const pts = [];
  for (let t = 0; t <= 500; t += 23) pts.push({ t, f: fOf(69) });
  for (let t = 523; t <= 1000; t += 23) pts.push({ t, f: fOf(72) });
  const n = segmentPoints(pts);
  eq('legato 换音=2块', n.length, 2);
  eq('legato 两音高', n.map(x => x.midi).join(','), '69,72');
}

// 21. 出块算法两档互证(2026-09-19 由四档收敛)：每档用例结束都显式回 'grain'，防止档位串味
// 21a. 经典档=纯音高：包络深谷不切(快吐同音连一块)，变音仍切
{
  const pts = [];
  for (let t = 0; t <= 300; t += 10) {
    let rms = 1.0;
    if (t === 100 || t === 160) rms = 0.3;   // 两个深谷(10.5dB)：颗粒档该切，经典档不该切
    pts.push({ t, f: fOf(69), rms });
  }
  setBlockAlgo('grain');
  eq('颗粒档：双谷切3块', segmentPoints(pts).length, 3);
  setBlockAlgo('classic');
  eq('经典档：包络谷不切=1块', segmentPoints(pts).length, 1);
  const legato = [];
  for (let t = 0; t <= 500; t += 23) legato.push({ t, f: fOf(69) });
  for (let t = 523; t <= 1000; t += 23) legato.push({ t, f: fOf(72) });
  eq('经典档：变音仍切2块', segmentPoints(legato).length, 2);
  setBlockAlgo('grain');   // 还原默认档
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
