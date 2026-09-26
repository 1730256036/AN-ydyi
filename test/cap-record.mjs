// ============================================================
// test/cap-record.mjs —— 录屏导出接线守卫（node 直跑，无浏览器）
// 背景：2026-09-15「点击录制动画没有任何反应」。
// 根因：capBuildAudio() 返回的是 MediaStreamAudioDestinationNode（AudioNode），
//       而 capStart() 对它调 .getAudioTracks() —— 该方法只在 .stream 上有。
//       于是抛 TypeError，而那一行【不在任何 try/catch 里】→ 异常冒出点击处理函数，
//       外表看就是"按钮点了没反应"（无提示、无日志、按钮文字也不变）。
//       冒烟测试抓不到：它只 import 模块，不点按钮。
//
// 这个测试就是补上那一环：用桩浏览器 API 把「点按钮」这条路真的走一遍。
// 钉住四件事：
//   ① 点在 #btnRecord 上必须真的创建 MediaRecorder 并 start
//   ② 按钮文字必须变成"■ 停止录制"（= 用户能看见反应）
//   ③ 交给 MediaRecorder 的流必须有 1 条视频 + 1 条音频轨（③ 就是这次的 bug）
//   ④ 停止后必须真的触发下载（.webm）
// ⚠️ 这些断言都在 try/catch【之外】——本测试的存在意义就是让"静默抛异常"变成红色。
// ============================================================
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeVint, readElement } from '../proj/webm-duration.mjs';   // 仅用于构造/核对测试用的最小 WebM

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';

let fails = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[cap-record] 录屏导出接线守卫');

// ---------- 桩：DOM ----------
const byIdMap = new Map();
const createdEls = [];
function mkEl(id) {
  const listeners = {};
  const e = {
    id, clientWidth: 1280, clientHeight: 720, width: 1280, height: 720,
    style: {}, textContent: '', innerHTML: '', className: '', value: 'high', checked: false,
    disabled: false, href: '', download: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
    removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    // 2026-09-16 补：app.mjs 启动时 buildGlobalControls() 会把「原声」滑杆用
    // insertBefore 插到「导入音频」按钮前面；桩缺这个方法会在启动路径直接抛。
    insertBefore(c) { return c; },
    click() { e.__clicked = true; },
    getContext: () => ctxStub(),
    querySelectorAll: () => [],
    querySelector: () => mkEl('inner'),
    parentElement: { clientWidth: 1280, clientHeight: 720 },
    __listeners: listeners,
  };
  e.captureStream = () => makeStream([{ kind: 'video', stop() {} }]);
  return e;
}
function ctxStub() {
  return new Proxy({}, {
    get(t, p) { if (p === 'canvas') return {}; return () => ctxStub(); },
    set() { return true; },
  });
}
function byId(id) {
  if (!byIdMap.has(id)) byIdMap.set(id, mkEl(id));
  return byIdMap.get(id);
}
globalThis.document = {
  querySelector: (sel) => (sel.startsWith('#') ? byId(sel.slice(1)) : mkEl('generic')),
  querySelectorAll: () => [],
  createElement: (tag) => { const e = mkEl('created:' + tag); createdEls.push(e); return e; },
  addEventListener: () => {},
  removeEventListener: () => {},
  body: mkEl('body'),
  documentElement: mkEl('html'),
  fullscreenElement: null,
  exitFullscreen: () => {},
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.isSecureContext = false;          // 跳过 SW 注册，聚焦录制路径
globalThis.requestAnimationFrame = () => 1;  // 不真跑渲染循环
globalThis.cancelAnimationFrame = () => {};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => ({ id: 'fake-mic' }) } },
  configurable: true,
});
globalThis.fetch = () => Promise.reject(new Error('no local bridge'));   // RVC 探测快速失败
let lastBlob = null;                                                     // 抓住真正被下载的字节
globalThis.URL.createObjectURL = (b) => { lastBlob = b; return 'blob:fake'; };
globalThis.URL.revokeObjectURL = () => {};

// ---------- 桩：Web Audio + MediaRecorder ----------
const AT = { kind: 'audio', stop() {} };
function makeStream(tracks) {
  return {
    tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getTracks: () => tracks,
  };
}
const audioNode = () => ({ connect() {}, disconnect() {} });
globalThis.AudioContext = class {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.currentTime = 0; this.destination = audioNode(); }
  createAnalyser() {
    return {
      fftSize: 4096, smoothingTimeConstant: 0, frequencyBinCount: 2048,
      getFloatTimeDomainData(a) { for (let i = 0; i < a.length; i++) a[i] = 0; },
      getFloatFrequencyData(a) { for (let i = 0; i < a.length; i++) a[i] = -140; },
      getByteFrequencyData(a) { for (let i = 0; i < a.length; i++) a[i] = 0; },
    };
  }
  createGain() { const g = { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; return Object.assign(g, audioNode()); }
  // 关键：真实 API 里音频轨在 .stream 上，节点本身没有 getAudioTracks —— 桩如实照做，
  // 否则这个测试就抓不到这次的 bug 了。
  createMediaStreamDestination() { return Object.assign({ stream: makeStream([AT]) }, audioNode()); }
  createMediaStreamSource() { return audioNode(); }
  createDynamicsCompressor() {
    return Object.assign({ threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} }, audioNode());
  }
  createBufferSource() { return Object.assign({ buffer: null, start() {}, stop() {} }, audioNode()); }
  createBuffer(ch, len, sr) { return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: () => new Float32Array(len) }; }
  decodeAudioData() { return Promise.resolve(this.createBuffer(1, 48000, 48000)); }
  resume() { this.state = 'running'; return Promise.resolve(); }
};
globalThis.MediaStream = class { constructor(t) { return makeStream(t); } };
globalThis.MediaRecorder = class {
  static isTypeSupported(m) { return /webm/.test(String(m)); }
  constructor(stream, opts) {
    this.stream = stream; this.mimeType = (opts && opts.mimeType) || ''; this.state = 'inactive';
    globalThis.MediaRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  // 必须吐真 Blob：真实 MediaRecorder 的 data 是 Blob（靠 .size 判空），
  // Uint8Array 只有 .length 没有 .size → 应用会被正确地判成"空数据"。这里照实模拟。
  __chunk(n) { if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(n)]) }); }
  __chunkBytes(u8) { if (this.ondataavailable) this.ondataavailable({ data: new Blob([u8]) }); }
};

const click = (id, n = 0) => {
  const h = byId(id).__listeners.click;
  if (!h || !h[n]) { ck(`#${id} 绑定了 click 处理函数`, false, '没找到监听器'); return false; }
  try {
    const r = h[n]();
    // 处理函数是 async 的（如 startRecording）：必须自己接住 rejection，
    // 否则 Node 默认会把"未处理的 promise 拒绝"当致命错误，整个测试进程崩掉。
    if (r && typeof r.then === 'function') r.catch(() => {});
    return true;
  } catch (e) { ck(`点击 #${id} 不得抛异常`, false, (e && e.message) || String(e)); return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import('../app.mjs');

// ---------- 前置：让 audioCtx 存在 ----------
// 关键：audioCtx 只有 startRecording/导入/decodeBuf 才会建。而本 bug 只在 audioCtx
// 存在时才触发（audioCtx 为 null 时 capBuildAudio 直接返回 null，绕过了出错那行）——
// 这正是"用户已经用过一会儿，再点录制就死了"的原因，测试必须复现这个前置。
click('btnPermit');           // → startRecording() → initAudio()
await sleep(200);

// ---------- ① 点录制必须有反应 ----------
click('btnRecord');
await sleep(30);
const rec = globalThis.MediaRecorder.last;
ck('点击后创建了 MediaRecorder', !!rec, rec ? '' : '未创建 —— 说明 capStart 提前返回或抛异常');
ck('MediaRecorder 已 start', !!rec && rec.state === 'recording', rec ? 'state=' + rec.state : '');
ck('按钮文字变为「■ 停止录制」（用户可见的反应）',
  byId('btnRecord').textContent === '■ 停止录制', '实际="' + byId('btnRecord').textContent + '"');

// ---------- ② 流里必须有音频轨（本次 bug 的核心） ----------
if (rec) {
  const vt = rec.stream.getVideoTracks ? rec.stream.getVideoTracks() : [];
  const at = rec.stream.getAudioTracks ? rec.stream.getAudioTracks() : [];
  ck('录制流含 1 条视频轨', vt.length === 1, 'vt=' + vt.length);
  ck('录制流含 1 条音频轨（AudioNode 上没有 getAudioTracks，必须取 .stream）',
    at.length === 1, 'at=' + at.length);
  ck('mimeType 选了 webm 系列', /webm/.test(rec.mimeType), rec.mimeType);
}

// ---------- ③ 停止必须真的落盘 ----------
createdEls.length = 0;
if (rec) { rec.__chunk(4096); rec.stop(); }
// 收尾是异步的（要读 blob 字节补 Duration），必须等一个 tick 再看结果
await sleep(50);
const status = byId('recStatus').textContent;
const anchor = createdEls.filter((e) => e.id === 'created:a').pop();
ck('停止后触发了下载', !!anchor && anchor.__clicked === true,
  'createElement 调用数=' + createdEls.length + '；状态栏="' + status + '"');
ck('文件名形如 动画-*.webm', !!anchor && /^动画-[\d-]+_[\d-]+\.webm$/.test(anchor.download),
  anchor ? anchor.download : '(无)');
ck('停止后按钮文字复原为「⏺ 录制动画」',
  byId('btnRecord').textContent === '⏺ 录制动画', '实际="' + byId('btnRecord').textContent + '"');
// 内容是随机字节、不是 WebM：补时长会被跳过，但【下载必须照旧发生】
ck('补时长失败不影响下载（非 WebM 内容也照常落盘）', !!lastBlob && lastBlob.size === 4096,
  lastBlob ? 'size=' + lastBlob.size : '没有 blob');

// ---------- ④ 真 WebM：必须补上 Duration（补的是 Info 段，净增 11 字节）----------
{
  const cat = (...ps) => { const n = ps.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; };
  const el = (idB, data) => cat(Uint8Array.from(idB), encodeVint(data.length), data);
  const UN8 = Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const webm = cat(
    el([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(8).fill(0x44)),                       // EBML 头
    Uint8Array.from([0x18, 0x53, 0x80, 0x67]), UN8,                                  // Segment(未知长度)
    el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], Uint8Array.from([0x0f, 0x42, 0x40]))),  // Info{TimecodeScale=1e6}
    cat(Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]), UN8, new Uint8Array(32).fill(0x43)),         // Cluster
  );
  click('btnRecord');
  await sleep(30);
  const rec2 = globalThis.MediaRecorder.last;
  ck('第二次录制也能启动', !!rec2 && rec2 !== rec);
  lastBlob = null;
  if (rec2) { rec2.__chunkBytes(webm); rec2.stop(); }
  await sleep(50);
  ck('真 WebM：下载的字节 = 原文件 + 11（Duration 元素）',
    !!lastBlob && lastBlob.size === webm.length + 11,
    lastBlob ? `原 ${webm.length} → 下载 ${lastBlob.size}` : '没有 blob');
  if (lastBlob && lastBlob.size === webm.length + 11) {
    const b = new Uint8Array(await lastBlob.arrayBuffer());
    // Info 的偏移从结构里算，别硬编码（改构造器就会错）
    const ebml = readElement(webm, 0);
    const seg = readElement(webm, ebml.dataEnd);
    const info = readElement(webm, seg.dataStart);
    ck('真 WebM：Info 之前逐字节不变（只准在 Info 里动手）',
      webm.subarray(0, info.start).every((v, i) => v === b[i]), 'Info @' + info.start);
    ck('真 WebM：Segment 补完仍是未知长度',
      readElement(b, readElement(b, 0).dataEnd).unknown === true);
  }
}

if (fails) { console.error(`[cap-record] ${fails} 项失败`); process.exit(1); }
console.log('[cap-record] 全部通过');
process.exit(0);
