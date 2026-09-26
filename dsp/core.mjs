// ============================================================
// ydyi 核心 DSP —— 频谱峰追踪(引擎A) + YIN自相关(引擎B) + 融合
// 纯零依赖 ESM 模块，浏览器 <script type=module> 与 node 通用。
// 全部输入为 Float32Array / Array，采样率自定。
// ============================================================

  // ---------- 工具 ----------
  const winCache = new Map();
  export function hann(N) {
    if (winCache.has(N)) return winCache.get(N);
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    winCache.set(N, w);
    return w;
  }

  export const centsOf = (f, ref) => 1200 * Math.log2(f / ref);
  export const HzOf = (ref, centsDelta) => ref * 2 ** (centsDelta / 1200);

  export const NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // 频率 -> { name, oct, midi, cents }
  //   name  = 音名（不含八度，八度在 oct）；cents = 相对【最近半音】的偏差（不是相对 A4）。
  // ⚠⚠ 已知缺陷（2026-09-22 复核确认，尚未修）：下面 cents 写作 `1200*log2(midi/m)`——
  //   那是拿【半音序号之比】当频率比，正解应为 `100*(midi - m)`。后果是读数偏小约 4 倍
  //   （实测 445Hz 真值 +19.6¢，本函数给 +4.9¢）。proj/exporters.mjs 已自行绕开，
  //   但显示层（app.mjs 的音分读数、pitchTrail / pitchOrb 的音准标注）仍在用这个错值。
  //   修它会让所有音分读数变化 → 属显示口径变更，需先拍板；故此处只登记、不改。
  // ⚠ 另：f<=0 的早退分支没有 oct 字段，而消费方普遍写 `n.name + n.oct` → 会拼出 "--undefined"。
  export function freqToNote(f) {
    if (!(f > 0)) return { name: '--', cents: NaN, midi: -1 };
    const midi = 69 + 12 * Math.log2(f / 440);
    const m = Math.round(midi);
    const cents = 1200 * Math.log2(midi / m); // ⚠ 公式错，见上；正解 100*(midi-m)
    return { name: NAME[((m % 12) + 12) % 12], oct: Math.floor(m / 12) - 1, midi: m, cents };
  }

  // ---------- 引擎A：频谱峰追踪 ----------
  // 返回 Float32Array：每 hop 一帧的估计频率。窗口滑动。
  export function peakTrack(x, sr, opt = {}) {
    const N = opt.windowSize || 4096;
    const hop = opt.hopSize || 512;
    const fmin = opt.fmin ?? 40;
    const fmax = opt.fmax ?? 8000;
    const win = hann(N);
    const nfft = nextPow2(N);
    const re = new Float32Array(nfft), im = new Float32Array(nfft);
    const half = nfft / 2 + 1;
    const kmin = Math.max(1, Math.ceil((fmin * nfft) / sr));
    const kmax = Math.min(half - 3, Math.floor((fmax * nfft) / sr));

    const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const out = new Float32Array(nFrames);
    const prom = new Float32Array(nFrames);
    const purity = new Float32Array(nFrames);  // 主峰能量 / 全频带能量（0~1，越大越像纯音）
    const mag = new Float32Array(half);

    for (let fi = 0; fi < nFrames; fi++) {
      const p = fi * hop;
      for (let i = 0; i < N; i++) { re[i] = x[p + i] * win[i]; im[i] = 0; }
      for (let i = N; i < nfft; i++) { re[i] = 0; im[i] = 0; }
      rfft(re, im, nfft);
      // 填充范围比 [kmin,kmax] 各宽一格：下面的抛物线插值要读 best±1，
      // 端点若留 0（Float32Array 初值）会被 log(1e-300)=-690 拽住 → 插值恒被推到 kmin+0.5 bin。
      // 2026-09-18 修：实测 40/41/43/44/45Hz 一律报 48.4Hz；27.5Hz 时 YIN 也失效，
      // 融合直接采纳 48.39Hz，屏上显示成 G（差 978¢）。total/lobe 仍只统计 [kmin,kmax]。
      const kLo = Math.max(1, kmin - 1), kHi = Math.min(half - 1, kmax + 1);
      for (let k = kLo; k <= kHi; k++) mag[k] = re[k] * re[k] + im[k] * im[k];
      let best = kmin, bestV = 0, total = 0;
      for (let k = kmin; k <= kmax; k++) {
        total += mag[k];
        if (mag[k] > bestV) { bestV = mag[k]; best = k; }
      }
      // 真静音（整帧无任何峰能量）：直接标 NaN，不给下游 fmin=40Hz 假频。
      // 否则 fusePoint 因 A 有效而采纳这条假频。轻微底噪由 app.mjs 的 rms 能量门兜底。
      if (bestV <= 0) { out[fi] = NaN; prom[fi] = 0; purity[fi] = 0; continue; }
      // 干净度(purity)：主峰主瓣(±3 bin)能量 / 全频带能量。
      // 汉宁窗主瓣把单音能量展到 ~3 bin，故取局部和而非单 bin；口哨≈1，说话/宽带低。
      let lobe = 0;
      for (let k = best - 3; k <= best + 3; k++) if (k >= kmin && k <= kmax) lobe += mag[k];
      purity[fi] = total > 0 ? lobe / total : 0;
      // 抛物线插值（对数幅度，二阶）——保留亚 bin 精度，否则低音区会因取整丢掉插值
      const la = Math.log(mag[best - 1] + 1e-300), lb = Math.log(bestV + 1e-300), lc = Math.log(mag[best + 1] + 1e-300);
      const den = la - 2 * lb + lc;
      const d = Math.abs(den) > 1e-12 ? (0.5 * (la - lc)) / den : 0;
      const adj = Math.abs(d) < 1 ? best + d : best;
      out[fi] = Math.max(fmin, (adj * sr) / nfft);
      // 峰突出度（dB，对邻域中位数）
      const lo = Math.max(kmin, best - 64), hi = Math.min(kmax, best + 64);
      const bg = [];
      for (let k = lo; k <= hi; k++) if (Math.abs(k - best) > 3) bg.push(mag[k]);
      bg.sort((a, b) => a - b);
      const med = bg.length ? bg[bg.length >> 1] : 1e-300;
      prom[fi] = 10 * Math.log10((bestV + 1e-300) / (med + 1e-300));
    }
    return { f: out, prom, purity, hop };
  }

  // ---------- 引擎B：YIN 自相关 ----------
  // fmin/fmax 双向夹紧候选周期，从源头抑制倍周期八度误判与过低周期。
  // 显式差分 O(N·Δtau) —— 零偏、稳健；Δtau≈tauMax-tauMin≤~1100，实时 4096 帧可接受。
  //
  // 【降采样】opt.decim（现默认 1 = 全速率；可传 2 提速）：先对窗做 D 抽头框式平均
  // （粗抗混叠低通）再抽点，在 sr/D 的等效采样率上跑 YIN：44.1k 下 ~2.2ms → ~0.56ms/窗(≈3.9×)。
  //
  // ⚠ 2026-09-20 默认由 2 改回 1（真机发现"快吹口哨的曲线上有一小段滞后"，取证后定案）：
  //  - 频率本身没错：真素材 samples/录音 17_30_29.wav 上 decim=1/2 与 pyin/mpm 的原始频率
  //    逐帧一致（≤16¢），全文件仅 1 帧例外；
  //  - 真凶是【门控边界】：换音的交界帧上 decim=2 的 cm 谷值 str=0.233、全速率 0.210，而
  //    sens70 的门限 strMax=0.219 → 该帧被判"品质不达标"→ detect 的「跳变需连续两帧确认」
  //    晚一拍启动 → 曲线上多留一帧(23ms)旧音。pyin/mpm 走全速率，所以只有它俩正常；
  //  - 精度上降采样并不吃亏（B7+20dB 噪声 6.5¢ vs 全速率 11.4¢；4698Hz 7.0 vs 13.8）——
  //    所以这不是"拿精度换速度"失败，而是"在门限刀锋上多踩了一脚"；
  //  - 代价：单窗 0.70→2.34ms（实时 60fps 预算 16.7ms，仍宽裕，与 pyin/mpm 现速同级）；
  //    离线整段 ≈3.94×（251s 人声 hop1024 约 6.0s→23.6s；7.5s 短录音 0.18→0.70s）。
  //  - 附带收益：decim=1 后 yin 与 pyin 的谷选择/门控数值几乎一致，四内核不再分裂。
  // 该参数保留（低音区 49~131Hz 的 str 与全速率逐位一致，要换速度仍可用），但**别在默认
  // 路径上重开**——除非把"门限刀锋帧"这类边界重新验过一遍。
  // decim>1 时的两个已知边界：
  //  - 可表示频率上限降为 sr/D/2（D=2 时 11kHz）——高于音域硬钳 4186Hz(C8)，不构成损失，
  //    超出部分本就由引擎A(全速率频谱)负责，fusePoint 仲裁兜底；
  //  - decim=3 时 4186Hz(C8) 处 τ≈3.5 样本，CMNDF 谷结构退化 → 八度误判 100%，别用。
  export function yin(x, sr, opt = {}) {
    const N = opt.windowSize || 4096;
    const hop = opt.hopSize || 512;
    const fmin = opt.fmin ?? 40;
    const fmax = opt.fmax ?? 8000;
    const thresh = opt.threshold ?? 0.1;
    const decim = opt.decim ?? 1;
    // 等效采样率与窗长：decim=1 时完全退化为原全速率路径（逐位一致）
    const Neff = decim > 1 ? Math.floor(N / decim) : N;
    const srEff = decim > 1 ? sr / decim : sr;
    const win = hann(Neff);
    const tauMin = Math.max(2, Math.floor(srEff / fmax));
    const tauMax = Math.min(Math.floor(Neff / 2) - 1, Math.ceil(srEff / fmin) + 2);
    const wf = new Float32Array(Neff);

    const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const out = new Float32Array(nFrames);
    out.fill(NaN);
    // pitch strength（音高强度/浊音度）：CMNDF 全局最小谷值 cmMin∈[0,1]。
    // 完美周期音 → 谷值趋 0；纯噪音(拍桌/响指/宽带) → 无深谷，谷值≈0.3~1。
    // 这是"这帧到底有没有音高"的最本质判据，比能量/突出度更能区分口哨 vs 撞击。
    const str = new Float32Array(nFrames);

    for (let fi = 0; fi < nFrames; fi++) {
      const p = fi * hop;
      // 框式平均 + 抽取 + 加窗一次完成：wf[i] = mean(x[p+iD .. p+iD+D-1]) · hann(i)。
      // decim=1 时即原 x[p+i]·win[i]，无任何分支开销。
      for (let i = 0; i < Neff; i++) {
        let s = 0; const b = p + i * decim;
        for (let j = 0; j < decim; j++) s += x[b + j];
        wf[i] = (s / decim) * win[i];
      }
      const r = yinPeriod(wf, Neff, srEff, tauMin, tauMax, thresh);
      out[fi] = r.tau > 0 ? srEff / r.tau : NaN;
      str[fi] = r.strength;   // 越小越像有周期(有音高)
    }
    return { f: out, str, hop };
  }

  // ---------- 引擎C：MPM（McLeod Pitch Method） ----------
  // 归一化平方差函数(NSDF) + 主峰拾取，独立于 YIN 的不同原理，作第二可插拔内核。
  // 抑制次谐波：取 NSDF 中"第一个 ≥ 全局主峰×threshold 的局部峰"作基频(非直接取最高峰)，
  // 否则 2×周期处的峰常更高(窗口内更多周期参与匹配)，会掉成低八度。
  // str = 主峰 NSDF 值(0~1, 越大越像有周期)，与 YIN 的 str(越小越周期)方向相反，由内核适配。
  export function mpm(x, sr, opt = {}) {
    const N = opt.windowSize || 4096;
    const hop = opt.hopSize || 512;
    const fmin = opt.fmin ?? 40;
    const fmax = opt.fmax ?? 8000;
    const thresh = opt.threshold ?? 0.9;      // 主峰相对高度阈值，抑制次谐波
    const win = hann(N);
    const tauMin = Math.max(2, Math.floor(sr / fmax));
    const tauMax = Math.min(Math.floor(N / 2) - 1, Math.ceil(sr / fmin) + 2);
    const wf = new Float32Array(N);

    const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const out = new Float32Array(nFrames);
    out.fill(NaN);
    const str = new Float32Array(nFrames);

    for (let fi = 0; fi < nFrames; fi++) {
      const p = fi * hop;
      for (let i = 0; i < N; i++) wf[i] = x[p + i] * win[i];
      const r = mpmPeriod(wf, N, tauMin, tauMax, thresh);
      out[fi] = r.tau > 0 ? sr / r.tau : NaN;
      str[fi] = r.strength;
    }
    return { f: out, str, hop };
  }

  // ---------- 引擎D：pYIN（probabilistic YIN / Mauch&Dixon） ----------
  // ⚠ 与教科书 pYIN 的差距（2026-09-20 校准文档，勿再照抄"更稳健"的说法）：
  //   本实现是【逐窗同步版】，没有跨帧 Viterbi/HMM 音高轮廓（那层留给上层平滑），
  //   也没有对候选做真正的概率加权合成——谷选择规则与 core.yinPeriod 相同（绝对门内取
  //   τ 最小的显著谷）。它相对 YIN 的差别只有两点：① 输出 prob = 被选谷的 1-cm
  //   （YIN 输出 cm 本身），② 不对"无显著谷"的帧给频（YIN 会退化为全局最小谷）。
  //   prob 越大越像有音高(0~1)，由内核适配门控。
  export function pyin(x, sr, opt = {}) {
    const N = opt.windowSize || 4096;
    const hop = opt.hopSize || 512;
    const fmin = opt.fmin ?? 40;
    const fmax = opt.fmax ?? 8000;
    const thresh = opt.threshold ?? 0.1;      // CMNDF 谷值阈值
    const win = hann(N);
    const tauMin = Math.max(2, Math.floor(sr / fmax));
    const tauMax = Math.min(Math.floor(N / 2) - 1, Math.ceil(sr / fmin) + 2);
    const wf = new Float32Array(N);

    const nFrames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
    const out = new Float32Array(nFrames);
    out.fill(NaN);
    const prob = new Float32Array(nFrames);

    for (let fi = 0; fi < nFrames; fi++) {
      const p = fi * hop;
      for (let i = 0; i < N; i++) wf[i] = x[p + i] * win[i];
      const r = pyinPeriod(wf, N, tauMin, tauMax, thresh);
      if (r.tau > 0) out[fi] = sr / r.tau;
      prob[fi] = r.prob;
    }
    return { f: out, prob, hop };
  }

  // 单帧 pYIN：CMNDF → 收集全部谷候选 → 在【绝对门】内取 τ 最小的显著谷（= 基频）。
  // 返回 {tau, prob}，prob = **被选中那个谷**的概率(0~1，越大越像有周期/有音高)。
  //
  // ⚠ 2026-09-20 修（真素材取证，见 test/pyin-sim.mjs 守卫）：
  //   取"首个 p ≥ maxP×0.5"的候选，展开即【相对门】cm ≤ (1+cmMin)/2。cmMin 小的
  //   真素材上该门宽达 ~0.5（YIN 用的绝对门是 0.15）→ 半周期浅谷被当基频：2 次谐波强时
  //   x(t)≈x(t+T/2)，cm(T/2) 只有 ~0.45，明明 > 0.15 却被相对门放行。
  //   真素材实测（samples/7rvc 人声 251s）：pYIN vs YIN 一致 2263 帧 / 偏高>100¢ 1759 帧 /
  //   偏低 73 帧 = 单向偏高；对参照 MIDI 八度错 30.7%（YIN 8.4%）。
  //   改法：与 core.yinPeriod 用同一条规则——取 cm < thresh 的首个谷；thresh 就是
  //   opt.threshold（注意：不要把它当死参数丢掉）。
  //   prob 同步改为被选谷的 1-cm（原用全局最深谷 maxP → 选错谷时 prob 仍≈1，purity 判据抓不住）。
  function pyinPeriod(wf, N, tauMin, tauMax, thresh) {
    if (tauMax <= tauMin) return { tau: -1, prob: 0 };
    const d = new Float32Array(tauMax + 2), cm = new Float32Array(tauMax + 2);
    for (let tau = tauMin; tau <= tauMax; tau++) {
      let sum = 0; const t = N - tau;
      for (let i = 0; i < t; i++) { const df = wf[i] - wf[i + tau]; sum += df * df; }
      d[tau] = sum;
    }
    let run = 0;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      run += d[tau];
      cm[tau] = run > 1e-12 ? (d[tau] * (tau - tauMin + 1)) / run : 1e9;
    }
    if (!(run > 1e-12)) return { tau: -1, prob: 0 };   // 整窗零能量(数字静音) → 无候选，别报假周期
    // 收集所有局部极小谷候选（cm 越小=谷越深=越像周期）
    const cands = [];
    for (let tau = tauMin; tau <= tauMax; tau++) {
      const lo = tau > tauMin ? cm[tau - 1] : Infinity;
      const hi = tau < tauMax ? cm[tau + 1] : Infinity;
      if (cm[tau] <= lo && cm[tau] <= hi) cands.push({ tau, cm: cm[tau] });
    }
    if (!cands.length) return { tau: -1, prob: 0 };
    // ① 绝对门内取 τ 最小者 = 基频（cands 按 τ 升序；抑制半周期/谐波浅谷与倍周期）
    let best = null;
    for (const c of cands) if (c.cm < thresh) { best = c; break; }
    // ② 无显著谷 → 退化为全局最深谷（与 yinPeriod 同策略：仍给值，由上层门控用 str 否决）
    if (!best) { for (const c of cands) if (!best || c.cm < best.cm) best = c; }
    // 抛物线细化到亚样本精度
    const tau = parabolaAdj(cm, best.tau);
    return { tau: Math.max(1, tau), prob: Math.max(0, Math.min(1, 1 - best.cm)) };
  }

  // 单帧 MPM：NSDF + 主峰拾取。返回 {tau, strength}，strength = 基频峰 NSDF(0~1,越大越周期)。
  function mpmPeriod(wf, N, tauMin, tauMax, thresh) {
    if (tauMax <= tauMin) return { tau: -1, strength: 0 };
    const nsdf = new Float32Array(tauMax + 2);
    // 逐 tau 显式 NSDF：2·∑ab / (∑a²+∑b²)，无偏、范围[-1,1]，1=完全周期。
    for (let tau = tauMin; tau <= tauMax; tau++) {
      const t = N - tau;
      let ac = 0, l = 0, r = 0;
      for (let i = 0; i < t; i++) { const a = wf[i], b = wf[i + tau]; ac += a * b; l += a * a; r += b * b; }
      nsdf[tau] = (l + r) > 1e-12 ? (2 * ac) / (l + r) : 0;
    }
    // 关键：跳开起始的"伪相关段"。窗口内短滞后(τ 很小)处 wf[i] 与 wf[i+τ] 天然高度相关，
    // NSDF 先出现一个假高平台/下降，直接取第一个达标峰会选中它(如 440Hz 误取 τ=5→伪高频 8820Hz)。
    // 先从 τ 小端找第一个"谷(dip)"——真实周期信号会先单调下降到底再回升，基频峰位于谷之后。
    let dip = null;
    for (let tau = tauMin + 1; tau < tauMax; tau++) {
      if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau - 1] <= nsdf[tau - 2]) { dip = tau - 1; break; }
    }
    const from = dip !== null ? dip + 1 : tauMin;
    // 谷之后找全局主峰作高度基准
    let maxV = -1;
    for (let tau = from; tau <= tauMax; tau++) if (nsdf[tau] > maxV) maxV = nsdf[tau];
    // 整窗零相关（数字静音 / 完全非周期）：NSDF 恒 0，没有"峰"可言。不加这道闸会掉进下面的
    // 局部峰判定——gate = maxV×thresh = 0，于是任何 τ 都"达标"，取到 τ=tauMin 报出
    // sr/tauMin（44.1k 全速率下 8820Hz）的假高频。返回 tau=-1 → 上游给 NaN。
    if (!(maxV > 0)) return { tau: -1, strength: 0 };
    // 从谷后取第一个 ≥ 全局主峰×thresh 的局部峰作 f0（抑制次谐波：2×周期峰虽更高但较靠后）
    let bestTau = -1, bestV = -Infinity;
    const gate = maxV * thresh;
    for (let tau = from; tau <= tauMax; tau++) {
      const lo = tau > from ? nsdf[tau - 1] : -1;
      const hi = tau < tauMax ? nsdf[tau + 1] : -1;
      if (nsdf[tau] > lo && nsdf[tau] >= hi && nsdf[tau] >= gate) { bestTau = tau; bestV = nsdf[tau]; break; }
    }
    if (bestTau < 0) return { tau: -1, strength: 0 };   // 无达标峰 → 无周期，交由门控否决
    return { tau: parabolaAdj(nsdf, bestTau), strength: Math.max(0, Math.min(1, bestV)) };
  }

  // 单帧 YIN：显式差分 + 累积均值归一化差分函数(CMNDF) + 抛物线亚采样。
  // 返回 {tau, strength}，strength = 全局最小 cm 谷值（0=强周期 … 1=无周期）。
  function yinPeriod(wf, N, sr, tauMin, tauMax, thresh) {
    if (tauMax <= tauMin) return { tau: -1, strength: 1 };
    // 逐 tau 维护差分和（直接 O(N·Δtau) 显式，无窗零偏）
    const d = new Float32Array(tauMax + 2);
    for (let tau = tauMin; tau <= tauMax; tau++) {
      let sum = 0;
      const t = N - tau;
      for (let i = 0; i < t; i++) { const df = wf[i] - wf[i + tau]; sum += df * df; }
      d[tau] = sum;
    }
    const cm = new Float32Array(tauMax + 2);
    let run = 0;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      run += d[tau];
      cm[tau] = run > 1e-12 ? (d[tau] * (tau - tauMin + 1)) / run : 1e9;
    }
    // 整窗零能量（数字静音）：cm 全是哨兵值 1e9，往下会命中"全局最小谷"分支并取到
    // τ=tauMin → 报出 srEff/tauMin（44.1k/decim=2 下 =11025Hz）这种假高频；虽被门控的
    // str=1 挡住，但它会进 fA/fB 与 fusePoint 的兜底路径（历史上曾以 8820Hz 形态出现过）。
    // 与 peakTrack 的 `bestV <= 0 → NaN` 同口径：没有能量就没有音高。
    if (!(run > 1e-12)) return { tau: -1, strength: 1 };
    // 首个低于阈值的局部最小（找周期）
    for (let tau = tauMin; tau <= tauMax; tau++) {
      const lo = tau > tauMin ? cm[tau - 1] : Infinity;
      const hi = tau < tauMax ? cm[tau + 1] : Infinity;
      if (cm[tau] < thresh && cm[tau] <= lo && cm[tau] <= hi) {
        return { tau: parabolaAdj(cm, tau), strength: cm[tau] };
      }
    }
    // 无周期(低于阈值的谷不存在) → 看全局最小谷的深度，仍给 strength
    let bT = tauMin, bV = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) if (cm[tau] < bV) { bV = cm[tau]; bT = tau; }
    return { tau: parabolaAdj(cm, bT), strength: Math.min(1, bV) };
  }
  function parabolaAdj(cm, tau) {
    const a = cm[tau - 1] ?? cm[tau], b = cm[tau], c = cm[tau + 1] ?? cm[tau];
    const den = a - 2 * b + c;
    const s = Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0;
    return Math.max(1, tau + (Math.abs(s) < 1 ? s : 0));
  }

  // ---------- FFT（原地，实输入用 rfft 包装） ----------
  export function nextPow2(n) {
    let p = 1; while (p < n) p <<= 1; return p;
  }
  // 通用复 FFT；len 必须 2 的幂
  function fftCore(re, im, n) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + half], bi = im[i + k + half];
          const vr = br * cr - bi * ci, vi = br * ci + bi * cr;
          re[i + k] = ar + vr; im[i + k] = ai + vi;
          re[i + k + half] = ar - vr; im[i + k + half] = ai - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  export function rfft(re, im, n) { fftCore(re, im, n); }
  // 注：曾有一个 irfft 导出，全仓无调用方，且它只是"复数 FFT + 1/n"——真正的实序列逆变换
  // 还需要共轭镜像半谱，误用会得到错结果。2026-09-20 删除（要用再从 git 取）。

  // 融合仲裁（逐点）：结合峰追踪(引擎A) 与 YIN(引擎B)。
  //  - 一致(<closeCents) → 加权平均(0.6A/0.4B)
  //  - 不一致但互为八度倍数(±2x/±3x/…容差) → 取**较低**者为基频（峰追踪把谐波当基频会报高八度，
  //    这是"缺失基频"场景——同类应用公开痛点的根治手段）
  //  - 不一致且非八度关系 → 保守取 YIN（对纯正弦/谐波都更稳），异常交由上层路由决定
  //  - 仅一方有效 → 取该方；都无效 → NaN(静音)
  export function fusePoint(fA, fB, closeCents = 50, octTol = 0.03) {
    const okA = Number.isFinite(fA) && fA > 0;
    const okB = Number.isFinite(fB) && fB > 0;
    if (okA && okB) {
      const ratio = Math.max(fA, fB) / Math.min(fA, fB);
      const octN = Math.round(Math.log2(ratio)); // 差多少倍频程（整数倍 2 幂或 3/2 等）
      // 判断是否八度/谐波整数倍关系：ratio 接近 2^n
      const octErr = Math.abs(Math.log2(ratio) - octN);
      if (Math.abs(centsOf(fA, fB)) < closeCents) {
        return 0.6 * fA + 0.4 * fB; // 真一致
      } else if (octN >= 2 && octErr < octTol) {
        return Math.min(fA, fB); // 互成谐波 → 取基频(低频)
      } else if (octN === 1 && octErr < octTol) {
        return Math.min(fA, fB); // 整八度歧义 → 取低频(防倍周期误判)
      } else if (ratio > 4 || ratio < 0.25) {
        // 极端非整数倍差异(如 fB 掉到 ~1/9 的 气振/硬断音 假周期 58Hz vs 真音523Hz)：
        // 两侧不构成任何谐波关系，YIN 假谷透传会画成 A1 级毛刺。此时频谱主峰(fA)
        // 的突出度/纯度已过门控，可信度更高 → 采 fA。缺失基频(2×/3×等整数倍)
        // 已在上方分支取低频，不受影响；fA 的错误模式(谐波当基频)也都是整数倍。
        // ⚠ 必须显式 return：空分支靠靠链尾的 `if (okA) return fA` 兜底才
        // 碰巧正确——链尾再加一句话或调整兜底顺序就会静默改掉仲裁结果（2026-09-20）。
        return fA;
      } else {
        return fB; // 无谐波关系 → YIN 更稳（无脑采 YIN 会让假周期透传）
      }
    }
    if (okA) return fA;
    if (okB) return fB;
    return NaN;
  }
