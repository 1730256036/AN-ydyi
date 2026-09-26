// ============================================================
// test/webm-duration.mjs —— WebM 时长补丁守卫（node 直跑，无浏览器）
// 背景：2026-09-15 录出的 .webm 播放器显示总时长 0:00、进度拖不动。
//      根因是 MediaRecorder 不写 Segment>Info>Duration（实时流不知道总长也不回头补），
//      文件本身完好（实测 1.13MB / 14 簇 / 10.2 秒内容全在）。
// 这里钉住补丁不能破的几条线：
//   ① Info 之前（EBML 头 + Segment 头 + 之前的子元素）逐字节不变
//   ② Info 之后（Tracks / Clusters…）逐字节不变 —— 只准在 Info 里动手
//   ③ Segment 原本"未知长度"，补完必须还是未知长度（不能凭空写个长度进去）
//   ④ Duration 值 = 传入毫秒（TimecodeScale=1e6 时单位就是 ms），且能被解析回来
//   ⑤ 重复补丁不再增长（已有 Duration 就地替换）
//   ⑥ Info 长度跨过 1 字节 VINT 上限(126) 时，长度字段要变成 2 字节且整体仍合法
//   ⑦ 不是 WebM 的输入必须原样返回，绝不把文件改坏
// 基准素材：Fixture A = 真实 Chrome 录制文件的头 201 字节（含真实 Info/Tracks 布局）。
// ============================================================
import { patchWebmDuration, readElement, readId, readSize, readTimecodeScale, encodeVint } from '../proj/webm-duration.mjs';

let fails = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[webm-duration] 时长补丁守卫');

const ID_EBML = 0x1a45dfa3, ID_SEG = 0x18538067, ID_INFO = 0x1549a966, ID_DUR = 0x4489;

// ---- 真实 Chrome 录制文件的头 201 字节（EBML + Segment + SeekHead + Info + Tracks + 首个 Cluster 头）----
const REAL_HEAD = '1a45dfa39f4286810142f7810142f2820442f381084282847765626d42878104428581021853806701ffffffffffffff1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d651654ae6beaaebdd7810173c587969920237222578381028686415f4f50555363a2934f707573486561640102000080bb0000000000e18db584473b80009f810262648120aea9d7810273c587a5befcf22cab2583810155ee81018685565f565039e08cb08206abba8202c053c081011f43b67501ffffffffffffff';
const hex2u8 = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const cat = (...parts) => {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const UNKNOWN8 = Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const uintBytes = (n) => {
  const a = [];
  while (n > 0) { a.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Uint8Array.from(a.length ? a : [0]);
};
// 独立的极简 EBML 构造器（刻意不复用被测模块的实现，避免"自己测自己"）
function el(idBytes, data) { return cat(Uint8Array.from(idBytes), encodeVint(data.length), data); }
function buildWebm({ timecodeScale = 1000000, infoFill = 0, trackLen = 8, clusterLen = 64 }) {
  const tc = el([0x2a, 0xd7, 0xb1], uintBytes(timecodeScale));
  const app = el([0x4d, 0x80], infoFill ? new Uint8Array(infoFill).fill(0x41) : ascii('Chrome'));
  const info = el([0x15, 0x49, 0xa9, 0x66], cat(tc, app));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], new Uint8Array(trackLen).fill(0x42));
  const cluster = cat(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]), UNKNOWN8, new Uint8Array(clusterLen).fill(0x43));
  const seg = cat(Uint8Array.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN8, info, tracks, cluster);
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(8).fill(0x44));
  return cat(ebml, seg);
}
const infoOf = (buf) => {
  const ebml = readElement(buf, 0);
  const seg = readElement(buf, ebml.dataEnd);
  const o = seg.dataStart;
  const e = readElement(buf, o);
  return { seg, info: e };
};
const durOf = (buf) => {
  const { info } = infoOf(buf);
  let o = info.dataStart;
  while (o < info.dataEnd) {
    const e = readElement(buf, o);
    if (!e) return null;
    if (e.id === ID_DUR) {
      const dv = new DataView(buf.buffer, buf.byteOffset + e.dataStart);
      return e.size === 8 ? dv.getFloat64(0, false) : (e.size === 4 ? dv.getFloat32(0, false) : NaN);
    }
    o = e.dataEnd;
  }
  return null;
};

// ---------- Fixture A：真实文件头 ----------
const A = cat(hex2u8(REAL_HEAD), new Uint8Array(400).fill(0x55));   // 后面 400 字节假装是簇数据
{
  const { seg, info } = infoOf(A);
  ck('真实头解析：Segment 是未知长度', seg.unknown === true);
  ck('真实头解析：Info 长度 25 字节', info.size === 25, 'size=' + info.size);
  ck('真实头解析：Info 里没有 Duration（这就是病根）', durOf(A) === null);
  ck('真实头解析：TimecodeScale = 1000000ns', readTimecodeScale(A) === 1000000);

  const patched = patchWebmDuration(A, 10200);
  ck('补丁净增 11 字节（Duration 元素：2 ID + 1 size + 8 float64）', patched.length === A.length + 11,
    A.length + ' → ' + patched.length);

  // ① Info 之前逐字节不变
  const headSame = A.subarray(0, info.start).every((v, i) => v === patched[i]);
  ck('Info 之前逐字节不变（EBML 头 / Segment 头 / SeekHead）', headSame);

  // ③ Segment 仍是未知长度
  const seg2 = readElement(patched, readElement(patched, 0).dataEnd);
  ck('Segment 补完仍是未知长度', seg2.unknown === true);

  // ② Info 之后逐字节不变
  const info2 = infoOf(patched).info;
  const tailA = A.subarray(info.dataEnd), tailB = patched.subarray(info2.dataEnd);
  ck('Info 之后逐字节不变（Tracks / Clusters）',
    tailA.length === tailB.length && tailA.every((v, i) => v === tailB[i]),
    'len ' + tailA.length + ' vs ' + tailB.length);

  // ④ Duration 值正确
  ck('Info 里补出了 Duration', durOf(patched) !== null);
  ck('Duration = 10200（TimecodeScale=1e6 时单位就是 ms）', durOf(patched) === 10200, 'got ' + durOf(patched));
  ck('Info 长度字段变成 36', info2.size === 36, 'size=' + info2.size);

  // ⑤ 幂等
  const twice = patchWebmDuration(patched, 10200);
  ck('重复补丁大小不变（就地替换，不会越长越大）', twice.length === patched.length, patched.length + ' → ' + twice.length);
  ck('重复补丁后 Info 里仍然只有一个 Duration', (() => {
    const { info: i3 } = infoOf(twice);
    let o = i3.dataStart, n = 0;
    while (o < i3.dataEnd) { const e = readElement(twice, o); if (!e) break; if (e.id === ID_DUR) n++; o = e.dataEnd; }
    return n === 1;
  })());
  ck('重复补丁后值仍正确', durOf(twice) === 10200);
}

// ---------- Fixture B：Info 长度跨过 1 字节 VINT 上限（126）----------
{
  const B = buildWebm({ infoFill: 112 });
  const { info } = infoOf(B);
  ck('B 前置：Info 内容 ≤126（1 字节长度字段）', info.size <= 126, 'size=' + info.size);
  const patched = patchWebmDuration(B, 5000);
  const info2 = infoOf(patched).info;
  ck('B：补完 Info 内容 >126，逼出 2 字节长度字段', info2.size === info.size + 11 && info2.size > 126, 'size=' + info2.size);
  ck('B：2 字节长度字段被正确编码（读回 == 内容长）', info2.sizeLen === 2, 'sizeLen=' + info2.sizeLen);
  ck('B：Duration 值正确', durOf(patched) === 5000, 'got ' + durOf(patched));
  const tailA = B.subarray(info.dataEnd), tailB = patched.subarray(info2.dataEnd);
  ck('B：Info 之后逐字节不变', tailA.length === tailB.length && tailA.every((v, i) => v === tailB[i]));
  ck('B：Info 之前逐字节不变', B.subarray(0, info.start).every((v, i) => v === patched[i]));
}

// ---------- Fixture C：非默认 TimecodeScale（Duration 单位跟着变）----------
{
  const C = buildWebm({ timecodeScale: 1000000000 });      // 1e9 ns = 1s 档
  ck('C 前置：TimecodeScale 读回 1e9', readTimecodeScale(C) === 1000000000);
  const patched = patchWebmDuration(C, 2000);              // 2000ms = 2s → 单位是秒 → 2
  ck('C：Duration 按 TimecodeScale 换算（2000ms → 2）', durOf(patched) === 2, 'got ' + durOf(patched));
}

// ---------- ⑦ 非 WebM 输入必须原样返回 ----------
{
  const junk = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const r = patchWebmDuration(junk, 1000);
  ck('非 WebM：返回同一份数据（不构造新文件、不改坏）', r === junk);
  const webmNoInfo = cat(el([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(8).fill(0x44)), Uint8Array.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN8, new Uint8Array(32).fill(0x42));
  ck('缺 Info 的 WebM：也原样返回', patchWebmDuration(webmNoInfo, 1000) === webmNoInfo);
  const truncated = A.subarray(0, 60);                     // 头被截断
  ck('截断文件：不抛异常', (() => { try { patchWebmDuration(truncated, 1000); return true; } catch (e) { return false; } })());
}

// ---------- 工具函数 ----------
{
  ck('encodeVint(25) = 0x99', encodeVint(25)[0] === 0x99);
  ck('encodeVint(126) 仍是 1 字节', encodeVint(126).length === 1);
  ck('encodeVint(127) 升到 2 字节（127 是全 1，保留给"未知长度"）', encodeVint(127).length === 2);
  ck('encodeVint(200) 2 字节且能读回', (() => { const b = encodeVint(200); return b.length === 2 && readSize(b, 0).val === 200; })());
  ck('readId 保留原始字节（EBML = 0x1a45dfa3，不是剥掉标记位的 0x0a45dfa3）',
    readId(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 0).val === ID_EBML);
  ck('readSize 去掉标记位（0x99 → 25）', readSize(Uint8Array.from([0x99]), 0).val === 25);
  ck('readSize 识别未知长度（01 ff…）', readSize(UNKNOWN8, 0).unknown === true);
}

if (fails) { console.error(`[webm-duration] ${fails} 项失败`); process.exit(1); }
console.log('[webm-duration] 全部通过');
