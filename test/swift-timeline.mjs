// ============================================================
// test/swift-timeline.mjs —— SwiftF0 实时喂入时间轴守卫（2026-09-20 新增）
//
// 不需要真的 ONNX：装一个假 ort + 假 fetch 就能把 swiftf0.mjs 的实时链路
// （pushSample → 重采样 → 攒批 → infer → ring → atTime）整条跑起来。
//
// 守的是三个坑（都是真机可感的）：
//   ① 每帧整窗喂入：analyser 滑窗相邻两帧重叠 ~90%，直接拼接会让 16k 时间轴虚增
//      （实测 4096 样本/帧 × 60fps → 5.57× 真实时钟）。本测试断言：喂 3s 音频后，
//      最新帧的时间戳必须落在音频时钟 3s 附近。
//   ② ring 非升序：每次推理重跑整个 seg，时间戳从 segBase 重新覆盖上一轮尾巴，
//      相邻两轮起点只差 93ms 而每轮覆盖 1.02s → 新一段比上一段末帧倒退 ~0.93s，
//      而 atTime() 是二分查找（假设升序）。
//   ③ CHUNK16 攒批判据写成 total16-segBase（裁剪后恒等于 seg.length）→ 每帧都触发
//      整段重算 60 次/秒。断言推理次数贴近 duration/0.25s。
// ============================================================
const ROOT = 'file:///C:/test/ydyi/';
const SR = 44100, FPS = 60, DUR = 3, N = 4096, HOP16 = 256, WIN16 = 8192;
const CHUNK16 = 4096;

// ---- 假 onnxruntime + 假 fetch ----
const calls = [];
class FakeTensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
const fakeOrt = {
  Tensor: FakeTensor,
  env: { wasm: {} },
  InferenceSession: {
    async create() {
      return {
        inputNames: ['input_audio'],
        outputNames: ['pitch_hz', 'confidence'],
        async run(feeds) {
          const t = feeds['input_audio'];
          const L = t.data.length;
          calls.push({ len: L });
          const n = Math.floor(L / HOP16);
          const pitch = new Float32Array(n).fill(440);
          const conf = new Float32Array(n).fill(0.9);
          return { pitch_hz: { data: pitch }, confidence: { data: conf } };
        },
      };
    },
  },
};
globalThis.ort = fakeOrt;
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(32) });

const { swiftKernel } = await import(ROOT + 'dsp/kernels/swiftf0.mjs');

let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

console.log('SwiftF0 实时时间轴守卫（假 ort 驱动真实 pushSample/infer/ring）\n');

await swiftKernel.load();
if (!swiftKernel.ready()) { console.log('  ✗ session 未就绪（假 ort 装载失败）'); process.exit(1); }

// ---- 模拟 app.mjs：每 rAF 一次，喂 analyser 滑窗 + 音频时钟 ----
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = Math.sin(2 * Math.PI * 440 * i / SR);
for (let f = 1; f <= FPS * DUR; f++) {
  swiftKernel.pushSample(win, SR, f / FPS);      // tEnd = recTimeSec()
  await new Promise((r) => setTimeout(r, 0));    // 让异步 infer 完成
}

console.log(`— ① 时间轴不虚增（喂 ${DUR}s 音频，每帧 ${N} 样本 @${FPS}fps）`);
{
  const last = swiftKernel.latestF0();
  const age = last ? DUR - last.t : Infinity;
  console.log(`  最新帧时间戳 t=${last ? last.t.toFixed(3) : 'null'}s（音频时钟 ${DUR}s，差 ${age.toFixed(3)}s）`);
  if (!last) bad('没有任何推理产物');
  else if (!(age >= 0 && age <= 0.3)) bad(`时间戳偏离音频时钟 ${age.toFixed(3)}s（>0.3s 说明时间轴仍被重叠窗灌快）`);
  else ok('时间戳锚在音频时钟上（旧实现此处会到 ~16.7s = 5.57×）');
}

console.log('\n— ② 攒批判据（不得每帧推理）');
{
  const n = calls.length;
  const expect = DUR / (CHUNK16 / 16000);        // 3s / 0.256s ≈ 11.7 次
  console.log(`  推理次数 ${n}（期望 ≈${expect.toFixed(1)} 次；旧实现每帧都触发 ≈${FPS * DUR} 次）`);
  if (!(n >= 4 && n <= expect * 1.8)) bad(`推理次数 ${n} 偏离攒批预期`);
  else ok('攒批生效');
  const over = calls.filter((c) => c.len > WIN16 * 2);
  if (over.length) bad(`${over.length} 次推理输入超过滚窗上限 ${WIN16 * 2}`);
  else ok(`每次输入 ≤ ${WIN16 * 2} 样本（trimToMax 生效，最大 ${Math.max(...calls.map((c) => c.len))}）`);
}

console.log('\n— ③ ring 结构（atTime 二分查找的前提：严格升序 + 随重跑裁剪）');
{
  // 直接查结构指标：只测"取回来的帧序单调"是空断言——实测过，把去重关掉（ring 变 609 帧
  // 的锯齿）后，行为断言（单调 / 无未来帧 / 滞后 ≤15ms）照样全过。故这里断言 ring 自身的
  // 结构：严格升序 + 长度不随推理次数线性增长（不去重时 11 次推理 = 609 帧，去重后 186）。
  const info = swiftKernel._ringInfo();
  console.log(`  ring 长度 ${info.len}（一次推理 ≤64 帧；不去重时 11 次推理会是 609~704 帧）  升序=${info.sorted}`);
  if (!info.sorted) bad('ring 非严格升序（锯齿式重写覆盖，二分查找会取错帧）');
  else if (!(info.len <= 200)) bad(`ring 长度 ${info.len} 未随重跑裁剪（去重失效）`);
  else ok('ring 严格升序且被裁剪到一次推理量级');

  // 行为侧不变量：查询不得取到"未来帧"，滞后 ≤ 一帧量级
  const t1 = info.t1;
  let prevT = -Infinity, mono = true, worst = 0, gap = 0, cnt = 0;
  for (let t = Math.max(0.2, t1 - 1.0); t <= t1; t += 0.004) {
    const r = swiftKernel.atTime(t);
    if (!r) { bad('atTime 返回 null'); break; }
    if (r.t < prevT - 1e-9) mono = false;
    prevT = r.t;
    const a = t - r.t;                        // 应为 0 ~ 一帧(16ms)；负值说明取到了"未来帧"
    if (a < -1e-9) worst = Math.min(worst, a);
    gap = Math.max(gap, a); cnt++;
  }
  console.log(`  探测 ${cnt} 个时间点：帧序 ${mono ? '单调不减 ✓' : '出现回退 ✗'}；最大滞后 ${(gap * 1000).toFixed(1)}ms；未来帧 ${worst < 0 ? '有' : '无'}`);
  if (!mono) bad('atTime 取回的帧序出现回退');
  if (worst < -1e-9) bad(`取到了未来帧（t 差 ${(worst * 1000).toFixed(1)}ms）`);
  if (!(gap < 0.35)) bad(`取帧滞后 ${(gap * 1000).toFixed(0)}ms 过大`);
  if (mono && worst === 0 && gap < 0.35) ok('atTime 无未来帧、滞后 ≤ 一帧量级');
}

console.log('\n— ④ 暂停/冻结时不喂入（时钟不推进 → 无新样本）');
{
  const before = calls.length;
  const tLast = swiftKernel.latestF0().t;
  for (let i = 0; i < 30; i++) swiftKernel.pushSample(win, SR, tLast);   // 时钟冻住
  await new Promise((r) => setTimeout(r, 0));
  const after = swiftKernel.latestF0().t;
  if (calls.length !== before && after > tLast + 0.3) bad('冻结时钟仍推进了时间轴');
  else ok(`冻结 30 帧后时间戳仍为 ${after.toFixed(3)}s（未推进）`);
}

swiftKernel._reset();
if (fail) { console.log(`\n失败 ${fail} 项`); process.exit(1); }
console.log('\n完成。SwiftF0 实时时间轴（喂入去重 / 攒批 / ring 升序 / atTime 取帧）符合预期。');
