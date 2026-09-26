// ============================================================
// test/kb-preview.mjs —— 钢琴键帽离线外观预览（node 直跑，不开浏览器、不起服务）
//
// 为什么有它：键帽的"真实感"只能靠眼睛判断，需要有能离线出图复核的手段。
// 于是把 anim/pianoBlocks.mjs 的 PBR 着色逐像素跑在打桩画布上，直接产出 PNG 供人工审查
// —— 这属于"离线脚本"，不是浏览器自测。
//
// 用法：node test/kb-preview.mjs [输出目录]
// 产物：<输出目录>/kb-pbr.png（默认 logs/）
// ============================================================
import zlib from 'node:zlib';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';

// ---------- 只能装 createImageData/putImageData/getImageData 的真像素画布 ----------
class FakeCanvas {
  constructor() { this._w = 0; this._h = 0; this._buf = new Uint8ClampedArray(0); }
  set width(v) { this._w = v | 0; this._alloc(); }
  get width() { return this._w; }
  set height(v) { this._h = v | 0; this._alloc(); }
  get height() { return this._h; }
  _alloc() { this._buf = new Uint8ClampedArray(Math.max(0, this._w * this._h * 4)); }
  getContext() {
    const cv = this;
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: (im) => { cv._buf.set(im.data.subarray(0, cv._buf.length)); },
      getImageData: (x, y, w, h) => ({ data: cv._buf.slice(), width: w, height: h }),
      fillRect() {}, clearRect() {},
    };
  }
}
globalThis.document = { createElement: () => new FakeCanvas() };
globalThis.window = globalThis;

const pb = await import(pathToFileURL(join(ROOT, 'anim/pianoBlocks.mjs')).href);

// ---------- 几何：与 anim/pianoBlocks.mjs 的 ensureGeom / BLACK_OFF 同规则 ----------
const WHITE_W = 72;                    // 预览里一根白键的像素宽
const KB_H = 300;                      // 键盘可见高度
const BLACK_OFF = { 1: -0.10, 3: 0.10, 6: -0.13, 8: 0, 10: 0.13 };
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const BW = Math.round(WHITE_W * 0.58);
const BH = Math.round(KB_H * 0.66);
const PADX = Math.max(1, Math.round(BW * 0.18));
const PADB = Math.max(1, Math.round(BH * 0.22));
const DIP = Math.max(2, Math.round(KB_H * 0.030));

const whiteUp = pb.__kbSpriteRGBA('white', WHITE_W, KB_H, { x0: 0, y0: 0, w: WHITE_W, h: KB_H }, 0);
const whiteDn = pb.__kbSpriteRGBA('white', WHITE_W, KB_H, { x0: 0, y0: 0, w: WHITE_W, h: KB_H }, DIP);
const bwPx = BW + PADX * 2, bhPx = BH + PADB;
const blackBody = { x0: PADX, y0: 0, w: BW, h: BH };
const blackUp = pb.__kbSpriteRGBA('black', bwPx, bhPx, blackBody, 0);
const blackDn = pb.__kbSpriteRGBA('black', bwPx, bhPx, blackBody, DIP);
if (!whiteUp || !blackUp) { console.error('取精灵失败'); process.exit(1); }

// ---------- 合成：8 根白键(C4→C5) + 5 根黑键，按下 C4(白) 与 C#4(黑) ----------
const NW = 8, MARGIN = 40;
const W = NW * WHITE_W + MARGIN * 2;
const H = KB_H + MARGIN * 2;
const img = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { img[i * 4] = 7; img[i * 4 + 1] = 9; img[i * 4 + 2] = 13; img[i * 4 + 3] = 255; }

function blit(sp, dx, dy) {
  for (let y = 0; y < sp.h; y++) {
    const ty = dy + y; if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < sp.w; x++) {
      const tx = dx + x; if (tx < 0 || tx >= W) continue;
      const s = (y * sp.w + x) * 4, a = sp.data[s + 3] / 255;
      if (a <= 0) continue;
      const d = (ty * W + tx) * 4;
      img[d] += (sp.data[s] - img[d]) * a;
      img[d + 1] += (sp.data[s + 1] - img[d + 1]) * a;
      img[d + 2] += (sp.data[s + 2] - img[d + 2]) * a;
    }
  }
}

const pressedWhite = new Set([0]);                       // 白键索引 0 = C4
const whites = [];
for (let i = 0; i < NW; i++) whites.push(MARGIN + i * WHITE_W);
for (let i = 0; i < NW; i++) blit(pressedWhite.has(i) ? whiteDn : whiteUp, whites[i], MARGIN);

// 黑键：白键 pc ∈ {0,2,5,7,9} 的后面跟一根黑键，中心 = 该白键右边界 + BLACK_OFF
const WHITE_ORDER = [0, 2, 4, 5, 7, 9, 11];
const BLACK_AFTER = { 0: 1, 2: 3, 5: 6, 7: 8, 9: 10 };
const pressedBlack = new Set([1]);                       // C#4 按下
for (let i = 0; i < NW - 1; i++) {
  const pc = WHITE_ORDER[i % 7];
  const pcB = BLACK_AFTER[pc];
  if (pcB === undefined) continue;
  const center = MARGIN + (i + 1) * WHITE_W + (BLACK_OFF[pcB] || 0) * WHITE_W;
  blit(pressedBlack.has(pcB) ? blackDn : blackUp, Math.round(center - bwPx / 2), MARGIN);
}

// ---------- 写 PNG（自带最小 PNG 编码器，零依赖） ----------
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, c]);
};

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 最近邻放大裁剪：把"按下 C4 + 按下 C#4 + 抬起 D4"这一段放大 2 倍，用于判断
// 倒角宽度、侧棱高光、前立面厚度这些细节（缩略图里看不出来）。
function cropZoom(x0, y0, w, h, k) {
  const ow = w * k, oh = h * k;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const sy = y0 + ((y / k) | 0);
    for (let x = 0; x < ow; x++) {
      const sx = x0 + ((x / k) | 0);
      const s = (sy * W + sx) * 4, d = (y * ow + x) * 4;
      out[d] = img[s]; out[d + 1] = img[s + 1]; out[d + 2] = img[s + 2]; out[d + 3] = 255;
    }
  }
  return { w: ow, h: oh, data: out };
}

const outDir = process.argv[2] || join(ROOT, 'logs');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePNG(W, H, img);
const out = join(outDir, 'kb-pbr.png');
fs.writeFileSync(out, png);
const z = cropZoom(MARGIN - 10, MARGIN, WHITE_W * 3 + 20, KB_H, 2);
fs.writeFileSync(join(outDir, 'kb-pbr-zoom.png'), encodePNG(z.w, z.h, z.data));
console.log('已写出 ' + out + '  ' + W + 'x' + H + '  白键精灵=' + whiteUp.w + 'x' + whiteUp.h + ' 黑键精灵=' + bwPx + 'x' + bhPx + ' dip=' + DIP);
console.log('已写出 ' + join(outDir, 'kb-pbr-zoom.png') + '  ' + z.w + 'x' + z.h);
