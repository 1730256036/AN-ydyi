// ============================================================
// dsp/kernels/pyin.mjs —— 第三个检测内核：pYIN（probabilistic YIN）
//
// ⚠ 2026-09-20 更正：本内核**不是**"比 YIN 更抗倍周期歧义"。core.pyin 的谷选择规则
// 与 YIN 相同（绝对门内取 τ 最小者），差别只是输出 prob=1-cm(被选谷)。若用
// "首个 p≥maxP×0.5"的相对门（cmMin 小时宽达 ~0.5），真素材上单向偏高、八度错 30.7%
// （YIN 8.4%），已修（见 core.mjs pyinPeriod 注释与 test/pyin-sim.mjs 守卫）。
// 接口契约同 yin/mpm：{ id, name, frame(win, sr, cfg) }。
//
// 品质字段口径（与 mpm.mjs 保持一致；必须取真实频谱，不可用同源代理值）：
//   freq/fB = pYIN 自己的基频估计（本内核存在的意义，绝不掺融合）
//   fA      = 引擎A(频谱峰追踪)候选，仅供诊断徽标对照
//   str     = 1 - prob(被选谷的 1-cm)，本算法自有的周期判据，0=强周期…1=无周期
//   purity / prom = 引擎A 的真实频谱量（主瓣占比 / 主峰对邻域中位数 dB）
// 三字段全由 prob 线性映射(1-x/x/30x)的话：① detect 三重门退化成同一标量（prom 门失效、
// sens 四档斜率失效）；② prom 成 0~30 假 dB，与 yin-dual 的真实 ~58dB 不同量纲，
// 渲染层(/40、/34、/18)与工程存档随内核漂移。改用引擎A 后真素材实测 prom p50:
// pyin 58.6 / mpm 58.4 / yin-dual 58.6dB，发声率 62%/63%/62%，换内核只换频率估计。
// ============================================================
import { peakTrack, pyin } from '../core.mjs';

export const pyinKernel = {
  id: 'pyin',
  name: 'pYIN（概率·抗歧义）',

  frame(win, sr, cfg) {
    const N = cfg.windowSize, fmin = cfg.fmin, fmax = cfg.fmax;
    const ra = peakTrack(win, sr, { windowSize: N, hopSize: N, fmin, fmax });
    // threshold 必须显式传：core.pyin 的默认是 0.1，而 yin 内核走的是 1-voicing/100=0.15。
    // 同为 YIN 家族却用两个不同绝对门 = 隐性口径分叉（2026-09-20 统一为 voicing 同源）。
    const r = pyin(win, sr, {
      windowSize: N, hopSize: N, fmin, fmax, threshold: 1 - (cfg.voicing ?? 85) / 100,
    });
    const prob = (r.prob && r.prob.length) ? r.prob[0] : 0;   // 0~1，越大越像有音高
    const f = (r.f && r.f.length) ? r.f[0] : NaN;
    return {
      freq: f,
      fA: ra.f.length ? ra.f[0] : NaN,   // 引擎A 候选（诊断用）
      fB: f,
      str: Math.min(1, Math.max(0, 1 - prob)),   // 对齐门控"越小越周期"
      purity: (ra.purity && ra.purity.length) ? ra.purity[0] : 0,
      prom: ra.prom.length ? ra.prom[0] : 0,
    };
  },
};

export default pyinKernel;