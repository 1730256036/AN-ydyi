// ============================================================
// dsp/kernels/yin.mjs —— 默认检测内核：YIN 时域 + 频谱峰追踪双引擎融合
//
// 这是项目第一个（也是当前唯一）"检测内核"。检测内核 = 一个可插拔的
// 音高估算器：给定一窗时域数据 + 采样率 + 检测配置，产出算法侧判定量。
//
// 它只管"从波形算出频率候选 + 周期性/纯音度/峰突出度这些品质信号"，
// 不碰门控公式 / 置信状态机 / 中值平滑 / 能量门——那套判定外围在
// dsp/detect.mjs 的 processWindow 里，跟具体算法无关，换内核不用改。
//
// 想加新算法（pYIN / MPM …）：
//   1. 新建 dsp/kernels/你的算法.mjs，default 导出同款接口的 { id, name, frame, load?, async }；
//   2. 在 dsp/kernels/index.mjs 里 register 它；
//   3. createDetector({ kernel: '你的id' }) 即可切换，门控/平滑/录音沉淀全不动。
//   注意：接口目前是【同步】 frame()。异步(ONNX/worker)后端需额外包装，
//   async 建议 true 并提供 load()，实时侧后续在 worker 里桥接（届时再扩展本契约）。
// ============================================================
import { peakTrack, yin, fusePoint } from '../core.mjs';

export const yinKernel = {
  id: 'yin-dual',
  name: 'YIN·频谱融合（默认）',

  // 单窗检测。win: Float32Array(原始时域, -1~1, 长度=config.windowSize)
  // cfg: { windowSize, fmin, fmax, voicing }  —— 只取本内核关心的字段
  // 返回（这些字段名是内核约定的"算法侧契约"）：
  //   freq   估算基频 Hz（未做任何门控的原始融合，静音=NaN）
  //   fA     频谱峰追踪候选 Hz（引擎A）
  //   fB     YIN 候选 Hz（引擎B）
  //   prom   峰突出度 dB（频谱引擎）
  //   purity 纯音度 0~1（主峰能量/全频带，越纯越接近1）
  //   str    YIN 周期强度 0~1（cmMin 谷值，越小越像有周期/有音高）——门控核心判据
  frame(win, sr, cfg) {
    const N = cfg.windowSize;
    const fmin = cfg.fmin, fmax = cfg.fmax;
    // 下面这五行就是从 dsp/detect.mjs 原内联逻辑原样搬来的：
    // 只平移调用位置，不改任何一条数值/公式，保证门控判定与改造前逐位一致。
    const ra = peakTrack(win, sr, { windowSize: N, hopSize: N, fmin, fmax });
    const fA = ra.f.length ? ra.f[0] : NaN;
    const prom = ra.prom.length ? ra.prom[0] : 0;
    const purity = (ra.purity && ra.purity.length) ? ra.purity[0] : 0;

    const rb = yin(win, sr, {
      windowSize: N, hopSize: N, fmin, fmax, threshold: 1 - (cfg.voicing ?? 85) / 100,
    });
    const fB = rb.f.length ? rb.f[0] : NaN;
    const str = (rb.str && rb.str.length) ? Math.min(1, Math.max(0, rb.str[0])) : 1;

    return { freq: fusePoint(fA, fB), prom, purity, str, fA, fB };
  },
};

export default yinKernel;