// ============================================================
// test/pwa.mjs —— PWA 可安装性守卫（node 直跑，无浏览器）
// 背景：2026-09-15 加了 manifest + Service Worker + 图标。
// 安装失败在浏览器里**没有任何报错**（图标 404、manifest 字段写错、MIME 不对，
// 都只是"地址栏不出现安装按钮"），靠肉眼永远查不出来，只能在这里钉住：
//   ① manifest 是合法 JSON 且必备字段齐全
//   ② icons 声明的每个文件真实存在、是合法 PNG、且像素尺寸与声明一致
//      （声明 192 实际 180 会被 Chrome 判为无效图标 → 静默不可安装）
//   ③ index.html 真的引用了 manifest（引错路径等于没加）
//   ④ server.mjs 能正确给出 .webmanifest 的 MIME（octet-stream 会被拒）
//   ⑤ sw.js 存在且有版本化的缓存名（否则升级后永远吃旧缓存）
// ============================================================
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const R = (p) => path.join(ROOT, p);

let fails = 0;
const ck = (name, cond) => { if (cond) console.log('  ok  ' + name); else { fails++; console.error('  FAIL ' + name); } };

console.log('[pwa] 可安装性守卫');

// ① manifest
let mf = null;
try { mf = JSON.parse(readFileSync(R('manifest.webmanifest'), 'utf8')); }
catch (e) { ck('manifest.webmanifest 是合法 JSON', false); }
if (mf) {
  ck('manifest 是合法 JSON', true);
  for (const k of ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color', 'background_color']) {
    ck(`manifest 有 ${k}`, mf[k] !== undefined && mf[k] !== '');
  }
  ck('display 是 standalone/fullscreen/minimal-ui 之一',
    ['standalone', 'fullscreen', 'minimal-ui'].includes(mf.display));
  ck('start_url 与 scope 是同源相对路径',
    String(mf.start_url).startsWith('./') && String(mf.scope ?? './').startsWith('./'));
  ck('icons 至少两项', Array.isArray(mf.icons) && mf.icons.length >= 2);

  // ② 图标文件逐项校验
  const pngSize = (buf) => {
    // PNG 签名 8 字节 + IHDR 长度(4)+类型(4) → 宽在 16、高在 20（大端）
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buf.length < 24) return null;
    for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  };
  const want = new Set();
  for (const ic of mf.icons) {
    const src = String(ic.src).replace(/^\.\//, '');
    const p = R(src);
    const exists = existsSync(p);
    ck(`图标存在 ${src}`, exists);
    if (!exists) continue;
    const buf = readFileSync(p);
    const dim = pngSize(buf);
    ck(`图标是合法 PNG ${src}`, !!dim);
    if (!dim) continue;
    ck(`图标是正方形 ${src}`, dim.w === dim.h);
    // 声明的 sizes 必须与实际像素一致
    const declared = String(ic.sizes).split(/\s+/).filter(Boolean);
    ck(`图标尺寸与声明一致 ${src} (${dim.w}x${dim.h} / 声明 ${ic.sizes})`,
      declared.includes(`${dim.w}x${dim.h}`));
    ck(`图标 MIME 是 image/png ${src}`, ic.type === 'image/png');
    if (dim.w >= 512) want.add('512');
    if (dim.w === 192) want.add('192');
  }
  ck('含 192 与 512 两种规格（低于 512 Chrome 不认为可安装）', want.has('192') && want.has('512'));
  ck('图标不是空文件', mf.icons.every((ic) => {
    const p = R(String(ic.src).replace(/^\.\//, ''));
    return !existsSync(p) || statSync(p).size > 200;
  }));
}

// ③ index.html 引用
{
  const html = readFileSync(R('index.html'), 'utf8');
  ck('index.html 引用了 manifest', /<link[^>]+rel=["']manifest["'][^>]+href=["']\.\/manifest\.webmanifest["']/.test(html));
  ck('index.html 声明了 theme-color', /<meta[^>]+name=["']theme-color["']/.test(html));
  ck('index.html 有 apple-touch-icon（iOS 不支持 SVG，必须给 PNG）',
    /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']\.\/icon-\d+\.png["']/.test(html));
}

// ④ server.mjs MIME
{
  const srv = readFileSync(R('server.mjs'), 'utf8');
  ck('server.mjs 给 .webmanifest 配了 manifest+json MIME', /\.webmanifest['"]\s*:\s*['"]application\/manifest\+json/.test(srv));
}

// ⑤ sw.js
{
  const p = R('sw.js');
  ck('sw.js 存在', existsSync(p));
  if (existsSync(p)) {
    const sw = readFileSync(p, 'utf8');
    ck('sw.js 有版本化缓存名（改版本才会清旧缓存）', /const\s+CACHE\s*=\s*['"][^'"]*v\d+/.test(sw));
    ck('sw.js 注册了 install/activate/fetch 三个事件',
      /addEventListener\(['"]install/.test(sw) && /addEventListener\(['"]activate/.test(sw) && /addEventListener\(['"]fetch/.test(sw));
    ck('sw.js 不拦截跨源请求（RVC 桥 127.0.0.1:7865 必须放行）', /url\.origin\s*!==\s*self\.location\.origin/.test(sw));
  }
}

// ⑥ app.mjs 注册 SW
{
  const app = readFileSync(R('app.mjs'), 'utf8');
  ck('app.mjs 注册了 ./sw.js', /serviceWorker\.register\(\s*['"]\.\/sw\.js['"]\s*\)/.test(app));
  ck('注册前判断了 secure context（局域网 IP 下注册会失败）', /isSecureContext/.test(app));
}

if (fails) { console.error(`[pwa] ${fails} 项失败`); process.exit(1); }
console.log('[pwa] 全部通过');
