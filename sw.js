// ============================================================
// sw.js —— Service Worker（2026-09-15）
//
// 这个项目说「离线」有两层意思，别混：
//   ① 不依赖互联网 —— 三方资源（音色采样、tfjs、basic-pitch）早就全在本地，
//      页面本身也由本机 `node server.mjs` 提供。这一层【早就成立】，跟 SW 无关。
//   ② 可安装 + 外壳离线 —— 这才是 SW 带来的：装成独立窗口的 App、断网/服务未起时外壳仍能开。
//
// 策略为什么是"网络优先"而不是常见的"缓存优先"：
//   本项目是单人在本机开发，`npm start` 一改代码就刷新页面。缓存优先会让开发者
//   反复看到旧代码（改了没生效 / 以为是 bug），这类"隐形陈旧"极难排查。
//   网络优先 = 开发体验与没有 SW 时完全一致，只有真正 fetch 失败才回落缓存。
//   ⚠️ 站点带 `Cache-Control: no-store`（server.mjs）——那只影响浏览器 HTTP 缓存，
//      不影响 SW 的 Cache API，所以这里依然存得住。
//
// 不缓存什么：mp3 / bin 这类大体积二进制。它们本来就在本机、秒开，
//   缓存唯一效果是把 16MB 采样再复制一份，收益为零。
// ============================================================
const CACHE = 'ydyi-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
];
const HEAVY = /\.(bin|data|mp3)$/i;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个 add 而非 addAll：addAll 是原子的，任何一个 404 会让整个 install 失败，
    // 外壳就永远装不上。这里缺谁跳谁。
    await Promise.all(SHELL.map((u) =>
      c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // RVC 桥(127.0.0.1:7865)等跨源一律放行
  if (HEAVY.test(url.pathname)) return;              // 大体积资源不缓存，交给网络

  // 导航请求：网络优先 → 失败回外壳
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r && r.ok) (await caches.open(CACHE)).put('./index.html', r.clone());
        return r;
      } catch (err) {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // 其它同源资源：网络优先 + 顺带补进缓存（离线时才有东西可回落）
  e.respondWith((async () => {
    try {
      const r = await fetch(req);
      // 用 status===200 而不是 r.ok：r.ok 对 206(Partial Content) 也为真，而 Range 响应是
      // 残缺内容，补进缓存会让离线回落拿到"半截"资源（当前页面没有 <audio>/Range 请求，
      // 属预防性收口；2026-09-18 修）。
      if (r && r.status === 200 && r.type === 'basic') (await caches.open(CACHE)).put(req, r.clone());
      return r;
    } catch (err) {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
