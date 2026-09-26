#!/usr/bin/env node
// ydyi 本地静态服务器 —— 零依赖。因 Web Audio getUserMedia 需 secure context(https 或 localhost)，
// 用 http://localhost 提供。启动后在浏览器打开 http://localhost:8000
//
// ⚠ 只绑 127.0.0.1（仅本机可访问）：/api/archives 增删读列四个接口都没有鉴权，
//   绑到所有网卡等于把 archives/ 整个对同局域网敞开。改这里请同步 test/pwa.mjs 的守卫。
//
// 2026-09-19 起兼管存档文件夹镜像：/api/archives 增删读列四个接口。
// 本进程是真本机程序，有完整文件权限 → 前端存档时 fetch 一下，
// .ydyi 就静默落到 ROOT/archives/ 里（资源管理器直接可见可拷走）。
import http from 'node:http';
import net from 'node:net';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeArchiveName, isArchiveApiPath } from './proj/mirror.mjs';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const ARCHIVE_DIR = join(ROOT, 'archives');

// 启动即建目录：用户要的就是"打开工作目录能看到存档文件夹"，空着也要在
try { mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch (e) {
  console.error('  无法创建存档文件夹 archives/：' + (e.message || e));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.bin': 'application/octet-stream',
};

// ---------- /api/archives ----------
// 单条 .ydyi 含音频时 base64 后可达几十 MB，上限给足但要有界（防异常请求吃内存）
const MAX_BODY = 256 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function archiveList() {
  const names = readdirSync(ARCHIVE_DIR).filter((n) => /\.ydyi$/i.test(n));
  return names.map((n) => {
    const st = statSync(join(ARCHIVE_DIR, n));
    return { file: n, size: st.size, mtimeMs: st.mtimeMs };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// 元数据清单（列表页用）：解析每条 .ydyi，剥掉重字段（音频 base64/分析帧/包络/音符表），
// 只回列表需要的小字段。坏文件不炸服务，标记 id:null 让前端跳过。
function archiveMeta() {
  return archiveList().map(({ file, size }) => {
    try {
      const o = JSON.parse(readFileSync(join(ARCHIVE_DIR, file), 'utf8'));
      return {
        file, size,
        id: o.id || null, name: o.name || '(未命名)', createdAt: o.createdAt || 0,
        kind: o.kind || null, source: o.source || null,
        audioName: o.audioName || '', audioMime: o.audioMime || '',
        duration: o.duration || 0, audioHash: o.audioHash || '',
        hasAudio: !!o.audioDataUrl,
        noteCount: Array.isArray(o.midiNotes) ? o.midiNotes.length : 0,
      };
    } catch (e) { return { file, size, id: null, name: file }; }
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handleArchiveApi(req, res, urlPath) {
  const method = req.method || 'GET';
  try {
    if (urlPath === '/api/archives' && method === 'GET') {
      json(res, 200, { ok: true, files: archiveList() });
      return;
    }
    if (urlPath === '/api/archives-meta' && method === 'GET') {
      json(res, 200, { ok: true, files: archiveMeta() });
      return;
    }
    if (!urlPath.startsWith('/api/archives/')) { json(res, 404, { ok: false, error: 'not found' }); return; }
    // urlPath 在顶层已 decodeURIComponent 过一次（含 %xx 的文件名能正确还原）
    const name = urlPath.slice('/api/archives/'.length);
    if (!isSafeArchiveName(name)) { json(res, 400, { ok: false, error: 'bad archive file name' }); return; }
    const filePath = join(ARCHIVE_DIR, name);
    if (method === 'GET') {
      // 读单条存档全文（打开存档用）。文件不大就 utf8 直传；内容是 JSON 文本。
      const text = readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
      return;
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      writeFileSync(filePath, body);
      json(res, 200, { ok: true, file: name, size: body.length });
      return;
    }
    if (method === 'DELETE') {
      try { unlinkSync(filePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }   // 幂等
      json(res, 200, { ok: true });
      return;
    }
    json(res, 405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message || String(e) });
  }
}

const server = http.createServer((req, res) => {
  // 畸形请求（如 /a%zz）会让 decodeURIComponent 抛 URIError；这里是 request 回调的顶层，
  // 未捕获的异常会直接把服务器进程带走（浏览器不会这么发，但扫描器/手工 curl 会）。
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('Bad Request'); return; }

  if (isArchiveApiPath(urlPath)) {
    handleArchiveApi(req, res, urlPath);
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(ROOT, urlPath));
  // 防目录穿越
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('404 Not Found'); return;
  }
  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(filePath));
});

// ---------- 启动预检：端口被谁占着？ ----------
// 每次开启时主动检测端口占用，且"启动必须成功"。
//   ydyi-new = 新版本服务已在跑（有 /api/archives-meta）→ 不重复起，直接开页面退出
//   ydyi-old = 旧代码的服务进程（页面是本项目的、/api 却 404）→ 精确结束该 PID
//   other    = 别的程序占的 → 不动手（绝不误杀无关进程），跳过该端口换下一个
// 兜底：8000 若最终仍不可用，自动依次尝试 8001~8009（见下面 port++ 的循环；
// "8010~8009"，2026-09-22 更正）—— 前端全是相对路径，
// 换端口对页面零影响，保证"双击 bat 必定能得到一个能用的服务"。
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

async function probeOccupant(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/archives-meta');
    if (r.ok) return 'ydyi-new';
    if (r.status === 404) {
      const idx = await fetch('http://127.0.0.1:' + port + '/');
      const t = await idx.text();
      if (t.includes('音域音调仪') || t.includes('AN-ydyi')) return 'ydyi-old'; // 新旧标题都认
    }
    return 'other';
  } catch (e) { return 'other'; }
}

function killOldYdyi(port) {
  // Windows 专用：netstat 找到监听该端口的 LISTENING PID → taskkill。
  // 只杀"确认是旧 ydyi"这一种情形，other 情况根本不会走到这里。
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  const pids = new Set();
  let m;
  const lineRe = /^\s*TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$/gm;
  while ((m = lineRe.exec(out)) !== null) {
    if (m[1].endsWith(':' + port)) pids.add(m[3]);
  }
  if (!pids.size) throw new Error('netstat 里没找到监听 ' + port + ' 的 PID');
  for (const pid of pids) {
    console.log('  结束旧版 ydyi 进程 PID ' + pid + ' …');
    execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' });
  }
  return [...pids];
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { /* 开不了浏览器不致命，用户自己输网址也行 */ }
}

async function main() {
  let port = PORT;

  if (await portBusy(port)) {
    const who = await probeOccupant(port);
    if (who === 'ydyi-new') {
      console.log('\n  已有新版 ydyi 服务在 http://localhost:' + port + ' 运行，直接打开页面。\n');
      openBrowser('http://localhost:' + port);
      process.exit(0);
    }
    if (who === 'ydyi-old' && process.platform === 'win32') {
      try {
        killOldYdyi(port);
        console.log('  旧版 ydyi 服务已结束。');
      } catch (e) {
        console.error('  ✗ 结束旧版 ydyi 服务失败：' + (e.message || e));
        console.error('    请双击 stop-ydyi.bat，或到任务管理器→详细信息→结束 node.exe。');
        console.error('    下面尝试跳过该端口用别的端口启动。\n');
      }
    }
  }

  // 从 PORT 起找第一个空闲端口（被别的程序占着就跳过，不杀）
  for (let i = 0; i < 10 && (await portBusy(port)); i++) {
    if (i === 0) console.log('  端口 ' + port + ' 不可用，尝试下一个端口…');
    port++;
  }
  if (await portBusy(port)) {
    console.error('\n  ✗ ' + PORT + '~' + (PORT + 9) + ' 全被占用，请关掉一些程序后重试。\n');
    process.exit(1);
  }
  if (port !== PORT) {
    console.log('  ⚠ 端口 ' + PORT + ' 不可用，本次改用 ' + port + '（功能完全相同，旧端口上的服务与本页无关）');
  }

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://localhost:' + port;
    console.log(`\n  AN-ydyi 音域音调仪\n  ${url}\n  存档文件夹: ${ARCHIVE_DIR}\n  (仅本机可访问；关闭本窗口或 Ctrl+C = 停止服务)\n`);
    openBrowser(url);
  });
}

server.on('error', (e) => {
  console.error('\n  ✗ 服务器启动失败：' + (e && e.message || e) + '\n');
  process.exit(1);
});

main();
