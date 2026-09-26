// ============================================================
// dsp/detect.mjs —— 可实例化的逐窗音高检测器（全项目唯一的门控实现）
//
// 门控公式 + 置信状态机 + 中值平滑 + 能量门都在这里，一份实现三处复用：
//   1) 实时检测  app.mjs（ensureDetector 惰性建实例，录音/回放逐窗喂）
//   2) 离线整段分析 dsp/analyze*.mjs（worker 里逐窗跑整段，产出工程帧序列）
//   3) 测试      test/gate-sim.mjs（直接驱动本实现，不再自己复制一份公式）
//
// 历史：app.mjs 曾内联过一份同公式的门控/状态机/平滑(实时侧)，离线侧用本封装，
// 两份代码改口径时容易漏改一边 → 2026-09-06 已统一到本文件(迁移时做过
// 704 帧逐窗等价性验证：voiced 判定零差异、平滑频率零偏差)。
// 改这里 = 同时改实时与离线，勿在别处再写一份公式。
// ============================================================
// 检测内核：从波形算频率候选 + 品质信号（str/purity/prom）。可插拔，
// 见 dsp/kernels/*.mjs。门控公式/状态机/平滑/能量门都在本文件，算法无关。
import { resolveKernel } from './kernels/index.mjs';

// ---- 门控阈值：与 app.mjs gateThresh() 同公式（sens 0 宽松…100 严格）----
export function gateThresh(sensVal) {
  const t = Math.max(0, Math.min(100, sensVal)) / 100;
  return {
    strMax:    0.38 - 0.23 * t,           // 需周期谷值
    purityMin: 0.10 + 0.45 * t,           // 纯音度
    promMin:   6    + 10 * t,             // 峰突出度 dB
    confOn:    0.45,                       // 发声触发置信
    confStep:  0.28 - 0.06 * t,
    dropFrames: 2 + Math.round(2 * t),
    // 中值窗：只滤轻微帧间抖动。爆点(单/双帧大跳)由轨迹级 trackFreq 吸收，
    // 不再依赖大中值窗——窗过大会把刚确认的真跳变(滑音/快吐)稀释回原音。
    smoothK:   2 + Math.round(2 * t),      // 2026-09-10 由 3+4t 缩小：跟随性优先
  };
}

// 能量门：自动(auto，rms>envRms*1.5) / 手动(manual，dbOf(rms)>=effDb)
export const dbOf = (rms) => 20 * Math.log10(rms + 1e-9) + 90;

// 能量门"周期优先豁免"：
// 绝对能量门槛(手动 dB / 标定底噪×1.5)会一刀切滤掉"贴门槛的弱音"——口哨最低音
// C5 常只有 30~40dB，实时被整段滤掉、离线靠桥接+细粒度却补出曲线，观感像两套
// 算法(实为同一 createDetector)。故只要周期证据极强(str 越小越周期)且窗能量高于
// 绝对地板(挡纯静音/数字底噪)，就放行能量；拍桌/白噪 str≥0.7 不受影响，
// 周期门 + 纯度 + 突出度 + 置信状态机依旧在后兜底。
const STRONG_PERIOD_STR = 0.10;   // 谷深 ≤ 此值视为"铁证周期"(纯净口哨≈0.01)
const ENERGY_EARTH_RMS = 2e-4;    // ≈ -24dB：低于此的窗一律视为静音

export function createDetector(opt = {}) {
  const sr = opt.sampleRate || 44100;
  const fmin = opt.fmin ?? 40;
  const fmax = opt.fmax ?? 8000;
  const N = opt.windowSize || 4096;
  const voicing = opt.voicing ?? 85;

  let sens = opt.sens ?? 70;
  let gate = gateThresh(sens);
  // 检测内核（算法后端）：默认 yin-dual；传 opt.kernel 可切换（见 dsp/kernels/）
  const kernel = resolveKernel(opt.kernel);
  // 能量门状态（app 实时侧由校准/滑杆写入；离线侧 setEnergyFloor 自适应）
  let energyMode = opt.energyMode ?? 'auto';   // 'auto' | 'manual'
  let envRms = opt.envRms ?? 0;                // 环境底噪 rms（auto 用）
  let gateDb = opt.gateDb ?? 40;               // manual 门槛 dB
  let energyFloorRms = opt.energyFloorRms ?? 0; // 若有(离线自适应)直接覆盖判定

  // 门控状态机
  let conf = 0, dropCnt = 0, voicedNow = false;
  // 平滑
  const smoothK = () => gate.smoothK;
  let medBuf = [];
  let lastGoodFreq = NaN;
  let lastGoodSemi = NaN;

  // ===== 轨迹级离群抑制（防噪声帧把曲线拽到超高/超低）=====
  // 背景：YIN/MPM/pYIN/SwiftF0 全是逐窗独立判定，单个强噪声窗(拍桌/气音/瞬态)
  // 仍能穿过帧内门控给出离谱频率(如 40Hz 或 8kHz)，而短窗中值滤波对连续数帧
  // 的错误段无能为力。这里的做法是"轨迹级两帧确认"：
  //   - |当前候选 - 已确认平滑值| ≤ JUMP_CENTS → 正常跟随（并清掉待确认态）；
  //   - |偏差| > JUMP_CENTS → 视为跳变，进"待确认缓冲"记方向；连续两帧同向
  //     才采纳为真跳变(滑音/快吐是单调推进的，会被放行)；单帧爆点直接吸收，
  //     维持原轨迹值。
  // 参数可经 createDetector({ jumpCents, jumpFrames }) 覆盖，后续可出 UI 调。
  const jumpCents = opt.jumpCents ?? 220;         // 每帧允许的最大变化(音分)
  const jumpFrames = opt.jumpFrames ?? 2;         // 同向大跳需连续 N 帧确认
  // 音域硬钳（`27.0 <= f <= 4586.0`）：物理可发声范围之外的
  // 频率视为无效(假频/毛刺)，不采入轨迹。默认 A0(27.5Hz)~C8(4186Hz)。
  const freqMin = opt.freqMin ?? 27.5;
  const freqMax = opt.freqMax ?? 4186.0;
  let pending = null;                             // {val, dir, count}
  function trackFreq(freq) {
    if (!Number.isFinite(freq) || !(freq > 0)) { pending = null; return NaN; }
    if (!Number.isFinite(lastGoodFreq) || !(lastGoodFreq > 0)) { pending = null; return freq; }
    const c = 1200 * Math.log2(freq / lastGoodFreq);
    if (Math.abs(c) <= jumpCents) { pending = null; return freq; }   // 正常跟随
    const dir = c > 0 ? 1 : -1;
    if (pending && pending.dir === dir) {
      pending.count++; pending.val = freq;
      if (pending.count >= jumpFrames) { const v = pending.val; pending = null; return v; }
      return lastGoodFreq;                                           // 尚未确认：保持轨迹
    }
    pending = { val: freq, dir, count: 1 };
    return lastGoodFreq;                                             // 单帧爆点：吸收
  }

  // 每窗核心处理（与 app.mjs processOneWindow 等价的单窗版本）
  function processWindow(windowData) {
    const win = windowData.length > N ? windowData.subarray(0, N) : windowData;
    let s = 0;
    for (let i = 0; i < win.length; i++) s += win[i] * win[i];
    const rms = Math.sqrt(s / win.length);

    // 单窗算法判定交内核：产出候选频率 + 品质信号（str/purity/prom）。
    // 内联的 peakTrack/yin/fusePoint 组合已下沉到 dsp/kernels/yin.mjs，
    // 门控公式/状态机/平滑/能量门仍在本函数(算法无关)，纹理数值与原实现逐位一致。
    // 防御：异步/未接入内核(如 SwiftF0 的 frame 占位返回 null)或部分字段缺失时，
    // 一律视为"无声帧"，避免 str/purity/prom 变成 undefined 导致门控比较 NaN 崩。
    const rk0 = kernel.frame(win, sr, { windowSize: N, fmin, fmax, voicing });
    const rk = (rk0 && typeof rk0 === 'object')
      ? { freq: rk0.freq ?? NaN, fA: rk0.fA ?? NaN, fB: rk0.fB ?? NaN,
          prom: rk0.prom ?? 0, purity: rk0.purity ?? 0, str: rk0.str ?? 1 }
      : { freq: NaN, fA: NaN, fB: NaN, prom: 0, purity: 0, str: 1 };
    const fA = rk.fA, prom = rk.prom, purity = rk.purity, fB = rk.fB, str = rk.str;

    const strongPeriod = rk.str <= STRONG_PERIOD_STR && rms > ENERGY_EARTH_RMS;
    const energyOk = strongPeriod || energyOkOf(rms);
    const frameOk = energyOk && str < gate.strMax
                    && purity > gate.purityMin && prom > gate.promMin;

    if (frameOk) { conf = Math.min(1, conf + gate.confStep); dropCnt = 0; }
    else {
      if (voicedNow) { dropCnt++; if (dropCnt >= gate.dropFrames) { voicedNow = false; conf = 0; } }
      else conf = Math.max(0, conf - 0.15);
    }
    voicedNow = voicedNow || (conf >= gate.confOn);

    const voiced = voicedNow;
    // 轨迹级离群抑制：先抑制再平滑（平滑维护 lastGoodFreq，抑制以此为基准）。
    // ⚠ 频率只允许从【本帧自身通过门控(frameOk)】的帧进入轨迹。
    //   voicedNow 是"锁存"值：为容忍瞬时抖动，发声态在连续 dropFrames 个坏帧后才结束。
    //   只看锁存值就采信 rk.freq 的话，锁存期内 frameOk=false 的帧（气声/噪声/拍桌
    //   尾音——恰恰是门控判为"品质不达标"的那些帧）的原始频率照单全收，被写进 medBuf 与
    //   lastGoodFreq。灵敏度调严后 frameOk 变难，可见帧里这种"锁存残余帧"占比急剧升高
    //   （且 confStep 变小、dropFrames 变大都在延长它），而它们的原始频率多是 YIN 在噪声里
    //   抓到的小 τ（高频）→ 平滑中值/最近有效值被高音占满，表现为"无论吹什么音，检测到的
    //   音都是很高的音"。
    //   门控说这帧不可信，就不许它改写轨迹：改为【保持】最近一次有效值（不改轨迹、也不
    //   清空在途跳变确认），既堵住高音污染，又保留原有的"爆点窗被吸收"行为。
    let freqRaw;
    if (!voiced) { pending = null; freqRaw = NaN; }
    else if (frameOk) freqRaw = trackFreq(rk.freq);
    else freqRaw = (Number.isFinite(lastGoodFreq) && lastGoodFreq > 0) ? lastGoodFreq : NaN;
    // 音域硬钳：超物理范围的点不采（对标同类应用，防假频/毛刺上曲线），由 lastGood 桥接保持
    const freq = (Number.isFinite(freqRaw) && freqRaw >= freqMin && freqRaw <= freqMax) ? freqRaw : NaN;
    const out = smooth(freq, voiced, rms);

    return {
      voiced, freq: out.freq,
      prom, purity, str, conf, rms, fA, fB,
      lastGood: out.lastGood, hasGood: out.hasGood,
    };
  }

  function energyOkOf(rms) {
    if (energyFloorRms > 0) return rms > energyFloorRms;   // 离线自适应底噪
    if (energyMode === 'manual') {
      const eff = Math.max(gateDb, envRms > 1e-5 ? dbOf(envRms) : -80);
      return dbOf(rms) >= eff;
    }
    return rms > envRms * 1.5;
  }

  // 中值平滑 + 状态保持（对应 app.updateSmooth 的核心，不含 DOM）
  function smooth(freq, voiced, rms) {
    // freq 必须为正有限数才可入平滑窗：voiced 但内核给出 NaN/非正(理论少见)时
    // 按"未发声"处理并清空平滑窗，避免 NaN 混入中值滤波污染后续帧。
    if (!voiced || !Number.isFinite(freq) || !(freq > 0)) {
      medBuf = [];
      return { freq: NaN, lastGood: NaN, hasGood: false };
    }
    medBuf.push(freq);
    const k = smoothK();
    while (medBuf.length > k) medBuf.shift();
    const sorted = medBuf.slice().sort((a, b) => a - b);
    // ⚠ 偶数窗必须取【两个中间值的平均】，不能取 sorted[len/2]——那是"上中位数"(偏大)。
    //   偏大的中值 + trackFreq 的两帧确认(每 2 帧才放行 1 个候选)会形成单向棘轮：
    //   窗内旧值/候选恒为 1:1 → [低,低,高,高] 取 index2 = 高(升音被拉上去)、
    //   [高,高,低,低] 取 index2 = 高(降音被顶回来) → 表现为"音高只升不降"：
    //   吹低于当前值的音永远回到上一个高音，非得再吹个更高的音才变，然后又卡在那里。
    //   smoothK = 2+round(2t) 在高灵敏档是 4(偶数)、sens=70 时是 3(奇数)，故只有调严才暴露。
    //   取真中位数后升/降对称，阶跃在 ~7 帧内收敛（取上中位则升 2 帧、降 ∞）。
    const mid = sorted.length >> 1;
    const v = (sorted.length & 1) ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    lastGoodFreq = v;
    lastGoodSemi = 69 + 12 * Math.log2(v / 440);
    return { freq: v, lastGood: v, hasGood: true };
  }

  function setSens(v) { sens = v; gate = gateThresh(sens); resetGate(); }
  function setEnergy(o = {}) {
    if (o.mode) energyMode = o.mode;
    if (o.envRms !== undefined) envRms = o.envRms;
    if (o.db !== undefined) gateDb = o.db;
    if (o.floorRms !== undefined) energyFloorRms = o.floorRms;
  }
  function resetGate() { conf = 0; dropCnt = 0; voicedNow = false; medBuf = []; }
  function getGate() { return gate; }

  return {
    processWindow, setSens, setEnergy, resetGate, getGate,
    sr, N, fmin, fmax,
    get lastGoodFreq() { return lastGoodFreq; },
    get lastGoodSemi() { return lastGoodSemi; },
    get gate() { return gate; },
  };
}
