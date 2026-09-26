// ============================================================
// dsp/notes-hmm.mjs —— 音符级 HMM 解码器（离线核心 + 在线解码器）
//
// 定位：把「帧级音高轨迹」解码成「音符序列」。
//
// 与项目现有做法的根本差别：
//   现有 echo/钢琴块 = 逐帧局部判据 + 阈值（包络谷深、音高偏离、谱通量…），
//     每个决策只看局部证据，判据之间要互相打补丁；
//   本模块 = 序列级全局最优：在整段观测下找概率最大的那条「音符状态路径」
//     （Viterbi）。「该不该在这里切」由此变成「哪种音符序列整体更合理」。
//
// 三个先天歧义在这里的解法（文献公认这三条无法靠局部判据区分）：
//   ① 强颤音跨格 → 「留在同一音」零代价，切换要付 lambda → 颤音不碎成两个音
//   ② 整段调音偏移 → estimateTuningShift 先估 δ 再解码（把格线挪到人身上）
//   ③ 无缝滑音/尾音衰减 → 「换音要付 lambda + mu×距离」= 奥卡姆剃刀：
//     收益小的那一刀不划算；而纯八度离群帧因距离惩罚极贵被吸收
//
// 观测维度（两个，各自独立）：
//   · 音高：以 frameWeight 加权的距离似然（高 str 噪声帧不提供音高信息）
//   · 气口：以 env（细粒度包络）算出的「谷深」强度 q 计（见 envGatePoints 头注——
//     这是本项目唯一在真实录音上验收过的气口判据，也是"同音快吐"的唯一线索）
//
// 参数刻意保持少，且每个都有明确物理含义：
//   sigma        0.5   音高抖动尺度(半音)：观测似然的宽度。0.5 ≈ 容忍 ±50 音分
//   lambda       4.0   状态切换基础代价：切换越少越优（= 音符数成本）
//   mu           0.5   每半音距离代价：相邻音便宜（滑音）、八度跳贵（离群）
//   silenceCost  1.0   未发声帧「仍停在音高状态」的每帧代价
//                      → 与 lambda 共同决定气口容忍长度 ≈ 2·lambda/silenceCost 帧
//   obsCap       3.0   单帧观测对数似然下限：防离群帧凭"距离极远"独裁。
//                     也是「离群帧会不会把音符切断」的开关：保持 n 帧的代价 n·obsCap
//                     与断开的代价 2·lambda + n·silenceCost 比较 → 默认下 1~2 帧离群仍保持
//   gatePen      6.0   气口证据权重：气口帧(q→1)把「保持音高」推贵、「停在无音」推便宜。
//                     单帧气口要 q>0.75 才切得开、两帧 q>0.42、三帧 q>0.31
//                     → 「深度 × 宽度」自然权衡：浅抖不动、真气口切开
//   presencePen  6.0   发声「存在性」权重：可信发声帧压制「无音」状态（只压 NONE，
//                     绝不惩罚音高状态）。没有它，短音（3~5 帧）付不起 2λ 的进出代价
//                     → 整段被判无音（实测 hmm=0 块）
//   minNoteMs    30    最短音符时长(ms)。⚠ 不能用回声的 ECHO_MIN_MS=50 口径：
//                     快吐的音本体只有 40~60ms，50 会把它们整批滤掉（实测召回 0.92→0.74）
//   —— 气口画像参数（envGatePoints / annotateGates；数值由 6 段真实录音网格实测选定）——
//   gateWinMs    100   显著度窗口(ms)：峰值只在此窗内找 → 慢速强弱起伏不登记（关键）
//   gateThrDb    12.0  谷深阈值(dB)。⚠ 不是 grain 的 ENV_SPLIT_DB=3（那个从未真正生效过）；
//                     实测 12dB 最优（F1 0.81 / 召回 0.92，3dB 只有 0.78）
//   gateRefDb    18.0  深度映射上限：12dB→q=0、15dB→q=0.5、≥18dB→q=1
//   gateFootDb   3.0   谷"脚下"范围(dB)：低于 min+此值的点都属于该气口 → 宽度进证据
//   gateSettleMs 200   气口定案窗(ms)：右侧峰未被下降确认前不定案
//   gateTolMs    12    帧↔气口点的时间容差(ms)
//   frameLagMs   46    帧时间戳相对其"代表的音频时刻"的偏移(ms)。
//                     真机帧戳=检测窗末尾(93ms 窗)，该帧代表的音频中心在其前方约半窗
//                     → 由 app/echo.mjs 传入 46；离线"帧戳即音频时刻"时传 0。
//                     实测 46 明显优于 0 / −46（F1 0.813 vs 0.751 vs 0.798）
// 另有两个可选开关：
//   estimateShift false  先估调音偏移再解码
//   prior         null   音高先验 Map<midi, 对数权重>（调内音阶/音高直方图的接入点）
//
// 接口（纯函数、无副作用、不 import 任何项目模块）：
//   frames = [{ t, midi, voiced?, str?, weight?, gate? }]
//     t      毫秒时间戳（任意基准，需单调递增）
//     midi   浮点 MIDI 音高（voiced=false 时可给 NaN）
//     voiced 布尔；缺省 = Number.isFinite(midi)
//     str    周期强度（越小越可信，量纲见 dsp/core.mjs：纯音≈0.004，白噪≈0.9）
//     weight 直接给「这帧多可信」0..1（覆盖 str 推导）
//     gate   气口强度 0..1（由 annotateGates 从 env 生成；缺省=0 不启用气口维度）
//   返回 { notes: [{t0, t1, midi}], shift, cands, states, loglik, rawCount }
//     notes 与 app/echo.mjs 的 echoNotes、pianoBlocks 的分段结果同构
// ============================================================

export const HMM_DEFAULTS = {
  sigma: 0.5,
  lambda: 4.0,
  mu: 0.5,
  silenceCost: 1.0,
  obsCap: 3.0,
  gatePen: 6.0,           // 气口证据权重（取代旧的帧级 rms 能量维度，见 envGatePoints 头注）
  presencePen: 6.0,       // 发声"存在性"权重：可信发声帧压制「无音」状态（见 buildObs 头注）
  minNoteMs: 30,          // 最短音符(ms)。⚠ 不能用回声的 ECHO_MIN_MS=50 口径：快吐的音本体
                          //   只有 40~60ms，50 会把它们整批滤掉（6 段真实录音实测：
                          //   召回 0.92→0.74）。真音最短≈一个检测窗的说法只在"检测器主导
                          //   分段"的 grain 档成立；本档边界由包络气口定，可以更短。
  strScale: 0.3,          // str 达到此值算「完全不可信」(口哨/带噪纯音应 <0.25)
  gateWinMs: 100,         // 显著度窗口(ms)：峰值只在 ±此窗内找 → 慢速强弱起伏不登记（关键）
  gateThrDb: 12.0,        // ⚠ 不是 grain 的 ENV_SPLIT_DB=3——那是"从未真正生效过"的值
                          //   （真实包络里它算出的深度恒 0.5dB）。6 段真实录音网格实测
                          //   12dB 最优（F1 0.81 / 召回 0.92，3dB 只有 F1 0.78）：
                          //   3~9dB 的浅谷多是衰减尾巴与抖动，不是吐音闭合。
  gateRefDb: 18.0,        // 深度映射上限(thr+6)：12dB→q=0、15dB→q=0.5、≥18dB→q=1
  gateFootDb: 3.0,        // 谷"脚下"范围(dB)：低于 min+此值的点都属于该气口 → 宽度进证据
  gateSettleMs: 200,
  gateTolMs: 12,
  frameLagMs: 0,
  estimateShift: false,
  prior: null,
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function isVoiced(f) {
  if (f.voiced === false) return false;
  return Number.isFinite(f.midi);
}

// 这一帧的「可信度」0..1：str 越小越可信；显式 weight 优先
function frameWeight(f, o) {
  if (Number.isFinite(f.weight)) return clamp01(f.weight);
  if (Number.isFinite(f.str)) return clamp01(1 - f.str / o.strScale);
  return 1;
}

// —— 调音偏移估计 ——
// 现象：很多人吹口哨/清唱整段统一偏低或偏高（如偏低 40 音分），而 MIDI 格线固定在
// A4=440 的等分位置 → 音高一直贴在下半格，稍一抖就翻面，看着"乱飘"。
// 这不是检测不准，是参照系没对齐：先统计「所有音高到最近格的有符号偏差」的中位数 δ，
// 解码时用 midi − δ 去对齐格线，输出时再加回 δ。
export function estimateTuningShift(frames) {
  const fracs = [];
  for (const f of frames || []) {
    if (!isVoiced(f)) continue;
    fracs.push(f.midi - Math.round(f.midi));      // ∈ [-0.5, 0.5]
  }
  if (!fracs.length) return 0;
  fracs.sort((a, b) => a - b);
  const n = fracs.length;
  // 真中位数（偶数取两中值平均；不做上中位数，避免任何单向偏移）
  const d = n % 2 ? fracs[(n - 1) >> 1] : (fracs[n / 2 - 1] + fracs[n / 2]) / 2;
  return d;
}

// ============================================================
// —— 细粒度包络 → 气口强度 q(t) ——
//
// 为什么必须用 env、而不是帧级 rms（两轮真机失败换来的教训）：
//   ① 帧级 rms 在 93ms 检测窗里被平均抹平 —— 真机上「口哨单吐三个」整段 600ms 的
//      发声帧里，三个音之间的气口**完全不存在**：没有 voiced 翻转、没有能量下降、
//      音高也不变（逐帧 dump 实证）。拿帧级 rms 判气口 = 在一个已被抹平的量上判。
//   ② 即便能量还在，「绝对能量」这个维度本身也不对：它把"吹奏自身的强弱起伏"
//      当成气口 → 实测某段真实录音被判成 27 块（grain 档同素材只有 9 块）。
//   所以只能用 env（细粒度包络）。但**深度量本身也得换**：grain/classic 的
//   refreshEchoCuts 用的是「相邻爬坡峰」（从谷底向两侧走，走到不再上升为止），
//   而真实包络在谷底有 ±1~2dB 逐点抖动 → 上爬在第一个相邻点就停 → 口径退化成
//   "拿相邻点当峰" → 深度恒 0.5dB 左右。2026-09-19 实测：口哨单吐三个的谷底
//   walk=0.5dB / prom=32.0dB —— **真值 32dB 的气口被全数漏掉**，
//   也就是说项目里那条"包络谷切分"在真实录音上基本没生效过（grain 的块其实来自
//   voiced 翻转与音高切分）。故本模块用「窗口显著度」(prominence)。
//
// 独立实现（本模块零依赖，且 grain/classic 的代码一行不许碰）；与"环境判据"的差别：
//   深度量 = 窗口显著度而非相邻爬坡峰（见上）
//   去重（真机 recEnv 是重叠窗累积的，同一时刻会被重复推入）
//   定案窗按 ms 而非点数（点数受重复推入影响，口径不稳）
// 数值（gateThrDb 12dB 等）由 6 段真实录音网格实测选定，见 HMM_DEFAULTS。
// ============================================================
export function envGatePoints(env, opts) {
  const o = { ...HMM_DEFAULTS, ...(opts || {}) };
  const pts = [];
  if (!Array.isArray(env) || env.length < 8) return pts;

  // 1) 去重：同一时刻被多帧重复推入 → 合并（同采样点算出的 rms 相同，取最后一个）
  const byT = new Map();
  for (const p of env) {
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.rms) || p.rms <= 0) continue;
    byT.set(p.t, p.rms);
  }
  const a = [...byT.entries()].map(([t, rms]) => ({ t, rms })).sort((x, y) => x.t - y.t);
  if (a.length < 8) return pts;

  // 2) 定案边界：右侧峰未被"下降"确认之前不做判定（否则切点随新数据反复变化）
  const tEnd = a[a.length - 1].t;
  let hi = a.length - 1;
  while (hi > 1 && tEnd - a[hi].t < o.gateSettleMs) hi--;

  // 3) 局部极小 + 显著度(prominence) 谷深
  // ⚠⚠ 为什么不用 refreshEchoCuts 那套「相邻爬坡峰」(pl/pr 单调上爬)：
  //   真实包络在谷底有 ±1~2dB 的逐点抖动，上爬在第一个相邻点就停 → 口径退化成
  //   "拿相邻点当峰" → 深度恒 0.5dB 左右 → **真值 32dB 的气口被全数漏掉**
  //   （2026-09-19 实测：口哨单吐三个的谷底 walk=0.5dB / prom=32.0dB）。
  //   这就是"项目里包络谷切分在真实录音上基本没生效过"的原因。
  //   显著度 = min(左窗最大, 右窗最大) / 本点，窗口只取 ±gateWinMs：
  //   · 单调升降的斜坡上 → 一侧窗的最大就是本点自己 → 深度恒 0（不登记任何斜坡）
  //   · 慢速强弱起伏(比如 1 秒的渐强渐弱) → 窗内峰只比本点高几 dB → 低于阈值(不误切)
  //   · 真气口 → 两窗峰都在附近(±100ms 内) → 深度 = 真实落差(20~32dB)
  const m = new Map();                      // t → q（嵌套极小值时取最深的那条）
  for (let i = 2; i < hi - 1; i++) {
    if (!(a[i].rms < a[i - 1].rms && a[i].rms <= a[i + 1].rms)) continue;
    let L = a[i].rms, R = a[i].rms;
    for (let j = i; j >= 0 && a[i].t - a[j].t <= o.gateWinMs; j--) if (a[j].rms > L) L = a[j].rms;
    for (let j = i; j < hi && a[j].t - a[i].t <= o.gateWinMs; j++) if (a[j].rms > R) R = a[j].rms;
    const depth = 20 * Math.log10(Math.min(L, R) / a[i].rms);
    if (!(depth >= o.gateThrDb)) continue;
    const q = clamp01((depth - o.gateThrDb) / Math.max(1e-6, o.gateRefDb - o.gateThrDb));
    // 谷"脚下"（低于 min+gateFootDb 的点）都属于这个气口 → 宽度自然进入证据：
    // 单点抖动只给 1~2 个点(窄)，真气口给一串点(宽)，由 gatePen 统一权衡深度×宽度。
    // 上界只由电平定（不再受"峰在哪"影响），并夹在定案区内。
    const lim = a[i].rms * Math.pow(10, o.gateFootDb / 20);
    let lo = i; while (lo > 0 && a[lo - 1].rms < lim) lo--;
    let hh = i; while (hh < hi - 1 && a[hh + 1].rms < lim) hh++;
    for (let j = lo; j <= hh; j++) { const p = m.get(a[j].t); if (p === undefined || q > p) m.set(a[j].t, q); }
  }
  for (const [t, q] of m) pts.push({ t, q });
  pts.sort((x, y) => x.t - y.t);
  return pts;
}

// 把气口强度写进帧（原地写 f.gate，返回同一数组）。
// 每帧取「t − frameLagMs ± gateTolMs」内的最大 q。
// ⚠ frameLagMs 的意义：真机帧戳=检测窗**末尾**，而它代表的音频中心在窗内中点
//   （4096 窗 @44.1k → 约 46ms 前）→ 不校正的话气口证据会整体错位半窗，
//   可能落到相邻帧上而对不齐它该切开的那个音。离线按"帧戳即音频时刻"喂时传 0。
export function annotateGates(frames, env, opts) {
  const o = { ...HMM_DEFAULTS, ...(opts || {}) };
  if (!Array.isArray(frames) || !frames.length) return frames;
  const pts = envGatePoints(env, o);
  if (!pts.length) return frames;
  // 查表半宽：至少 gateTolMs，且不小于「本帧自身的半跨度」——这样相邻帧的查表窗首尾相接，
  // **任何气口点都不会掉在窗与窗之间**。真机帧步 33ms 时固定 ±12ms 会让 40ms 的气口
  // 有相当概率正好落在两帧之间 → 该切的地方反而拿不到证据（帧率相关的另一个坑）。
  const dts = frameDts(frames);
  let p = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!Number.isFinite(f.t)) continue;
    const half = Math.max(o.gateTolMs, dts[i] * 16.7 / 2);
    const lo = f.t - o.frameLagMs - half, hi = f.t - o.frameLagMs + half;
    while (p < pts.length && pts[p].t < lo) p++;
    let q = 0;
    for (let k = p; k < pts.length && pts[k].t <= hi; k++) if (pts[k].q > q) q = pts[k].q;
    f.gate = q;
  }
  return frames;
}

// —— 候选音高格 ——
// 用分位数而不是 min/max：离群帧（八度跳错）不该把候选集合撑宽。
// 候选是整数 MIDI 格（对齐后的域）。
function buildCands(frames, shift, o) {
  const ms = [];
  for (const f of frames) {
    if (!isVoiced(f)) continue;
    // ⚠ 不可信的帧（高 str 噪声）不得定义候选音高格：否则候选集合被噪声音高撑开，
    //   而"中立"的噪声帧会让 Viterbi 在平局里停在最低候选上 → 出一个噪声音高的假块
    //   （实测静音期噪声帧出 1 块 midi=59）。
    if (frameWeight(f, o) < 0.3) continue;
    ms.push(f.midi - shift);
  }
  if (!ms.length) return [];
  ms.sort((a, b) => a - b);
  const q = (p) => ms[Math.min(ms.length - 1, Math.max(0, Math.round(p * (ms.length - 1))))];
  const lo = Math.round(q(0.02)) - 1, hi = Math.round(q(0.98)) + 1;
  const out = [];
  for (let m = Math.max(0, lo); m <= Math.min(127, hi); m++) out.push(m);
  return out;
}

// 帧步长中位数（音符收尾 t1 用；缺省 0 表示按末帧时刻收尾）
function estimateStep(frames) {
  const d = [];
  for (let i = 1; i < frames.length; i++) {
    const v = frames[i].t - frames[i - 1].t;
    if (v > 0) d.push(v);
  }
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  const n = d.length;
  return n % 2 ? d[(n - 1) >> 1] : (d[n / 2 - 1] + d[n / 2]) / 2;
}

// —— 每帧的「时间权重」dt = 本帧跨度 / 参考步(16.7ms) ——
// ⚠⚠ 所有**逐帧**代价（silenceCost / presencePen / gatePen）都必须乘 dt，否则模型只在
//   建模时的那个帧率下成立。真机 recordRecFrame 有 **30ms 节流**（帧步≈33ms），
//   同一个 40ms 气口在 16.7ms 下拿到 2~3 帧证据、在 33ms 下只有 1 帧 → **气口证据减半**
//   → 阈值型判决在阈值附近整片翻面（实测同一素材块数 33→11、80→34、51→23）。
//   lambda / mu 是「状态切换」代价：一次切换付一次，与帧率无关，**不缩放**。
function frameDts(frames) {
  const def = estimateStep(frames) || 16.7;
  const out = new Float64Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 0;
    const prev = i > 0 ? frames[i].t - frames[i - 1].t : 0;
    const d = next > 0 ? next : (prev > 0 ? prev : def);
    out[i] = Math.min(4, Math.max(0.25, d / 16.7));
  }
  return out;
}

// 观测对数似然矩阵 obs[t*K + k]
// 末位状态 k = cands.length 为 NONE（无音）
function buildObs(frames, cands, shift, o) {
  const T = frames.length, K = cands.length + 1, NONE = K - 1;
  const obs = new Float64Array(T * K);
  const inv = 1 / (2 * o.sigma * o.sigma);
  const priorOf = (m) => (o.prior && typeof o.prior.get === 'function' ? (o.prior.get(m) || 0) : 0);
  const dts = frameDts(frames);
  for (let t = 0; t < T; t++) {
    const f = frames[t], base = t * K;
    const voiced = isVoiced(f);
    const dt = dts[t];                       // 本帧跨度权重（见 frameDts 头注）
    const sc = o.silenceCost * dt;           // 未发声仍停在音高状态的每帧代价（按时间归一）
    // 气口证据（来自 env，见 envGatePoints）：对「保持音高」加贵、对「停在无音」减价。
    // 注意是**对称**加减 → 等价于把"音高 vs 无音"的差距拉开 2·gatePen·dt·q。
    const q = Number.isFinite(f.gate) ? clamp01(f.gate) : 0;
    const gp = o.gatePen * q * dt;
    if (!voiced) {
      // 未发声：停在音高状态付 silenceCost(+气口)；停在 NONE 基本免费。
      // → 短掉帧（总时长 < 2·lambda/silenceCost ≈ 134ms）会被桥接，长静音才断开。
      for (let k = 0; k < NONE; k++) obs[base + k] = -sc - gp;
      obs[base + NONE] = gp;
      continue;
    }
    const w = frameWeight(f, o);
    const m = f.midi - shift;
    // ⚠⚠ **音高项要按可信度 w 插值**，不能只缩放"音高距离项"：
    //   距离≈0 时 -w·0 = 0 与可信度无关 → 高 str 的噪声帧只要检测给的 midi 落在格子上，
    //   观测代价就是 0、跟真音一样"好"；而 NONE 的代价不随 w 缩放反而更贵 →
    //   噪声帧被判成音高 → **明明没声音却出块**（实测静音期噪声帧出一个 2 秒假块）。
    //   w→0 时音高项归零 = 该帧对"音高"完全中立，路径交给邻帧决定。
    // ⚠ 气口项 -gp 必须留在 w **之外**：它是独立观测维度（来自 env 的能量形状），
    //   可靠性跟"音高可信度"无关。若一起被 w 归零，噪声帧就变成"完全中立"→
    //   Viterbi 在平局里任选一个状态、再靠保持代价一直待着 → 照样出假块。
    // ⚠ 音高项也按 dt 缩放：观测似然在时间上是"率"，同样偏离 1 个半音，33ms 帧该比
    //   16.7ms 帧更有分量，否则偏差的代价会随帧率变化、判决跟着变。
    //   obsCap 仍在**缩放之后**截断（它是"单帧影响上限"的护栏，不是率）。
    for (let k = 0; k < NONE; k++) {
      const d = m - cands[k];
      obs[base + k] = w * Math.max(-o.obsCap, (-inv * d * d + priorOf(cands[k])) * dt) - gp;
    }
    // ⚠ 发声帧落在 NONE 必须付代价（否则 NONE 成"免费避难所"：音高状态每帧都有负代价、
    //   待在 NONE 里零成本 → 整段被判成无音，实测出块 0）。分两项，各管一件事：
    //   · 存在性 presencePen：发声帧压制「无音」= "这里确实有声音，该有一个音"。
    //     ⚠ 它**只压 NONE、绝不惩罚音高状态**。用能量同时压音高状态(-pen*(1-g)) 的话，
    //     于是音量起伏就被当成边界 → 过切（实测某段真实录音 27 块）。边界归气口维度。
    //     ⚠ 没有这一项时：短音付不起 2λ 的进出代价 → 整段被判无音（实测 hmm=0 块）。
    //   · 两项都乘 dt：与帧率无关（见 frameDts 头注），且 w→0（高 str 不可信帧）时归零
    //     → 不逼出一个音符。
    //   · 气口项 +gp 反向补偿 → 该断就断（气口帧仍是 NONE 更优）。
    obs[base + NONE] = -(sc + o.presencePen * dt) * w + gp;
  }
  return obs;
}

// Viterbi（标准 DP，回溯最优状态路径）
function viterbi(obs, K, T, trans) {
  if (T === 0) return new Int32Array(0);
  const prev = new Float64Array(K), cur = new Float64Array(K);
  const psi = new Int32Array(T * K);
  for (let k = 0; k < K; k++) prev[k] = obs[k];
  for (let t = 1; t < T; t++) {
    const base = t * K;
    for (let q = 0; q < K; q++) {
      let best = -Infinity, bi = 0;
      for (let p = 0; p < K; p++) {
        const v = prev[p] + trans(p, q);
        if (v > best) { best = v; bi = p; }
      }
      psi[base + q] = bi;
      cur[q] = best + obs[base + q];
    }
    prev.set(cur);
  }
  let bi = 0;
  for (let k = 1; k < K; k++) if (prev[k] > prev[bi]) bi = k;
  const path = new Int32Array(T);
  path[T - 1] = bi;
  for (let t = T - 1; t > 0; t--) path[t - 1] = psi[t * K + path[t]];
  return path;
}

// 状态路径 → 音符序列
function pathToNotes(frames, path, cands, shift, o) {
  const NONE = cands.length;
  const step = estimateStep(frames);
  const out = [];
  let i = 0;
  while (i < frames.length) {
    const s = path[i];
    if (s === NONE) { i++; continue; }
    let j = i;
    while (j + 1 < frames.length && path[j + 1] === s) j++;
    const t0 = frames[i].t;
    let t1 = frames[j].t + step;
    if (!(t1 > t0)) t1 = t0;                       // 单帧/无步长：零长，下面按 minNoteMs 过滤
    const raw = cands[s] + shift;                  // 还原到原始音高域
    out.push({ t0, t1, midi: Math.round(Math.max(0, Math.min(127, raw))) });
    i = j + 1;
  }
  return out;
}

export function decodeNotes(frames, opts) {
  const o = { ...HMM_DEFAULTS, ...(opts || {}) };
  const empty = { notes: [], shift: 0, cands: [], states: null, loglik: 0, rawCount: 0 };
  if (!Array.isArray(frames) || !frames.length) return empty;

  const shift = o.estimateShift ? estimateTuningShift(frames) : 0;
  const cands = buildCands(frames, shift, o);

  // 没有任何发声帧 → 空结果（全静音不该产出音符）
  if (!cands.length) return { ...empty, shift };

  const K = cands.length + 1, NONE = K - 1, T = frames.length;
  const obs = buildObs(frames, cands, shift, o);

  // 转移：同态零代价；异态付 lambda + mu×半音距离（NONE 与音高之间无距离项）
  const trans = (p, q) => {
    if (p === q) return 0;
    const d = (p !== NONE && q !== NONE) ? Math.abs(cands[p] - cands[q]) : 0;
    return -(o.lambda + o.mu * d);
  };

  const path = viterbi(obs, K, T, trans);
  let best = -Infinity;
  const lastBase = (T - 1) * K;
  for (let k = 0; k < K; k++) if (obs[lastBase + k] > best) best = obs[lastBase + k];

  const raw = pathToNotes(frames, path, cands, shift, o);
  const notes = raw.filter((n) => n.t1 - n.t0 >= o.minNoteMs);
  return { notes, shift, cands, states: path, loglik: best, rawCount: raw.length };
}

// —— 朴素基线（仅测试对照用）——
// 「逐帧取最近格 + 相邻同格合并」——即不做任何序列级推断的做法。
// 提供它只为了让测试能断言「HMM 确实比逐帧量化更稳」，不参与生产链路。
export function naiveQuantize(frames, opts) {
  const o = { ...HMM_DEFAULTS, ...(opts || {}) };
  const shift = o.estimateShift ? estimateTuningShift(frames) : 0;
  const step = estimateStep(frames);
  const out = [];
  let cur = null;
  for (const f of frames) {
    const m = isVoiced(f) ? Math.round(f.midi - shift) : null;
    if (m === null) { cur = null; continue; }
    if (cur && cur.midi === m) { cur.t1 = f.t + step; continue; }
    cur = { t0: f.t, t1: f.t + step, midi: m };
    out.push(cur);
  }
  return out.filter((n) => n.t1 - n.t0 >= o.minNoteMs);
}

// ============================================================
// —— 在线解码器：Short-time Viterbi 的「固定滞后 + 双解码收敛」版 ——
//
// 标准 Viterbi 要看到整段才能回溯，所以不能直接用于"边吹边出块"。学界解法
// （Ircam Bloit & Rodet ICASSP 2008 / MSR Online Decoding under Latency Constraints）
// 是在变长窗上迭代解码、**路径收敛即输出**。这里用同样思路的两个可判定条件：
//   ① 收敛：该音符在**连续三次解码**中边界与音高完全一致（路径已稳定，不会再变）
//   ② 远离末尾：它的结束时刻距当前时刻 ≥ lagMs（后续帧不可能再改写它）
// 两条都满足才输出 → 不会出现"块刚出就被改写/消失"（本项目 v2 的老病）。
//
// 输出即裁剪：已定音符之前的帧从缓冲移除，保证"已输出的块绝不被改写"。
// 另报告 open（当前正在进行的音符），调用方据此画"生长中的块"。
//
// opts 追加：lagMs(默认 350，解码滞后) / bufMs(缓冲上限 4000) / overlapMs(裁剪重叠 200)
//   push 的 frame 追加可选 env（细粒度包络全量数组，真机 = snapshot 的 d.env）：
//   气口证据来自它；**帧级 rms 已被证明在真机上判不出气口（93ms 窗抹平），不再使用**。
// 返回 { push(frame)→{settled, open}, reset(), emittedUntil, bufferLen }
// ============================================================
export function createOnlineNotes(opts) {
  const o = { ...HMM_DEFAULTS, ...(opts || {}) };
  // ⚠ 不变量：输出滞后必须大于「气口定案窗」，否则一个已输出的音符可能因后到的
  //   气口证据被改写（违反"已输出的块绝不被改写"）。默认 350 ≥ 200+150。
  const lag = Math.max(Number.isFinite(o.lagMs) ? o.lagMs : 350, o.gateSettleMs + 150);
  const bufMs = Number.isFinite(o.bufMs) ? o.bufMs : 6000;
  // ⚠ 裁剪重叠必须够大：实测 ovl=200ms 时有一块（517ms 长的音）在裁剪边界上被吃掉；
  //   800ms 即消失。它必须 > gateSettleMs 且够容纳"跨界那个音"的头部。
  const overlapMs = Number.isFinite(o.overlapMs) ? o.overlapMs : 800;
  let buf = [];
  let prev = [];                 // 上次解码的「未输出」音符
  let prev2 = [];                // 上上次（收敛需要连续三帧一致，见下）
  let outT = -Infinity;          // 已输出到的音频时刻
  let envStart = 0;              // env 扫描起点游标（env 是录音全程累积的，不能每次全扫）

  const noteEq = (a, b) => Math.abs(a.t0 - b.t0) < 1 && Math.abs(a.t1 - b.t1) < 1 && a.midi === b.midi;

  return {
    push(f) {
      buf.push({ t: f.t, midi: f.midi, voiced: !!f.voiced && Number.isFinite(f.midi), str: f.str });
      while (buf.length && buf[0].t < f.t - bufMs) buf.shift();
      if (buf.length < 6) return { settled: [], open: null };

      // 气口证据：每次 push 重标整个缓冲。新到的 env 会让"还没定案"的帧的气口
      // 从无到有 —— 这是必要的（判定气口必须看到谷两侧的峰），而 lag > gateSettleMs
      // 保证这种后到的证据永远落在"尚未输出"的音符上。
      if (Array.isArray(f.env)) {
        while (envStart < f.env.length && f.env[envStart].t < f.t - bufMs - 1000) envStart++;
        annotateGates(buf, f.env.slice(envStart), o);
      }

      // ⚠ 容差 0.5ms：帧 t 由 toFixed(2) 累加而来、t1 是浮点，"严格大于"会让**已输出**的音符
      //   因 1e-9 量级误差重新进入候选 → 同一个音被输出两次（实测块数 3→4）。
      const fresh = decodeNotes(buf, o).notes.filter((n) => n.t1 > outT + 0.5);

      // ⚠ 收敛判据必须**连续三帧**一致，两帧不够：实测音符起点会晚约 33ms（2 帧）才定型，
      //   只比两帧就会把"错误的起点版本"放行 → 同一个音出两个块（t0 317 与 384 并存）。
      let stable = 0;
      const m = Math.min(fresh.length, prev.length, prev2.length);
      while (stable < m && noteEq(fresh[stable], prev[stable]) && noteEq(fresh[stable], prev2[stable])) stable++;
      prev2 = prev; prev = fresh;

      // 已定 = 收敛 且 远离末尾（按时间序，一旦太靠末尾则其后都太靠末尾 → break）
      const settled = [];
      for (let i = 0; i < stable; i++) {
        const n = fresh[i];
        if (n.t1 > f.t - lag) break;
        settled.push(n);
        outT = n.t1;
      }

      // 输出即裁剪：保留已输出末尾之前 overlapMs（给解码留上下文）
      if (Number.isFinite(outT)) {
        const keep = outT - overlapMs;
        while (buf.length && buf[0].t < keep) buf.shift();
      }

      const last = fresh.length ? fresh[fresh.length - 1] : null;
      const open = (last && last.t1 > f.t - lag) ? last : null;
      return { settled, open };
    },
    reset() { buf = []; prev = []; prev2 = []; outT = -Infinity; envStart = 0; },
    get emittedUntil() { return outT; },
    get bufferLen() { return buf.length; },
  };
}

export default {
  decodeNotes, estimateTuningShift, naiveQuantize, createOnlineNotes,
  envGatePoints, annotateGates, HMM_DEFAULTS,
};
