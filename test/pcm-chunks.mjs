// ============================================================
// test/pcm-chunks.mjs —— 分块 PCM 缓冲守卫（node 直跑，无浏览器）
// 背景：2026-09-15 体检发现录音累积缓冲 recPcm 是"单个几何倍增 Float32Array"，
// 扩容时新旧两块同时存在 → 峰值 ≈ 2× 数据量（30 分钟录音约 950MB），有崩标签页的风险。
// 改为分块后必须保证两件事：
//   ①【数据等价】分块写入/读出，与"写进一个连续缓冲"逐样本完全一致
//      （块边界算错 = 音频出现爆音/丢样/错位，而且只在长录音的块交界处偶发，极难查）
//   ②【块不放大】任何单块长度都 ≤ CHUNK_SAMPLES —— 防"哪天又退回单个大缓冲"的守卫
// ============================================================
import { appendChunked, copyChunked, CHUNK_SAMPLES, allocatedSamples } from '../proj/pcm-chunks.mjs';

let fails = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[pcm-chunks] 分块 PCM 守卫');

// 确定性伪随机（失败可复现）
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const seg = (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = (rnd() * 2 - 1) * (i + 1); return a; };

// 参考实现：一个足够大的连续缓冲，等价于"没改之前的行为"
function refRun(segs) {
  const total = segs.reduce((s, x) => s + x.length, 0);
  const buf = new Float32Array(total);
  let len = 0;
  const indices = [];                       // 每段结束后的 len，用于分段比对
  for (const s of segs) { buf.set(s, len); len += s.length; indices.push(len); }
  return { buf, total, indices };
}
function chunkRun(segs) {
  const chunks = [];
  let len = 0;
  const indices = [];
  for (const s of segs) { len = appendChunked(chunks, len, s); indices.push(len); }
  return { chunks, len, indices };
}
const same = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return -1; };

// ---------- ① 边界尺寸：块刚好、差一、跨块 ----------
const C = CHUNK_SAMPLES;
const BOUNDARY = [
  { name: 'CHUNK-1（差一满块）', sizes: [C - 1] },
  { name: 'CHUNK（正好一块）', sizes: [C] },
  { name: 'CHUNK+1（溢出一）', sizes: [C + 1] },
  { name: '1 个样本', sizes: [1] },
  { name: '2 个样本', sizes: [2] },
  { name: 'CHUNK-1 + 2（第二段跨块）', sizes: [C - 1, 2] },
  { name: 'CHUNK + 1（尾段开新块）', sizes: [C, 1] },
  { name: '1 + CHUNK（首段极短后接满块）', sizes: [1, C] },
  { name: '2*CHUNK+7', sizes: [C * 2 + 7] },
  { name: '真实窗长混合 4096/1024/1/CHUNK/3', sizes: [4096, 1024, 4096 - 1024, 1, C, 3] },
];
for (const { name, sizes } of BOUNDARY) {
  const segs = sizes.map(seg);
  const R = refRun(segs), K = chunkRun(segs);
  const out = new Float32Array(R.total);
  const got = copyChunked(K.chunks, K.len, out);
  const bad = same(R.buf, out, R.total);
  ck(`尺寸 ${name} 逐样本一致`,
    got === R.total && bad === -1, bad === -1 ? `copyChunked 返回 ${got} / 期望 ${R.total}` : `第 ${bad} 个样本不符`);
  ck(`  分段长度一致`, K.indices.every((v, i) => v === R.indices[i]), JSON.stringify(K.indices) + ' vs ' + JSON.stringify(R.indices));
}

// ---------- ② 空输入 / 零长段 ----------
{
  const chunks = [];
  ck('appendChunked 空数组不写、len 不变', appendChunked(chunks, 0, new Float32Array(0)) === 0 && chunks.length === 0);
  ck('appendChunked 传 null 不抛', appendChunked(chunks, 0, null) === 0);
  ck('copyChunked 空缓冲返回 0', copyChunked([], 0, new Float32Array(8)) === 0);
  ck('copyChunked len=0 返回 0', copyChunked([new Float32Array(4)], 0, new Float32Array(8)) === 0);
}

// ---------- ③ 读出不得把"块尾未填的 0"带出来 ----------
{
  const segs = [seg(CHUNK_SAMPLES + 100)];          // 第二块只填 100
  const C = chunkRun(segs);
  const out = new Float32Array(C.len);
  const got = copyChunked(C.chunks, C.len, out);
  ck('部分填满的尾块：只拷 len 个（不带出块尾空位）', got === C.len);
  ck('尾块空位未污染输出（nonzero 计数一致）',
    out.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0) === segs[0].reduce((n, v) => n + (v !== 0 ? 1 : 0), 0));
}

// ---------- ④ dst 过短：只拷放得下的，返回实际数 ----------
{
  const segs = [seg(CHUNK_SAMPLES + 500)];
  const C = chunkRun(segs);
  const small = new Float32Array(1000);
  ck('dst 过短：返回实际拷贝数且不抛', copyChunked(C.chunks, C.len, small) === 1000);
  const R = refRun(segs);
  ck('dst 过短：内容与前 1000 个样本一致', same(R.buf, small, 1000) === -1);
}

// ---------- ⑤ 不放大：任何单块长度恒 == CHUNK_SAMPLES ----------
{
  const chunks = [];
  let len = 0;
  for (let i = 0; i < 400; i++) len = appendChunked(chunks, len, seg(1024));   // 模拟逐窗写入
  ck('长写入后：所有块长度恒 == CHUNK_SAMPLES（不存在超大块）',
    chunks.every((c) => c.length === CHUNK_SAMPLES), '最大块=' + Math.max(...chunks.map((c) => c.length)));
  ck('长写入后：块数 = ceil(len/CHUNK)', chunks.length === Math.ceil(len / CHUNK_SAMPLES), chunks.length + ' vs ' + Math.ceil(len / CHUNK_SAMPLES));
  const waste = allocatedSamples(chunks) - len;
  ck('长写入后：浪费 < 1 块（分配 = len 向上取整到块）', waste >= 0 && waste < CHUNK_SAMPLES, 'waste=' + waste);
}

// ---------- ⑥ 模拟一段真实长度的录音：逐窗写入 + 逐段读出 ----------
// 60 秒 @44.1k、窗长 1024（与实时 hop 同量级）。这段同时验证"边写边读"不互相踩。
{
  const SR = 44100, WIN = 1024, SECS = 60;
  const chunks = [];
  let len = 0;
  const ref = new Float32Array(SR * SECS);
  let wrote = 0;
  while (wrote < ref.length) {
    const n = Math.min(WIN, ref.length - wrote);
    const s = seg(n);
    ref.set(s, wrote);
    len = appendChunked(chunks, len, s);
    wrote += n;
  }
  ck('60 秒逐窗写入：len == 样本总数', len === ref.length, len + ' vs ' + ref.length);
  const out = new Float32Array(len);
  copyChunked(chunks, len, out);
  ck('60 秒逐窗写入：整体逐样本一致', same(ref, out, ref.length) === -1);
  ck('60 秒逐窗写入：单块长度未超 CHUNK（峰值 = 数据量 + 1 块）',
    chunks.every((c) => c.length === CHUNK_SAMPLES));
  const MiB = (n) => (n * 4 / 1048576).toFixed(1);
  console.log(`       （数据 ${MiB(len)}MiB；分块额外占用 < ${MiB(CHUNK_SAMPLES)}MiB；` +
    `旧实现此刻扩容峰值会到 ~${MiB(len * 2)}MiB）`);
}

// ---------- ⑦ 读出的内容必须是"前 len 个"，不受块内残留影响 ----------
{
  const chunks = [];
  let len = appendChunked(chunks, 0, seg(CHUNK_SAMPLES + 10));
  const first = new Float32Array(len);
  copyChunked(chunks, len, first);
  // 再往后写一段，然后仍只读前 len 个 → 必须与之前完全一致
  appendChunked(chunks, len, seg(5000));
  const again = new Float32Array(len);
  copyChunked(chunks, len, again);
  ck('续写后仍只读前 len 个：内容不变', same(first, again, len) === -1);
}

ck('CHUNK_SAMPLES 是 2 的幂且够大(≥4096)',
  (CHUNK_SAMPLES & (CHUNK_SAMPLES - 1)) === 0 && CHUNK_SAMPLES >= 4096);

if (fails) { console.error(`[pcm-chunks] ${fails} 项失败`); process.exit(1); }
console.log('[pcm-chunks] 全部通过');
