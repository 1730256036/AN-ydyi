// ============================================================
// dsp/kernels/mpm.mjs —— 第二个检测内核：MPM（McLeod Pitch Method）
//
// 与默认 YIN 内核不同的原理(归一化平方差函数 NSDF)，纯 JS、同步，
// 可直接进 frame() 契约。通过 createDetector({kernel:'mpm'}) 或界面切换使用，
// 门控/平滑/能量门/录音沉淀全不动。
//
// 接口契约(与 yin.mjs 一致)：{ id, name, frame(win, sr, cfg) }。
//
// 品质字段口径（与 pyin.mjs 保持一致；必须取真实频谱，不可用同源代理值）：
//   freq/fB = MPM 自己的基频估计（本内核存在的意义，绝不掺融合）
//   fA      = 引擎A(频谱峰追踪)候选，仅供诊断徽标对照
//   str     = 1 - NSDF 主峰(0=强周期…1=无周期)，本算法自有的周期判据
//   purity / prom = 引擎A 的真实频谱量（主瓣占比 / 主峰对邻域中位数 dB）
// 最初把三个品质字段都由 NSDF 主峰线性映射(1-x / x / 30x)，两条硬伤：
//   ① detect 的三重门 str<strMax && purity>purityMin && prom>promMin 退化成【同一个
//      标量】的约束，prom 门永不生效、sens 四档的三条不同斜率只有 yin-dual 下成立；
//   ② prom 变成 0~30 的假 dB，而 yin-dual 是真实峰突出度（真素材 p50≈58dB）
//      → 渲染层(pitchOrb prom/40、/34，pianoBlocks prom/18)与工程存档的 prom
//      量纲随内核漂移。
// 改用引擎A 后三内核品质同源同量纲（真素材实测 prom p50: mpm 58.4 / pyin 58.6 /
// yin-dual 58.6dB；发声率 63%/62%/62%）：换内核只换频率估计，不换门控与观感。
// 代价：多一次 peakTrack(4096 点 FFT) ≈ +0.13ms/帧（MPM 本体 2.66ms/帧）。
//
// ⚠ voicing(0~100 的周期搜索阈值)只对 YIN 家族有定义；MPM 的 threshold 是另一个量
//   （主峰相对全局峰的相对高度门，用于抑制次谐波，默认 0.9）。故本内核不接
//   cfg.voicing——调 voicing 时 MPM 不跟着变，这是有意为之，不是漏接。
// ============================================================
import { peakTrack, mpm } from '../core.mjs';

export const mpmKernel = {
  id: 'mpm',
  name: 'MPM（McLeod）',

  frame(win, sr, cfg) {
    const N = cfg.windowSize, fmin = cfg.fmin, fmax = cfg.fmax;
    const ra = peakTrack(win, sr, { windowSize: N, hopSize: N, fmin, fmax });
    const r = mpm(win, sr, { windowSize: N, hopSize: N, fmin, fmax });
    const nsdf = (r.str && r.str.length) ? r.str[0] : 1;   // 主峰 NSDF(0~1, 越大越周期)
    const f = (r.f && r.f.length) ? r.f[0] : NaN;
    return {
      freq: f,
      fA: ra.f.length ? ra.f[0] : NaN,   // 引擎A 候选（诊断用）
      fB: f,
      // 对齐门控语义："越小越像有周期"。NSDF 主峰近1 → str 近0。
      str: Math.min(1, Math.max(0, 1 - nsdf)),
      purity: (ra.purity && ra.purity.length) ? ra.purity[0] : 0,
      prom: ra.prom.length ? ra.prom[0] : 0,
    };
  },
};

export default mpmKernel;
