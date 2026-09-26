// ============================================================
// test/_harness.mjs —— 驱动 app.mjs 的浏览器桩（不是测试，是测试的地基）
//
// 为什么需要它：app.mjs 是唯一的"编排层"，它把 DOM/WebAudio/MediaRecorder 全揉在一起，
// 只有 smoke 验证"import 不抛"、cap-record 跑录制一条路，覆盖太薄。
// 这套桩能把【真实的监听器】叫起来——也就是真的"点按钮"，让 app.mjs 走真实代码路径。
//
// 用法（必须先装桩、再动态 import，因为 app.mjs 在模块顶层就读 DOM）：
//     import { installStubs } from './_harness.mjs';
//     const H = installStubs();
//     await import('../app.mjs');
//     H.click('btnRec');
//
// ⚠️ 桩必须【照实模拟】真实 API 的形状，否则测试会给出假结论。两个已知的坑：
//   ① MediaStreamAudioDestinationNode 的音频轨在 .stream 上，节点本身没有 getAudioTracks()
//   ② MediaRecorder 的 ondataavailable 数据是 Blob（靠 .size 判空），不是 Uint8Array
// ============================================================
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import log from '../log.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------- 2D context 桩 ----------
function ctxStub() {
  return new Proxy({}, {
    get(t, p) { if (p === 'canvas') return {}; return () => ctxStub(); },
    set() { return true; },
  });
}

export function installStubs() {
  const els = new Map();
  const createdEls = [];
  const H = {
    els, createdEls,
    bufferSources: [],
    lastBlob: null,
    logs: [],
    downloadCount: 0,
    MediaRecorder: null,
    AudioContext: null,
  };

  function mkEl(id) {
    const listeners = {};
    const e = {
      id, tagName: 'DIV',
      clientWidth: 1280, clientHeight: 720, width: 1280, height: 720,
      style: {}, textContent: '', className: '',
      // value 默认**空串** —— 真实 DOM 里 document.createElement('input').value 就是 ''。
      // （写死 'high' 就是替 #recQ 的"高清"选项代劳；那属于"页面初始值"，
      //  已挪到下面的 index.html 播种阶段，见 SEL_DEFAULT。写死会让 JS 新建的输入框
      //  （如曲库搜索框）莫名带着 'high'，一开面板就把列表过滤空 → 2026-09-16 踩过。）
      value: '', checked: false, disabled: false, href: '', download: '', title: '',
      dataset: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); return on; },
      },
      addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
      removeEventListener() {},
      setAttribute(k, v) { (this.__attrs || (this.__attrs = {}))[k] = String(v); },
      getAttribute(k) { return (this.__attrs && this.__attrs[k] != null) ? this.__attrs[k] : null; },
      removeAttribute(k) { if (this.__attrs) delete this.__attrs[k]; },
      appendChild(c) { this.children = this.children || []; this.children.push(c); return c; },
      append(...cs) { this.children = (this.children || []).concat(cs); },
      insertBefore(c) { this.appendChild(c); return c; },
      replaceChildren(...cs) { this.children = cs; },
      prepend(c) { this.children = [c].concat(this.children || []); },
      before() {}, after() {},
      removeChild(c) { if (this.children) this.children = this.children.filter((x) => x !== c); },
      remove() {},
      click() { e.__clicked = (e.__clicked || 0) + 1; },
      getContext: () => ctxStub(),
      querySelectorAll: () => [],
      querySelector: () => mkEl('inner'),
      parentElement: { clientWidth: 1280, clientHeight: 720 },
      __listeners: listeners,
    };
    e.captureStream = () => makeStream([{ kind: 'video', stop() {} }]);
    // innerHTML 赋值 = **替换全部子节点**（真实 DOM 语义），桩也必须清 children。
    // 若只当普通属性，凡"清空 + 重建"的渲染代码（曲库 tab 条、存档列表、日志列表）
    // 在桩里会一代代越堆越多，测试再按 dataset/内容去找按钮，命中的是第一代陈旧节点
    // → 显示成"计数是 0 / 按钮不见了"，误判成应用 bug（2026-09-16 实测踩过：
    //   曲库 tab 5→15→25 个节点，东方计数永远读到第一次渲染的 0）。
    let html = '';
    Object.defineProperty(e, 'innerHTML', {
      get() { return html; },
      set(v) { html = String(v == null ? '' : v); e.children = []; },
      enumerable: true, configurable: true,
    });
    return e;
  }
  H.mkEl = mkEl;
  H.byId = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };

  const attrOf = (e, k) => { const m = e.match(new RegExp(k + '="([^"]*)"')); return m ? m[1] : null; };

  // document 级监听器必须记下来：capture 域把 pointer / Esc / fullscreenchange 全挂在
  // document 上，空函数等于"没实现"，没法验证"按 Esc 退出纯净模式"这类行为。
  const docListeners = {};
  let fsEl = null;                       // 可写的 fullscreenElement（测全屏退出路径用）
  globalThis.document = {
    querySelector: (sel) => (sel.startsWith('#') ? H.byId(sel.slice(1)) : mkEl('generic')),
    querySelectorAll: () => [],
    createElement: (tag) => { const e = mkEl('created:' + tag); e.tagName = tag.toUpperCase(); createdEls.push(e); return e; },
    // 打开日志/存档面板时会用 fragment 批量挂 DOM。不桩的话抛 TypeError，
    // 会被 app-buttons 的"按钮不许抛异常"断言误判成应用 bug（实为桩缺口）。
    createDocumentFragment: () => mkEl('fragment'),
    createTextNode: (t) => { const e = mkEl('text'); e.textContent = String(t); return e; },
    // 保真语义：只返回"确实存在"的元素（index.html 里的 id 已在播种阶段建好），
    // 不存在就是 null —— 不能凭空造元素，否则 `if (!byId(x)) 创建一次` 这类幂等保护会失效。
    getElementById: (id) => (els.has(id) ? els.get(id) : null),
    head: mkEl('head'),
    addEventListener: (t, fn) => { (docListeners[t] || (docListeners[t] = [])).push(fn); },
    removeEventListener: () => {},
    body: mkEl('body'),
    documentElement: mkEl('html'),
    get fullscreenElement() { return fsEl; },
    exitFullscreen: () => { fsEl = null; },
  };
  H.docListeners = docListeners;
  H.setFullscreen = (v) => { fsEl = v; };
  /** 触发 document 级事件：全部监听器都会被调（返回首个异常）。 */
  H.docFire = (t, ev) => {
    const h = docListeners[t];
    if (!h || !h.length) return { ok: false, error: new Error('document 没有 ' + t + ' 监听器') };
    let err = null;
    for (const fn of h) {
      try { const r = fn(ev || {}); if (r && typeof r.then === 'function') r.catch(() => {}); }
      catch (e) { if (!err) err = e; }
    }
    return { ok: !err, error: err };
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.isSecureContext = false;
  // 不自动跑渲染循环：把回调存起来，由测试用 H.pump() 手动推帧——
  // app.mjs 的实时检测（processBlock→appendRecPcm）只在 tick 里发生，不推帧就没有录音样本。
  globalThis.requestAnimationFrame = (cb) => { H.rafCb = cb; return (H.rafId = (H.rafId || 0) + 1); };
  globalThis.cancelAnimationFrame = () => {};
  H.pump = (t) => { const cb = H.rafCb; H.rafCb = null; if (cb) cb(t == null ? performance.now() : t); return !!cb; };

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
  globalThis.fetch = () => Promise.reject(new Error('no local bridge'));   // 测试内不真发包（存档列表/曲库 manifest 等一律快速失败）
  // 面板里的删除/清空/重命名会弹原生对话框；不桩会直接 ReferenceError，
  // 被元测试误判成"按钮抛异常"。
  globalThis.confirm = () => true;
  globalThis.prompt = (msg, def) => def || '重命名测试';
  globalThis.alert = () => {};
  globalThis.URL.createObjectURL = (b) => { H.lastBlob = b; H.downloadCount++; return 'blob:fake'; };
  globalThis.URL.revokeObjectURL = () => {};

  // ---------- WebAudio ----------
  const AT = { kind: 'audio', stop() {} };
  function makeStream(tracks) {
    return {
      tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
      getTracks: () => tracks,
    };
  }
  H.makeStream = makeStream;
  const node = () => ({ connect() {}, disconnect() {} });
  let ctxSeq = 0;
  H.contexts = [];
  globalThis.AudioContext = class {
    constructor() {
      this.sampleRate = 48000; this.state = 'running'; this.currentTime = 0;
      this.destination = node(); this.__n = ++ctxSeq;
      H.contexts.push(this);
    }
    createAnalyser() {
      return {
        fftSize: 4096, smoothingTimeConstant: 0, frequencyBinCount: 2048,
        getFloatTimeDomainData(a) { for (let i = 0; i < a.length; i++) a[i] = 0; },
        getFloatFrequencyData(a) { for (let i = 0; i < a.length; i++) a[i] = -140; },
        getByteFrequencyData(a) { for (let i = 0; i < a.length; i++) a[i] = 0; },
      };
    }
    createGain() {
      // setValueAtTime 要真的更新 value：真实 WebAudio 如此。audio 域的路由开关
      // （mic 增益 0⇄1）靠它切换，桩不更新的话"路由已切到 mic"就断言不出来。
      const gain = { value: 0, setValueAtTime(v) { gain.value = v; }, exponentialRampToValueAtTime() {} };
      return Object.assign({ gain }, node());
    }
    // 音频轨在 .stream 上（节点本身没有 getAudioTracks）——照实模拟
    createMediaStreamDestination() { return Object.assign({ stream: makeStream([AT]) }, node()); }
    createMediaStreamSource() { return node(); }
    createDynamicsCompressor() { return Object.assign({ threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} }, node()); }
    createBufferSource() {
      // playbackRate 在真实节点上是 AudioParam(value=1)：倍速的「磁带式」档就靠它，
      // 桩里不建这个字段的话，那条口径根本断言不出来（而它正是最容易被改坏的地方）。
      // start() 记下参数（真实 API 是 start(when, offset, duration)），seek/倍速换算靠它验。
      const s = Object.assign({
        buffer: null, onended: null, playbackRate: { value: 1 },
        start(when, offset, dur) { s.__start = { when, offset, dur }; }, stop() {},
      }, node());
      H.bufferSources.push(s);
      return s;
    }
    createBuffer(ch, len, sr) {
      const data = [];
      for (let c = 0; c < ch; c++) data.push(new Float32Array(len));
      return {
        numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr,
        getChannelData: (c) => data[c],
        copyToChannel: (src, c) => data[c].set(src.subarray(0, len)),
      };
    }
    decodeAudioData() { return Promise.resolve(this.createBuffer(1, 48000, 48000)); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };

  // ---------- MediaRecorder：建模真实的状态迁移 + 记录调用序列（状态机断言的依据） ----------
  globalThis.MediaStream = class { constructor(t) { return makeStream(t); } };
  class FakeMediaRecorder {
    static isTypeSupported(m) { return /webm/.test(String(m)); }
    constructor(stream, opts) {
      this.stream = stream; this.mimeType = (opts && opts.mimeType) || '';
      this.state = 'inactive'; this.__calls = [];
      FakeMediaRecorder.last = this; FakeMediaRecorder.all.push(this);
    }
    start() { this.state = 'recording'; this.__calls.push('start'); }
    pause() { this.state = 'paused'; this.__calls.push('pause'); }
    resume() { this.state = 'recording'; this.__calls.push('resume'); }
    stop() { this.state = 'inactive'; this.__calls.push('stop'); if (this.onstop) this.onstop(); }
    __chunk(n) { if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(n)]) }); }
    __chunkBytes(u8) { if (this.ondataavailable) this.ondataavailable({ data: new Blob([u8]) }); }
  }
  FakeMediaRecorder.all = [];
  globalThis.MediaRecorder = FakeMediaRecorder;
  H.MediaRecorder = FakeMediaRecorder;

  // ---------- 从 index.html 播种初始文案 / 内联显隐 / value ----------
  // 不播种的话桩元素全是空串，而真实页面里「▶ 播放」「● 开始录音」等初始文案来自 HTML——
  // app.mjs 在"还没播放过"之前根本不会去写它们，测试就会误判成"按钮是空的"。
  {
    const html = fs.readFileSync(ROOT + 'index.html', 'utf8');
    for (const m of html.matchAll(/<(\w+)([^>]*?\bid="([^"]+)"[^>]*?)>([^<]*)/g)) {
      const [, tag, attrs, id, inner] = m;
      const e = H.byId(id);
      e.tagName = tag.toUpperCase();
      if (inner && inner.trim()) e.textContent = inner.trim();
      const st = attrOf(attrs, 'style');
      if (st && /display\s*:\s*none/.test(st)) e.style.display = 'none';
      const val = attrOf(attrs, 'value');
      if (val != null) e.value = val;
      // checkbox 的初始勾选态也要播种：真实页面里 <input checked> 一出来就是 true，
      // 桩里恒 false 会把"勾选默认生效"的行为（如「导入即播」）测成没生效（2026-09-19）。
      if (/\bchecked\b/.test(attrs)) e.checked = true;
      // class 也要播种：真实页面里 #pureBar 初始就带 .hidden，不播的话
      // "进入纯净模式是否去掉了 hidden"这类断言会恒真（桩里根本没加过）。
      const cls = attrOf(attrs, 'class');
      if (cls) for (const c of cls.split(/\s+/)) if (c) e.classList.add(c);
    }
    // 少数元素的"页面初始值"推不出来（比如 <select> 里 <option ... selected> 的选中项），
    // 按页面事实显式补齐 —— 这属于"从 index.html 播种"，不属于 mkEl 的通用默认值。
    const SEL_DEFAULT = { recQ: 'high', playRate: '1' };   // index.html: <option value="high" selected>高清 / <option value="1" selected>1×
    for (const [id, v] of Object.entries(SEL_DEFAULT)) {
      const e = H.byId(id);
      if (e && !e.value) e.value = v;
    }
  }

  // ---------- 观测 ----------
  log.onAppend((e) => H.logs.push(e));
  // 后台异步链（如录音保存后的整段分析）在 node 里必然失败（没 Worker/没真实音频），
  // 这是环境限制不是应用 bug。这里【记下来】而不是让它把测试进程杀掉——
  // 想断言这件事的测试可以查 H.unhandled；不想管的也不会被噪音淹没。
  H.unhandled = [];
  process.on('unhandledRejection', (e) => {
    H.unhandled.push(e);
    if (process.env.YDYI_TEST_VERBOSE) console.error('  [unhandled] ' + ((e && e.message) || e));
  });

  // 点某个 id 的按钮（第 n 个 click 监听器）。返回 { ok, error }
  H.click = (id, n = 0) => {
    const h = H.byId(id).__listeners.click;
    if (!h || !h[n]) return { ok: false, error: new Error('#' + id + ' 没有 click 监听器') };
    try {
      const r = h[n]();
      // async 处理函数必须自己接住 rejection，否则 Node 会把"未处理的 promise 拒绝"当致命错误
      if (r && typeof r.then === 'function') r.catch(() => {});
      return { ok: true, error: null };
    } catch (e) { return { ok: false, error: e }; }
  };

  // 触发任意事件（不限于 click），例如 input/change 的文件选择
  H.fire = (id, type, ev) => {
    const h = H.byId(id).__listeners[type];
    if (!h || !h[0]) return { ok: false, error: new Error('#' + id + ' 没有 ' + type + ' 监听器') };
    try {
      const r = h[0](ev || {});
      if (r && typeof r.then === 'function') r.catch(() => {});
      return { ok: true, error: null };
    } catch (e) { return { ok: false, error: e }; }
  };
  // 造一个"像 File"的对象（只要有 name / arrayBuffer 就够 app 用）
  H.fakeFile = (name, bytes = 64) => ({ name, type: 'audio/wav', size: bytes, arrayBuffer: async () => new ArrayBuffer(bytes) });

  // 从 index.html 里抓出全部 <button id="...">，逐个点
  H.allButtonIds = () => {
    const html = fs.readFileSync(ROOT + 'index.html', 'utf8');
    const ids = [];
    for (const m of html.matchAll(/<button[^>]*\bid="([^"]+)"/g)) ids.push(m[1]);
    return ids;
  };
  H.attrOf = attrOf;

  // "有没有产生可观测结果"的快照：状态栏文案 / 日志条数 / 下载次数 / 新建 DOM 数 / toast
  H.observable = () => ({
    status: H.byId('recStatus').textContent,
    projStatus: H.byId('projStatus').textContent,
    logs: H.logs.length,
    downloads: H.downloadCount,
    created: createdEls.length,
    hint: H.byId('pbHint').textContent,
  });
  H.observableDiff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

  // 全体桩元素的 UI 指纹：文案 / class / 显隐 / 值。用于"点了按钮到底有没有反应"这类判断——
  // 只比状态栏会漏掉"只改了 class 或显隐"的按钮。
  H.uiHash = () => {
    const parts = [];
    for (const [id, e] of els) {
      parts.push(id + '|' + e.textContent + '|' + [...(e.classList._s || [])].sort().join('.') +
        '|' + (e.style.display || '') + '|' + e.value + '|' + (e.disabled ? 'D' : '') +
        // __clicked：按钮转调别的元素（如"导入音频"→ fileInput.click() 打开系统对话框）
        // 的效果就记在这里。不纳入指纹的话，这类按钮会被误判成"点了没反应"。
        '|' + (e.__clicked || 0));
    }
    return parts.join('\n');
  };

  H.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return H;
}
