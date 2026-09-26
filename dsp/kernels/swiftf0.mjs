// ============================================================
// dsp/kernels/swiftf0.mjs —— SwiftF0（ONNX 神经网络）检测内核【实时】
//
// 官方：github.com/lars76/swift-f0，覆盖 46.875~2093.75Hz(≈G1~C7)。
// 模型输入就是【原始 16kHz 单声道波形】(`input_audio`, float32 [1,N])，
// STFT/CNN 全在模型内部；输出 2 个数组: pitch_hz, confidence。
// 故这里只需：44.1k→16k 流式重采样 → 滚窗喂模型 → 帧缓存(时间戳+conf)。
//
// 接入状态：
//   load()  加载 vendor/swiftf0/model.onnx + onnxruntime-web(WASM)，session 就绪
//   ready() session 是否可用（未就绪 → 路由自动回退同步内核）
//   pushSample(x44, srcRate, tEndSec) 实时每窗喂入波形（只取新增样本→重采样→累积→块推理，
//            异步不阻塞渲染）。⚠ tEndSec = 本窗末样本的音频时钟时间(秒)，由 app.mjs 传
//            recTimeSec()；不传就只能整窗喂入，重叠窗会让 16k 时间轴虚增数倍（见函数注释）。
//   latestF0() 取最近一次推理产物(带时间戳)，供 route 覆盖/回退
//   atTime(tSec) 按时间轴取最近帧（实时 ring / 离线帧表），供 route 按窗绝对时间精确定位
//   frame() 返回 null：SwiftF0 异步，不直接走同步逐窗契约，由 route 包裹
// 时间轴口径（2026-09-20 修）：ring 的 tSec 锚在【音频时钟】上，与 app.recTimeSec() 同源，
//   且严格升序（atTime 用二分查找）。tSec 若是"自首次 pushSample 起的 16k 计数"，
//   既与录音时钟原点不同源，又因每次重跑整段 seg 而锯齿式回退 → 实时取帧不可靠。
//
// 模型下载（388KB，已 vendor/swiftf0/model.onnx，被 .gitignore 排除）：
//   curl -sL -o vendor/swiftf0/model.onnx \
//     https://cdn.jsdelivr.net/gh/lars76/swift-f0@main/swift_f0/model.onnx
// 运行时：index.html 引入 ./node_modules/onnxruntime-web/dist/ort.all.min.js(UMD→window.ort)，
//   wasm 文件直接指向 node_modules/onnxruntime-web/dist/（本地离线）。
// ============================================================

export const SWIFT_MODEL_URL = 'https://cdn.jsdelivr.net/gh/lars76/swift-f0@main/swift_f0/model.onnx';
export const SWIFT_LOCAL_MODEL = './vendor/swiftf0/model.onnx';
export const SWIFT_RANGE = [46.875, 2093.75];   // 模型硬支持范围：超出回退(route 用)
export const SWIFT_CONF_MIN = 0.6;              // 命中置信门槛：官方 0.9 对该类口哨声系统性过低(实测真实音段 conf 多落 0.3~0.85,76% 被踢回 YIN)→降到 0.6。噪声/低质段已由 route 沿用 fallback 真实周期判据(str)兜底,不会画出假曲线

const SR16 = 16000;        // 模型采样率
const HOP16 = 256;         // 16k 帧移
const WIN16 = 8192;        // 推理滚窗长度(0.5s@16k)，越长越稳、延迟越高
const CHUNK16 = 4096;      // 至少攒这么多 16k 样本才触发一次推理(≈0.25s)
const ORT_WASM_PATH = '/node_modules/onnxruntime-web/dist/';  // 绝对(根)路径：相对路径会被 ort 按其脚本目录再拼一次导致双重目录 404
const RING_MAX = 4000;

// ---------- 流式抗混叠低通 FIR（仅降采样时启用） ----------
// 线性插值重采样本身无抗混叠能力：44.1k→16k 时 >8kHz 的成分（齿音/气声/高频谐波）
// 会几乎全幅折返进模型输入频段，污染 SwiftF0 的置信度。这里用 windowed-sinc
// (汉明窗, 63 抽头) 低通，截止 0.45×toHz(≈7.2kHz)，阻带衰减 ≥50dB。
// 流式设计：维护最近 K-1 个输入样本历史，输出数=输入数（push 分片透明），
// 系数和归一化为 1（直流增益精确 1，kernels-sim 的直流测试不受影响）。
// 代价：恒定群延迟 (K-1)/2=31 个输入样本(≈0.7ms)，对 16ms 帧移的音高时间轴可忽略；
// 每样本 63 次乘加，实时每秒音频约 280 万次，远小于 YIN 本身。
function designAAFir(fromHz, toHz) {
  const K = 63;
  const fc = 0.45 * toHz / fromHz;             // 归一化截止(周期/样本)
  const w = 2 * Math.PI * fc;
  const h = new Float32Array(K);
  let sum = 0;
  for (let i = 0; i < K; i++) {
    const m = i - (K - 1) / 2;
    const s = m === 0 ? 2 * fc : Math.sin(w * m) / (Math.PI * m);
    h[i] = s * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (K - 1)));
    sum += h[i];
  }
  for (let i = 0; i < K; i++) h[i] /= sum;     // 直流增益=1
  return h;
}

// ---------- 流式线性重采样（from→to，先抗混叠 FIR 再线性插值，无状态依赖输出） ----------
// 供实时分窗喂入：push 一段输入，产出"此刻能凑出的整数个输出样本"。
// fromHz<=toHz(升采样)不启用 FIR，行为与旧版逐位一致。
export function makeLinearResampler(fromHz, toHz) {
  const ratio = fromHz / toHz;               // 输入样本 / 输出样本
  let tail = new Float32Array(0);            // 上次未消费的输入尾部
  let nextIn = 0;                            // 下一输出样本在【tail 拼接域起点】的输入坐标(浮点)
  const aa = fromHz > toHz ? designAAFir(fromHz, toHz) : null;
  const aaK = aa ? aa.length : 0;
  let histBuf = new Float32Array(0);         // FIR 历史(最近 aaK-1 个输入样本)
  return {
    push(x) {
      let xin = x;
      if (aa) {
        const hlen = histBuf.length;         // 首次 push 时 < aaK-1，偏移须按实际历史算
        const buf = new Float32Array(hlen + x.length);
        buf.set(histBuf, 0); buf.set(x, hlen);
        xin = new Float32Array(x.length);
        for (let i = 0; i < xin.length; i++) {
          const base = i + hlen;             // 当前样本在 buf 中的位置
          let acc = 0;
          for (let k = 0; k < aaK; k++) {
            const j = base - k;
            acc += aa[k] * (j >= 0 ? buf[j] : 0);   // 起点前补零（视为静音）
          }
          xin[i] = acc;
        }
        const keep = Math.min(aaK - 1, buf.length);
        histBuf = buf.slice(buf.length - keep);
      }
      const t = new Float32Array(tail.length + xin.length);
      t.set(tail, 0); t.set(xin, tail.length);
      const total = t.length;
      // 能输出的样本：其坐标+1 须 < total（线性插值要右邻样本）
      const nOut = Math.floor((total - 1 - nextIn) / ratio) + 1;
      if (nOut <= 0) { tail = t; return new Float32Array(0); }
      const out = new Float32Array(nOut);
      for (let i = 0; i < nOut; i++) {
        const pos = nextIn + i * ratio;
        const lo = Math.floor(pos), fr = pos - lo;
        const a = t[lo], b = t[lo + 1];
        out[i] = a + (b - a) * fr;
      }
      // 保留未消费尾部(从下一输出样本的 lo 起，多留 2 样本避免插值越界)
      const nextLo = Math.floor(nextIn + nOut * ratio);
      const keep = Math.max(0, total - nextLo) + 2;
      tail = (keep >= total) ? t : t.subarray(total - keep);
      nextIn = Math.max(0, nextLo - (total - tail.length));
      return out;
    },
    reset() { tail = new Float32Array(0); nextIn = 0; histBuf = new Float32Array(0); },
  };
}

// ---------- 内核状态 ----------
let session = null;          // ort.InferenceSession
let seg = new Float32Array(0);   // 16k 滚窗缓冲（带绝对起点）
let segBase = 0;             // seg[0] 对应的绝对 16k 样本序号（模拟绝对时钟）
let total16 = 0;             // 已喂入的 16k 样本总数（只数【新增】样本，见 pushSample）
let fedEndT = null;          // 已喂入音频【末尾】对应的音频时钟时间(秒)，来自 pushSample 第 3 参
let lastInferIdx = 0;        // 上次真正发起推理时的 total16（CHUNK16 攒批基线）
let inferring = false;
const ring = [];             // {tSec, f, conf}，严格按 tSec 递增（实时流，见 infer 的单调化）
let offlineFrames = null;    // 离线整段推理结果 {tSec,f,conf}[]（独立于 ring，避免与实时串扰）
let res = makeLinearResampler(44100, SR16);   // 默认 44.1k→16k；bindRate 可按需重建
let resFrom = 44100;
let inputName = 'input_audio';

function bindRate(sr) {
  if (!(sr > 0) || sr === SR16 || sr === resFrom) return;
  resFrom = sr;
  res = makeLinearResampler(sr, SR16);
}

function trimToMax() {
  const max = WIN16 * 2;
  if (seg.length <= max) return;
  const drop = seg.length - max;        // 裁掉头部多少样本 → 窗口起点相应前移
  seg = seg.subarray(drop);
  segBase += drop;
}

async function infer() {
  if (inferring || !session) return;
  const w = new Float32Array(seg);              // 拷贝，避免 ort 视图/ArrayBuffer 语义坑
  const base = segBase;                          // 本窗绝对起点(16k样本)
  const endIdx = total16;                        // 本窗最后一个样本的绝对序号
  const endT = fedEndT;                          // 它与【音频时钟】的对齐点（await 前取本地副本）
  inferring = true;
  lastInferIdx = endIdx;                         // 攒批基线：下次等再攒够 CHUNK16 个新样本
  try {
    const tensor = new ort.Tensor('float32', w, [1, w.length]);
    const feeds = {}; feeds[inputName] = tensor;
    const outs = await session.run(feeds);
    const names = session.outputNames;
    const pitch = outs[names[0]].data;          // [0]=pitch_hz
    const conf = outs[names[1]].data;           // [1]=confidence
    const n = Math.min(pitch.length, conf.length);
    const frames = [];
    for (let i = 0; i < n; i++) {
      const idx = base + i * HOP16;
      // 帧时间戳锚在【音频时钟】上（与 app.recTimeSec() 同一条时间轴）：
      // 若用 (base+i*HOP16)/SR16 = 自"首次 pushSample"起的 16k 计数，则与录音时钟原点
      // 不同源；再叠加"每次 push 都喂整段重叠窗"导致的时间轴虚增(实测 5.57×)，
      // route 拿 recTimeSec() 经 atTime() 去查这张表必然对不上。
      // endT 缺失(旧调用方)时退回旧的绝对计数口径，保证行为可预期。
      const t = (endT === null) ? idx / SR16 : endT - (endIdx - idx) / SR16;
      frames.push({ t, freq: pitch[i], conf: conf[i] });
    }
    if (frames.length) {
      // 单调化：每次推理都是【重跑整个 seg】，时间戳从 segBase 重新覆盖上一轮的尾巴。
      // 直接 append 会让 ring 变锯齿（实测相邻两轮起点只差 93ms，而每轮覆盖 1.02s
      // → 新一段首帧的 t 比上一段末帧倒退 0.93s），而 atTime() 用二分查找（假设升序）
      // → 实时取帧不可靠。故先丢弃 ring 中 t >= 本次首帧 的旧帧，再追加，ring 恒严格升序。
      const t0 = frames[0].t;
      while (ring.length && ring[ring.length - 1].t >= t0) ring.pop();
      for (const fr of frames) ring.push(fr);
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    }
  } catch (e) {
    console.error('[swiftf0] 推理失败:', e && e.message || e);
  } finally { inferring = false; }
}

export const swiftKernel = {
  id: 'swiftf0',
  name: 'SwiftF0（ONNX）',
  hidden: true,          // 不单独出现在下拉；由 route-swift-yin 包裹使用
  async: true,

  ready() { return !!session; },

  async load() {
    if (session) return true;
    if (typeof globalThis.ort === 'undefined') {
      try {
        // 主线程由 index.html 的 <script src=ort.all.min.js> 提供 window.ort 全局；
        // 离线 Web Worker(module) 没有 UMD 全局 → 直接 ESM 动态导入 dist 的 ort.all.min.mjs。
        const mod = await import('../../node_modules/onnxruntime-web/dist/ort.all.min.mjs');
        globalThis.ort = { InferenceSession: mod.InferenceSession, Tensor: mod.Tensor, env: mod.env };
      } catch (e2) {
        throw new Error('onnxruntime-web 未加载：主线程需引入 ort.all.min.js，Worker 动态导入亦失败: ' + (e2 && e2.message || e2));
      }
    }
    const r = await fetch(SWIFT_LOCAL_MODEL, { cache: 'no-store' });
    if (!r.ok) throw new Error('SwiftF0 模型缺失：' + SWIFT_LOCAL_MODEL + '（下载命令见 swiftf0.mjs 注释）');
    const buf = await r.arrayBuffer();
    ort.env.wasm.wasmPaths = ORT_WASM_PATH;
    session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    inputName = session.inputNames[0] || 'input_audio';
    return true;
  },

  // 实时每窗喂入波形：只喂【新增样本】→ 重采样 → 滚窗累积 → 攒够即异步推理（不阻塞渲染）。
  //   x44     : analyser 的滑窗（最近 fftSize 个 44.1k 样本，每 rAF 读一次 → 相邻窗重叠约 90%）
  //   srcRate : 源采样率
  //   tEndSec : 【可选】x44 末样本对应的音频时钟时间(秒)，由 app.mjs 传 recTimeSec()。
  //     ⚠ 必须传：否则只能整窗喂入，重叠的部分会重复进入 16k 流，时间轴按重叠倍数虚增
  //     （实测每帧 4096 样本 / 60fps → 16k 时间轴 5.57× 真实时钟，ring 时间戳随之报废，
  //      route 的 atTime 取帧必然错）。未传（旧调用方/测试）则退回整窗喂入的旧行为。
  pushSample(x44, srcRate, tEndSec) {
    if (!session) return;
    try {
      if (typeof srcRate === 'number' && srcRate > 0) bindRate(srcRate);
      let xin = x44;
      if (typeof tEndSec === 'number' && Number.isFinite(tEndSec)) {
        if (fedEndT !== null) {
          const srIn = (typeof srcRate === 'number' && srcRate > 0) ? srcRate : 44100;
          let nNew = Math.round((tEndSec - fedEndT) * srIn);   // 距上次喂入真正新增的样本数
          if (!(nNew > 0)) return;                              // 时钟未推进(暂停/冻结) → 无新样本
          if (nNew > x44.length) nNew = x44.length;             // 掉帧/节流后拉长：只喂窗口里真有的
          xin = x44.subarray(x44.length - nNew);                // 新增样本恒在滑窗尾部
        }
        fedEndT = tEndSec;                                      // 无论截多少，末尾都对应 tEndSec
      }
      const a16 = res.push(xin);
      if (!a16 || !a16.length) return;
      const t = new Float32Array(seg.length + a16.length);
      t.set(seg, 0); t.set(a16, seg.length);
      seg = t;
      total16 += a16.length;
      trimToMax();
      // 自【上次真正推理】起再攒够 CHUNK16(≈0.25s) 才触发（infer 内会去重）。
      // ⚠ 判据必须用 total16-lastInferIdx：旧写法 total16-segBase 在裁剪后恒等于 seg.length
      //   (=16384 ≥ CHUNK16) → 每帧都触发、整段重算 60 次/秒，把 CHUNK16 的攒批本意写空了。
      if (total16 - lastInferIdx >= CHUNK16) infer();
    } catch (e) { console.error('[swiftf0] pushSample 失败:', e); }
  },

  // 最近一次推理产物（替换 route 里的 feedPrimary 语义；较新帧优先）
  latestF0() { return ring.length ? ring[ring.length - 1] : null; },

  // 按时间轴取最近帧(t<=tSec)；离线整段结果优先（route 离线模式经 setWindowTime 精确取帧，
  // 实时模式无人调用 setWindowTime → 走 latestF0）。若无则退最新。
  atTime(tSec) {
    const arr = (offlineFrames && offlineFrames.length) ? offlineFrames : ring;
    if (!arr.length) return null;
    if (tSec === undefined || tSec === null) return arr[arr.length - 1];
    let lo = 0, hi = arr.length - 1;
    if (tSec >= arr[hi].t) return arr[hi];
    if (tSec <= arr[0].t) return arr[0];
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (arr[mid].t <= tSec) lo = mid; else hi = mid; }
    return arr[lo];
  },

  // 离线整段推理：16k 波形分块(每块≈30s)逐块 session.run 得全段帧（含 warmup 片即所见全段）。
  // 用独立重采样器，不动实时流式 res 状态；任一块失败返回 null（由路由回退 YIN）。
  // onTick: 可选 {done,total} 按 16k 样本数上报推理进度（与 analyzePCM 的窗进度单位不同，仅作比例）。
  async runOffline(pcm, srcRate, onTick = null) {
    if (!session || !pcm || !pcm.length) return null;
    try {
      let a16 = pcm;
      if (srcRate !== SR16) a16 = makeLinearResampler(srcRate, SR16).push(pcm);
      if (!a16 || !a16.length) return null;
      const BLK = 30 * SR16;              // 30 秒一块
      const frames = [];
      let prevTail = null;                // 上一块末尾(供残块补窗上下文)
      let reported = 0;
      for (let s = 0; s < a16.length; s += BLK) {
        let end = Math.min(s + BLK, a16.length);
        let chunk = a16.subarray(s, end);
        let base = s;                     // 本块输出帧0 的绝对 16k 索引起点
        if (chunk.length < WIN16 && prevTail) {        // 尾部残块：借上一块尾补足一窗上下文
          const need = WIN16 - chunk.length;
          const head = prevTail.subarray(prevTail.length - need);
          chunk = new Float32Array(WIN16);
          chunk.set(head, 0); chunk.set(a16.subarray(s, end), need);
          base = s - need;
        }
        const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
        const feeds = {}; feeds[inputName] = tensor;
        const outs = await session.run(feeds);
        const names = session.outputNames;
        const pitch = outs[names[0]].data;
        const conf = outs[names[1]].data;
        const n = Math.min(pitch.length, conf.length);
        for (let i = 0; i < n; i++) {
          const tSec = (base + i * HOP16) / SR16;
          if (tSec < 0) continue;          // 残块补窗引入的负时间帧丢弃
          frames.push({ t: tSec, freq: pitch[i], conf: conf[i] });
        }
        prevTail = chunk;
        if (onTick) {
          const done = Math.min(a16.length, s + BLK);
          if (done - reported >= Math.max(4096, a16.length >> 6)) { reported = done; onTick({ done, total: a16.length }); }
        }
      }
      if (onTick) onTick({ done: a16.length, total: a16.length });
      offlineFrames = frames;
      return frames;
    } catch (e) {
      console.error('[swiftf0] runOffline 失败:', e && e.message || e);
      return null;
    }
  },

  _clearOffline() { offlineFrames = null; },

  // 仅供测试/诊断：ring 的结构指标（不暴露帧数据本身）。
  // sorted=false → ring 被"重跑整段"的锯齿式追加破坏，atTime 的二分查找前提不成立；
  // len 远大于一次推理的帧数 → 说明没做去重裁剪（每次重跑都整段重放）。
  // test/swift-timeline.mjs 用这两条守 atTime 的正确性前提。
  _ringInfo() {
    let sorted = true;
    for (let i = 1; i < ring.length; i++) if (!(ring[i].t > ring[i - 1].t)) { sorted = false; break; }
    return {
      len: ring.length,
      t0: ring.length ? ring[0].t : NaN,
      t1: ring.length ? ring[ring.length - 1].t : NaN,
      sorted,
    };
  },

  // 离线帧表注入：主线程预推理结果传进 worker/单线程后，直接喂给离线槽位，
  // 免去 worker 内再建 session/推理（worker 环境不稳定，主线程 session 已确认可用）。
  _injectOffline(frames) { offlineFrames = Array.isArray(frames) ? frames : null; },

  _reset() { session = null; seg = new Float32Array(0); segBase = 0; total16 = 0; fedEndT = null; lastInferIdx = 0; ring.length = 0; offlineFrames = null; res.reset(); },

  // 同步契约占位：SwiftF0 异步，不经此路（route 用 latestF0 覆盖）
  frame() { return null; },
};

export default swiftKernel;