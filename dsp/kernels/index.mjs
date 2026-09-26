// ============================================================
// dsp/kernels/index.mjs —— 检测内核注册表
//
// 检测内核 = 可插拔的音高估算器（见 ./yin.mjs 顶部的接口契约）。
// 这里只负责：注册、按 id 解析、返回当前可选列表。
// 消费方（createDetector）通过 resolveKernel(key) 拿内核，拿不到回退默认。
//
// 加新算法流程（MPM / pYIN / …）：
//   1. 新建 dsp/kernels/<name>.mjs，导出同款 { id, name, frame, load?, async }；
//   2. 在下面 import + kernels.set(...) 注册；
//   3. createDetector({ kernel: '你的id' }) 即可切换，外围判定逻辑零改动。
// ============================================================
import { yinKernel } from './yin.mjs';
import { mpmKernel } from './mpm.mjs';
import { pyinKernel } from './pyin.mjs';

// id -> 内核对象。默认/回退总是指向 yin（resolveKernel 兜底）。
// hidden=true 的内核可被 resolveKernel 使用，但不对外下拉。
const kernels = new Map();
kernels.set(yinKernel.id, yinKernel);
kernels.set(mpmKernel.id, mpmKernel);
kernels.set(pyinKernel.id, pyinKernel);

export function registerKernel(k) {
  if (k && k.id && typeof k.frame === 'function') kernels.set(k.id, k);
}

// 按 id 解析内核；未知 id 回退默认(yin)，并告警（防止静默用错算法误以为切换成功）。
export function resolveKernel(key) {
  const got = key ? kernels.get(key) : null;
  if (key && !got) {
    console.warn(`[dsp] 未知检测内核 '${key}'，回退默认 '${yinKernel.id}'`);
  }
  return got || yinKernel;
}

export function availableKernels() { return [...kernels.values()].filter(k => !k.hidden); }

export { yinKernel, mpmKernel, pyinKernel };
export default { registerKernel, resolveKernel, availableKernels };