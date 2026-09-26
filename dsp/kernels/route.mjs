// ============================================================
// dsp/kernels/route.mjs —— 自动回退路由内核（组合内核）
//
// 背景：SwiftF0 只覆盖 46.875~2093.75Hz(G1~C7)，极端音域(A0~B0、C7+ )要么超出范围、
// 要么训练不覆盖。auto 回退 = 由同步内核(YIN/pYIN/MPM)兜底，保证任何音高都能出值。
//
// makeRouter(cfg) 返回一个"内核"，cfg:
//   { id, name, primary, fallback, range?, confMin? }
//     primary/fallback: 内核【对象】(已 resolve；fallback 需同步可用；primary 可为 async)
//     range: 主内核支持的 [minHz,maxHz] 频段（超范围回退）。缺省=不限。
//     confMin: 主内核结果的置信阈值（缺省 SWIFT_CONF_MIN=0.6，经实测放宽，见 swiftf0.mjs）
//
// 逐窗逻辑（frame 同步，均不阻塞）：
//   1) 永远先算同步兜底 fallback.frame(win) → res；
//   2) 主内核 ready 且给出"最新帧"（primary.latestF0()，SwiftF0 异步推理回填的缓存），
//      且 conf≥confMin、频率在 range 内 → 用主结果（构造成与兜底同构的品质字段）；
//   3) 否则回退 res（历史 feedPrimary 也兼容，见 feedPrimary）。
// load() 委托给 primary（触发 SwiftF0 的模型/session 加载）。
// 注意：本文件不 import index.mjs(避免循环依赖)，primary/fallback 由调用方传对象。
// ============================================================
import { SWIFT_CONF_MIN } from './swiftf0.mjs';

const objectOrId = (x) => (typeof x === 'string'
  ? console.warn(`[route] 收到内核 id '${x}'，请先 resolve 成对象再传入路由`) && null
  : x);
const inRange = (f, range) => {
  if (!range) return true;
  if (!Number.isFinite(f) || f <= 0) return false;
  return f >= range[0] && f <= range[1];
};
// 主内核与 fallback 半音分歧阈值：真实演唱/口哨同源测量两算法通常 <200¢；
// SwiftF0 偶发"多帧一致跳错"(如长音中实 1250Hz 冒出稳定 73Hz@conf0.96)超 400¢ → 本帧信 fallback
const DISAGREE_CENTS = 400;

export function makeRouter(cfg) {
  const primary = objectOrId(cfg.primary);
  const fallback = objectOrId(cfg.fallback) || null;
  const range = cfg.range || null;
  const confMin = cfg.confMin ?? SWIFT_CONF_MIN;
  let lastPrimary = null;
  let windowT = null;          // 离线模式当前窗绝对时间(秒)：frame 按此精确取 primary 帧
  // 命中诊断：区分"主内核真在出值" vs "一直在哑回退"（判断 SwiftF0 是否生效的唯一确凿凭证）
  const stats = { hit: 0, noFrame: 0, lowConf: 0, outOfRange: 0, notReady: 0, fallback: 0, disagree: 0 };

  const ready = () => !!(primary && primary.ready && primary.ready());
  const feedPrimary = (res) => { lastPrimary = res || null; };
  const resetPrimary = () => { lastPrimary = null; };
  // SwiftF0 等主内核的异步加载（模型/onnx session）
  const load = () => (primary && primary.load ? primary.load() : Promise.resolve(true));

  const router = {
    id: cfg.id,
    name: cfg.name,

    // 路由逻辑：同步兜底先算(总是)；主内核能取到当前窗时间/最新帧且置信频率达标 → 用主；否则回退。
    frame(win, sr, cfg2) {
      const res = fallback.frame(win, sr, cfg2);
      // 取主内核当前窗帧：app.mjs 实时(录音/播放兜底)与 analyzePCM(离线)每窗都会
      // setWindowTime(tSec) → 经 primary.atTime 按窗绝对时间精确取帧
      //（实时消除"攒批共享一帧"阶梯；离线经 _injectOffline 注入帧表不依赖 session，worker 未 ready 也命中）；
      // 兜底：无人 setWindowTime 的调用方 → 取异步推理最新帧(latestF0)；feedPrimary 历史兼容。
      const s = (windowT != null && primary.atTime)
        ? primary.atTime(windowT)
        : ((primary.latestF0 ? primary.latestF0() : null) || lastPrimary);
      if (s) {
        if (s.conf !== undefined && s.conf < confMin) { stats.lowConf++; }        // 有帧但置信不达门槛
        else if (!inRange(s.freq, range)) { stats.outOfRange++; }                  // 有帧但超主内核频段
        else if (Number.isFinite(res.freq) && res.freq > 0
                 && Math.abs(1200 * Math.log2(s.freq / res.freq)) > DISAGREE_CENTS) {
          // 主内核与 fallback 严重分歧(实测: 长音中 SwiftF0 连续 3 帧稳定输出 73Hz@conf0.96
          // 冒充真目标，trackFreq 的 2 帧确认防不了"多帧一致跳错") → 本帧信 fallback
          stats.disagree++; stats.fallback++;
          return res;
        }
        else {
          stats.hit++;                                                              // ✓ 主内核真在出值
          // 帧频采用主内核(SwiftF0)的值，但品质字段(str/prom/purity)沿用 fallback 的真实判定：
          // 若 hit 时伪造 str=1-conf≈0，噪声段(实测 SwiftF0 conf≥0.9 给 60~150Hz)会被 detect 的
          // strongPeriod 判成"铁证周期"绕过能量门，画出假曲线；用真实周期判据则噪声段 str 高被挡，
          // 纯净弱口哨(str≈0.01)仍能正常通过。SwiftF0 因此定位为"频率精修层"，voicing 归 YIN 强门控。
          return { freq: s.freq, fA: s.freq, fB: s.freq, str: res.str, prom: res.prom, purity: res.purity };
        }
      } else if (this.ready()) { stats.noFrame++; }                 // 主 ready 但尚无产物（数据未到/尚在攒批）
      else { stats.notReady++; }                                     // 主不可用且无注入帧 → 全程兜底
      stats.fallback++;
      return res;                                                  // 置信不足/超范围/无帧 → 兜底
    },

    // 离线分析逐窗设置当前窗绝对时间(秒)；null 恢复实时模式(latestF0)
    setWindowTime(tSec) { windowT = (tSec === null || tSec === undefined) ? null : tSec; },
    // 离线整段推理透传（SwiftF0 整段一次 session.run），失败返回 null
    runOffline(pcm, srcRate, onTick) {
      if (primary && typeof primary.runOffline === 'function') return primary.runOffline(pcm, srcRate, onTick);
      return null;
    },
    _clearOffline() { if (primary && typeof primary._clearOffline === 'function') primary._clearOffline(); },
    _injectOffline(frames) { if (primary && typeof primary._injectOffline === 'function') primary._injectOffline(frames); },

    getStats() { return { ...stats }; },
    resetStats() { for (const k in stats) stats[k] = 0; },

    ready, feedPrimary, resetPrimary, load,
    // 数据入口委托：app.mjs processBlock 每窗会对 activeKernel() 调 pushSample，
    // 若 primary 是带数据喂入的异步内核(SwiftF0)，必须转发，否则它永远收不到波形、
    // latestF0() 恒为空，路由会一直哑回退回 fallback(YIN) 而 SwiftF0 从未真正推理。
    // tEndSec(本窗末样本的音频时钟时间) 同样必须转发：SwiftF0 靠它只取新增样本，
    // 否则重叠的 analyser 滑窗会把 16k 时间轴灌成数倍速（见 swiftf0.pushSample）。
    pushSample(x, srcRate, tEndSec) {
      if (primary && typeof primary.pushSample === 'function') {
        return primary.pushSample(x, srcRate, tEndSec);
      }
      return undefined;
    },
  };
  return router;
}

export default makeRouter;