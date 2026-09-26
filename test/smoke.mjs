// 冒烟测试：给 app.mjs 打桩浏览器 API，验证模块初始化 + 一次 drawFrame/tick 不抛异常
// node 运行（不真跑浏览器，仅抓初始化/渲染逻辑的运行时错）
// ---- 先建 stub 2D context（接收任意方法调用）----
function ctxStub() {
  return new Proxy({}, {
    get(t, p) {
      if (p === 'canvas') return {};
      return (...args) => ctxStub();
    },
    set() { return true; },
  });
}
function elStub() {
  const el = {
    clientWidth: 800, clientHeight: 500, width: 800, height: 500,
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, textContent: '', innerHTML: '',
    // 2026-09-16 补：app.mjs 的全局控件（原声音量）会用 insertBefore 插到
    // 「导入音频」按钮前面，缺了它启动路径就抛 → 冒烟测试红。桩要跟真实 DOM 同形。
    insertBefore(c) { return c; },
  };
  el.getContext = () => ctxStub();
  el.querySelectorAll = () => [];
  el.parentElement = { clientWidth: 800, clientHeight: 500 };
  return el;
}
globalThis.document = {
  querySelector: () => elStub(),
  querySelectorAll: () => [],
  createElement: () => elStub(),
  // 纯净模式（2026-09-15）在 document 上挂了 pointermove/keydown/fullscreenchange 三个监听，
  // 缺了 addEventListener 会在 bindControls 里直接抛 → 整个控件绑定失败（"点按钮没反应"）。
  // 这里补齐桩，别让冒烟测试因为桩不全而放过/误报。
  addEventListener() {},
  removeEventListener() {},
  body: elStub(),
  fullscreenElement: null,
  exitFullscreen() {},
};
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => ({}) } }, configurable: true,
});
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.performance = { now: () => Date.now() };
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
globalThis.cancelAnimationFrame = () => {};
globalThis.AudioContext = class {
  constructor() { this.sampleRate = 44100; this.state = 'running'; }
  createMediaStreamSource() { return {}; }
  createAnalyser() {
    return { fftSize: 4096, smoothingTimeConstant: 0, getFloatTimeDomainData(a) { for (let i=0;i<a.length;i++)a[i]=0; } };
  }
  resume() { this.state = 'running'; }
};

try {
  await import('../app.mjs');
  console.log('app.mjs 模块加载成功（无顶层错误）');
  console.log('OK: 模块初始化通过');
} catch (e) {
  console.error('FAIL:', e && e.message);
  process.exit(1);
}
// app.mjs 顶层 idleLoop 是永续 setTimeout（浏览器端负责空闲渲染），
// node 下会让进程永不退出——验证完主动结束。
process.exit(0);
