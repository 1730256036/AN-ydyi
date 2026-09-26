// test/log-smoke.mjs —— 日志系统离线冒烟（node 直跑，无浏览器环境）
// 验证：分级写入 / data 安全序列化 / 环形缓冲 / 过滤 / 导出文本与 JSON / IndexedDB 缺失时降级
import { log } from '../log.mjs';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

console.log('== 日志冒烟 ==');

// 1. 基本写入与读取
log.debug('t1', 'debug 消息', { k: 1 });
log.info('t1', 'info 消息');
log.warn('t1', 'warn 消息');
log.error('t1', 'error 消息', new Error('炸了'));
const mem = log.entries();
ok(mem.length >= 4, '写入 4 条可读回（实际 ' + mem.length + '）');
ok(mem.every(e => e.session === log.sessionId), '所有条目带会话 ID');
ok(mem[0].seq < mem[mem.length - 1].seq, 'seq 递增');

// 2. data 安全序列化：循环引用不能炸
const cyc = {}; cyc.self = cyc;
log.info('t2', '循环引用', cyc);
log.info('t2', '大数组', { frames: new Array(50000).fill(0) });
ok(log.entries().at(-1).data.frames.includes('[省略'), '大数组字段被省略保护');

// 3. 过滤
const errs = log.entries({ level: 'ERROR' });
ok(errs.length >= 1 && errs.every(e => e.level === 'ERROR'), '按级别过滤');
const cats = log.entries({ cat: 't2' });
ok(cats.length >= 2 && cats.every(e => e.cat === 't2'), '按分类过滤');

// 4. entries 返回副本
mem.push('垃圾');
ok(!log.entries().includes('垃圾'), 'entries 返回副本，外部改不坏内部');

// 5. 导出文本：含头部摘要 + 正文
const txt = await log.exportText();
ok(txt.startsWith('# 调试日志'), '导出文本带头部');
ok(txt.includes('警告与错误'), '导出文本含错误摘要段');
ok(txt.includes('error 消息'), '导出文本含正文');
ok(txt.includes('=== 会话 ' + log.sessionId + ' ==='), '导出文本含会话分隔');

// 6. 导出 JSON 可解析
const js = JSON.parse(await log.exportJSON());
ok(js.format === 'ydyi-log' && Array.isArray(js.entries) && js.entries.length >= mem.length - 1, '导出 JSON 结构完整');

// 7. 环形缓冲上限（写入 3200 条，内存应截到 MEM_MAX=3000）
for (let i = 0; i < 3200; i++) log.debug('ring', '填充 ' + i);
ok(log.entries().length <= 3000, '内存环形缓冲截断（实际 ' + log.entries().length + '）');

// 8. 级别开关：WARN 以上时 DEBUG/INFO 不再入缓冲
// （缓冲此时已满 3000，长度不变是正常的，按分类过滤验证谁被收进来了）
log.setLevel('WARN');
log.debug('t3', '不应记录');
log.info('t3', '不应记录');
log.warn('t3', '应记录');
const t3 = log.entries({ cat: 't3' });
ok(t3.length === 1 && t3[0].level === 'WARN', '级别过滤生效（WARN 档只收 warn 那条）');
log.setLevel('DEBUG');

// 9. 清空
await log.clear();
ok(log.entries().length === 0, '清空后内存为空');

// 注：node 环境无 indexedDB，全程走内存降级路径 —— 这本身就是第 10 项验证
console.log('（node 无 indexedDB：上述全部走内存降级路径，未崩溃 = 降级 OK）');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
