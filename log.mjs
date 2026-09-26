// ============================================================
// log.mjs —— 全应用调试日志系统
//
// 目的：把「用户那边到底发生了什么」完整留下来。出问题时用户导出一份日志，
// 出问题时能拿它离线复盘，而不是靠猜"是不是点了某个按钮"。
//
// 设计要点（对齐浏览器端日志的通行做法）：
//   1. 分级 DEBUG/INFO/WARN/ERROR —— 需要时可只开 WARN 以上，压掉噪音；
//   2. 结构化条目 {seq, ts, level, cat, msg, data} —— 人能读，机器也能解析；
//   3. 内存环形缓冲 + IndexedDB 落盘 —— 刷新/关页面都不丢（用户不必当场导出）；
//   4. 全局捕获 onerror / unhandledrejection / console.error —— 不依赖主动打点，
//      three.js、tfjs 这类第三方库的报错也能进日志；
//   5. 会话 ID —— 一次打开的所有日志串成一条线，多次录音可区分先后；
//   6. 批量写盘 —— 每条都开事务会拖慢主流程，攒批或定时 flush。
//
// 降级原则：IndexedDB 不可用（隐私模式 / file:// 等）时自动退化为纯内存日志，
// 绝不因为日志系统本身抛错而打断主流程。
// ============================================================

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const LEVEL_NAMES = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR' };

const MEM_MAX = 3000;     // 内存环形缓冲上限（UI 面板只展示这部分）
const DISK_MAX = 20000;   // 落盘保留条数上限（超出删最旧的，防止无限膨胀）
const FLUSH_MS = 3000;    // 定时落盘间隔
const FLUSH_N = 150;      // 或攒够这么多条立即落盘

const DB_NAME = 'ydyi-logs';
const STORE = 'entries';

// ---------- 状态 ----------
let seq = 0;                    // 自增序号（也是落盘主键，用于裁剪）
let minLevel = LEVELS.DEBUG;
let buf = [];                   // 内存环形缓冲（最近的日志）
let pending = [];               // 待落盘
let dbPromise = null;
let flushTimer = null;
const listeners = new Set();

// 会话：一次页面打开 = 一个 session，多次录音/导入靠它区分先后
const sessionId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const bootAt = Date.now();

// ---------- 工具 ----------
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtISO(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// 日志里的 data 可能来自任意调用点，循环引用/大数组都会让 stringify 炸掉或撑爆文件。
// 统一走这个"安全序列化"：失败就退化成类型说明，绝不连带整份日志导出失败。
function safeJson(v, depth = 0) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') {
    return t === 'string' && v.length > 400 ? v.slice(0, 400) + '…(截断)' : v;
  }
  if (depth > 3) return '[deep]';
  if (v instanceof Error) return { name: v.name, message: v.message, stack: (v.stack || '').slice(0, 800) };
  if (Array.isArray(v)) {
    // 数组只留前 20 项：避免把 analysis.frames 这种上万条的东西整包塞进日志
    return v.slice(0, 20).map((x) => safeJson(x, depth + 1));
  }
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      // 只对真正的对象/数组按名省略；数字等标量照常输出(如 analysisSummary 的 frames 帧数)
      if ((k === 'frames' || k === 'buffer' || k === 'pcm') && v[k] !== null && typeof v[k] === 'object') { out[k] = '[省略 ' + (Array.isArray(v[k]) ? v[k].length + ' 项' : '大对象') + ']'; continue; }
      out[k] = safeJson(v[k], depth + 1);
    }
    return out;
  }
  return '[' + t + ']';
}

// ---------- IndexedDB ----------
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'seq' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

// 批量落盘：一次事务写一批，写完裁剪超限的旧条目
async function flush() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      for (const e of batch) s.put(e);
      // 裁剪：只保留最近 DISK_MAX 条（seq 自增，删小的一端）
      s.delete(IDBKeyRange.upperBound(seq - DISK_MAX));
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch (e) {
    // 落盘失败不连累主流程：退回内存，日志仍然可用（只是不跨会话）
    pending = batch.concat(pending).slice(0, MEM_MAX);
  }
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
}

// ---------- 核心写入 ----------
function write(level, cat, msg, data) {
  if (level < minLevel) return null;
  seq++;
  const entry = {
    seq,
    ts: Date.now(),
    level: LEVEL_NAMES[level],
    cat: cat || 'app',
    msg: String(msg),
    session: sessionId,
  };
  if (data !== undefined) entry.data = safeJson(data);

  buf.push(entry);
  if (buf.length > MEM_MAX) buf.splice(0, buf.length - MEM_MAX);
  pending.push(entry);
  if (pending.length >= FLUSH_N) { flush(); } else { scheduleFlush(); }

  // 同时打到 console：开着 devtools 时能直接看到（原生调用，避免被自己的 console 拦截套娃）
  const line = `${fmtClock(entry.ts)} [${entry.level}] {${entry.cat}} ${entry.msg}`;
  try {
    if (level >= LEVELS.ERROR) nativeError(line, data !== undefined ? data : '');
    else if (level >= LEVELS.WARN) nativeWarn(line, data !== undefined ? data : '');
    else nativeLog(line, data !== undefined ? data : '');
  } catch (e) { /* console 不可用则忽略 */ }

  for (const fn of listeners) { try { fn(entry); } catch (e) {} }
  return entry;
}

const nativeLog = console.log.bind(console);
const nativeWarn = console.warn.bind(console);
const nativeError = console.error.bind(console);

// ---------- 对外 API ----------
export const log = {
  LEVELS,
  sessionId,

  debug: (cat, msg, data) => write(LEVELS.DEBUG, cat, msg, data),
  info: (cat, msg, data) => write(LEVELS.INFO, cat, msg, data),
  warn: (cat, msg, data) => write(LEVELS.WARN, cat, msg, data),
  error: (cat, msg, data) => write(LEVELS.ERROR, cat, msg, data),

  setLevel(name) { minLevel = LEVELS[String(name).toUpperCase()] ?? LEVELS.DEBUG; },
  getLevel() { return LEVEL_NAMES[minLevel]; },

  /** 内存中的最近日志（可过滤）。返回副本，外部改动不影响内部缓冲 */
  entries({ level, cat, since } = {}) {
    let out = buf.slice();
    if (level) { const min = LEVELS[String(level).toUpperCase()] ?? 0; out = out.filter((e) => LEVELS[e.level] >= min); }
    if (cat) out = out.filter((e) => e.cat === cat);
    if (since) out = out.filter((e) => e.ts >= since);
    return out;
  },

  /** 订阅新日志（面板实时刷新用），返回取消函数 */
  onAppend(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /** 落盘的全部日志（跨会话），供导出 */
  async all() {
    await flush();
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const r = t.objectStore(STORE).getAll();
        t.oncomplete = () => resolve(r.result || []);
        t.onerror = () => reject(t.error);
      });
    } catch (e) {
      return buf.slice();   // IDB 不可用 → 退化为内存
    }
  },

  async clear() {
    buf = []; pending = [];
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).clear();
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    } catch (e) { /* 忽略 */ }
  },

  async stats() {
    const all = await this.all();
    const byLevel = {};
    for (const e of all) byLevel[e.level] = (byLevel[e.level] || 0) + 1;
    return { total: all.length, byLevel, sessions: new Set(all.map((e) => e.session)).size };
  },

  /** 导出为纯文本 .log（给人看：带摘要 + 一行一条） */
  async exportText() {
    const all = await this.all();
    const byLevel = {};
    const byCat = {};
    for (const e of all) {
      byLevel[e.level] = (byLevel[e.level] || 0) + 1;
      byCat[e.cat] = (byCat[e.cat] || 0) + 1;
    }
    const errs = all.filter((e) => e.level === 'ERROR' || e.level === 'WARN');
    const L = [];
    L.push('# 调试日志');
    L.push(`# 导出时间：${fmtISO(Date.now())}`);
    L.push(`# 当前会话：${sessionId}（本次页面打开于 ${fmtISO(bootAt)}）`);
    L.push(`# 环境：${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`);
    if (typeof screen !== 'undefined') L.push(`# 屏幕：${screen.width}x${screen.height}  语言：${navigator.language}`);
    L.push(`# 统计：共 ${all.length} 条 —— DEBUG ${byLevel.DEBUG || 0} · INFO ${byLevel.INFO || 0} · WARN ${byLevel.WARN || 0} · ERROR ${byLevel.ERROR || 0}`);
    L.push(`# 分类：${Object.entries(byCat).map(([k, v]) => k + ' ' + v).join(' · ') || '（空）'}`);
    if (errs.length) {
      L.push(`# `);
      L.push(`# ── 警告与错误（${errs.length} 条）──`);
      for (const e of errs) L.push(`#   ${fmtClock(e.ts)} [${e.level}] {${e.cat}} ${e.msg}${e.data !== undefined ? '  ' + JSON.stringify(e.data) : ''}`);
    }
    L.push('# ──────────── 日志正文 ────────────');
    let lastSess = null;
    for (const e of all) {
      if (e.session !== lastSess) { L.push(''); L.push(`=== 会话 ${e.session} ===`); lastSess = e.session; }
      L.push(`${fmtClock(e.ts)} [${e.level.padEnd(5)}] {${e.cat}} ${e.msg}${e.data !== undefined ? '  ' + JSON.stringify(e.data) : ''}`);
    }
    return L.join('\n');
  },

  /** 导出为 JSON（给机器看：结构化完整） */
  async exportJSON() {
    const all = await this.all();
    return JSON.stringify({
      format: 'ydyi-log', version: 1,
      exportedAt: new Date().toISOString(),
      sessionId, bootAt: new Date(bootAt).toISOString(),
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      entries: all,
    }, null, 2);
  },
};

// ---------- 全局错误捕获 ----------
// 只装一次：模块被多处 import 也只生效一份（ESM 模块单例）
if (typeof window !== 'undefined' && !window.__ydyiLogHooked) {
  window.__ydyiLogHooked = true;

  window.addEventListener('error', (ev) => {
    log.error('js', ev.message || '未捕获错误', {
      source: ev.filename, line: ev.lineno, col: ev.colno,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 800) : undefined,
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    log.error('promise', '未处理的 Promise 拒绝：' + (r && r.message ? r.message : String(r)), { stack: r && r.stack ? String(r.stack).slice(0, 800) : undefined });
  });
  // 拦截 console.error：three.js / tfjs 等第三方库的报错不走 window.onerror，
  // 只能这样收进日志。用原生方法回写，避免与上面的 write() 递归套娃。
  console.error = (...args) => {
    try { write(LEVELS.ERROR, 'console', args.map((a) => (a && a.message) ? a.message : String(a)).join(' ')); } catch (e) {}
    nativeError(...args);
  };
  // 关页面前把内存里的补写进磁盘（pagehide 比 beforeunload 更可靠，且不影响 bfcache）
  window.addEventListener('pagehide', () => { try { flush(); } catch (e) {} });
}

export default log;
