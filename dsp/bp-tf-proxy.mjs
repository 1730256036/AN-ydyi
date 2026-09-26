// ============================================================
// dsp/bp-tf-proxy.mjs —— vendor/basic-pitch 的 tfjs 命名导出桥(全本地)
// basic-pitch esm 用 `import * as tf from '@tensorflow/tfjs'`；本地化方案：
// index.html 先同步加载 vendor/tfjs/tf.min.js(UMD → window.tf)，
// inference.js 里的 import 已 sed 指向本模块，按需转发到 window.tf。
// 导出清单 = grep -oh "tf\.[a-zA-Z0-9_]*" vendor/basic-pitch/*.js 的并集
// (注意带数字的 API 如 concat1d，正则漏数字会踩 "not a function")。
// basic-pitch 的补丁源文件/模型权重与 tfjs 均已入库（.gitignore 白名单放行），clone 即可用；
// 万一被删，恢复命令见 app.mjs 中 aiTranscribe 上方的注释。
// ============================================================
const tf = () => window.tf;

export const loadGraphModel = (...a) => tf().loadGraphModel(...a);
export const tensor = (...a) => tf().tensor(...a);
export const zeros = (...a) => tf().zeros(...a);
export const concat1d = (...a) => tf().concat1d(...a);
export const expandDims = (...a) => tf().expandDims(...a);
export const slice = (...a) => tf().slice(...a);
export const signal = {
  frame: (...a) => tf().signal.frame(...a),
};
