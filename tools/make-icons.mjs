#!/usr/bin/env node
// ============================================================
// tools/make-icons.mjs —— 生成 PWA 应用图标（零依赖，只用 node:zlib）
// 为什么自己写 PNG 编码器：项目一贯零构建、零依赖（见 package.json），
// 为了三个图标引入 sharp/canvas 之类原生依赖不划算；PNG 的
// 签名+IHDR+IDAT+IEND 结构固定，配合 zlib.deflateSync 几十行就够。
//
// 图形：深炭底(#0e1116) + 一条上扬的冷青色音高折线 + 末端圆点（品牌标记同色 #7dd3fc）。
// 全部图形压在中心 72% 内 —— 满足 Android maskable 安全区（直径 80% 的圆），
// 故 manifest 里可以一个图标同时声明 "any maskable"，被裁成圆形也不会切到图形。
// 抗锯齿：4 倍超采样后盒式降采样（纯 CPU，4 倍面积对 512px 仍是一次性毫秒级）。
//
// 用法：node tools/make-icons.mjs   （重跑即覆盖，产物入库）
// ============================================================
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const BG = [0x0e, 0x11, 0x16];      // --bg
const CYAN = [0x7d, 0xd3, 0xfc];    // --accent
const SS = 4;                        // 超采样倍数

// 音高折线（归一化坐标，已压在安全区内）
const PTS = [
  [0.18, 0.600], [0.28, 0.515], [0.37, 0.560], [0.46, 0.450],
  [0.55, 0.485], [0.64, 0.385], [0.73, 0.430], [0.81, 0.350],
];
const LW = 0.052;                    // 线宽（归一化，相对边长）
const DOT = { x: 0.81, y: 0.350, r: 0.050 };

// ---------- PNG 编码 ----------
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;   // 过滤类型 0(none)，图形简单，压缩率已够
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type 6 = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
function disc(acc, S, cx, cy, r, col) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(S - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(S - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
    const o = (y * S + x) * 4;
    acc[o] = col[0]; acc[o + 1] = col[1]; acc[o + 2] = col[2]; acc[o + 3] = 255;
  }
}
function glyph(acc, S) {
  const hw = (LW / 2) * S;
  for (let k = 0; k + 1 < PTS.length; k++) {
    const x1 = PTS[k][0] * S, y1 = PTS[k][1] * S;
    const x2 = PTS[k + 1][0] * S, y2 = PTS[k + 1][1] * S;
    const X0 = Math.max(0, Math.floor(Math.min(x1, x2) - hw - 1)), X1 = Math.min(S - 1, Math.ceil(Math.max(x1, x2) + hw + 1));
    const Y0 = Math.max(0, Math.floor(Math.min(y1, y2) - hw - 1)), Y1 = Math.min(S - 1, Math.ceil(Math.max(y1, y2) + hw + 1));
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      if (distSeg(x + 0.5, y + 0.5, x1, y1, x2, y2) > hw) continue;
      const o = (y * S + x) * 4;
      acc[o] = CYAN[0]; acc[o + 1] = CYAN[1]; acc[o + 2] = CYAN[2]; acc[o + 3] = 255;
    }
  }
  // 圆头：每个顶点补一个半径=半线宽的圆盘，折点处才不会出尖角
  for (const [px, py] of PTS) disc(acc, S, px * S, py * S, hw, CYAN);
  // 末端圆点 = 当前音高标记（品牌小圆点同形）
  disc(acc, S, DOT.x * S, DOT.y * S, DOT.r * S, CYAN);
}
function render(size) {
  const S = size * SS;
  const acc = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    acc[i * 4] = BG[0]; acc[i * 4 + 1] = BG[1]; acc[i * 4 + 2] = BG[2]; acc[i * 4 + 3] = 255;
  }
  glyph(acc, S);
  const out = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
      const o = ((y * SS + dy) * S + (x * SS + dx)) * 4;
      r += acc[o]; g += acc[o + 1]; b += acc[o + 2]; a += acc[o + 3];
    }
    const o2 = (y * size + x) * 4;
    out[o2] = Math.round(r / n); out[o2 + 1] = Math.round(g / n);
    out[o2 + 2] = Math.round(b / n); out[o2 + 3] = Math.round(a / n);
  }
  return out;
}

const TARGETS = [
  ['icon-512.png', 512],   // manifest
  ['icon-192.png', 192],   // manifest
  ['icon-180.png', 180],   // apple-touch-icon（iOS 不支持 SVG 图标，必须 PNG）
];
for (const [name, size] of TARGETS) {
  const png = encodePng(size, size, render(size));
  writeFileSync(ROOT + name, png);
  console.log(`  ${name.padEnd(14)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log('图标已生成（如需改图形，改本文件顶部的 PTS/LW/DOT 后重跑）。');
