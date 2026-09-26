# NOTICE — vendor/basic-pitch

## 来源

本目录内容取自 **basic-pitch** v1.0.1：

| 项 | 值 |
|---|---|
| 上游项目 | <https://github.com/spotify/basic-pitch> |
| npm 包 | `@spotify/basic-pitch@1.0.1` |
| 版权 | Spotify AB |
| 许可 | Apache License 2.0（全文见本目录 [`LICENSE`](./LICENSE)） |

包含文件：`index.js`、`inference.js`、`matchers.js`、`toMidi.js`（取自上游 `esm/` 构建），
以及 `model/model.json` 与 `model/group1-shard1of1.bin`（预训练模型权重）。

## ⚠️ 已修改

Apache-2.0 第 4(c) 条要求对修改过的文件作显著标注，改动如下：

| 文件 | 改动内容 |
|---|---|
| `inference.js` | 第 1 行由 `import * as tf from '@tensorflow/tfjs'` 改为 `import * as tf from '../../dsp/bp-tf-proxy.mjs'`。 |

**改动原因**：本项目零构建（不引入 webpack/vite 等打包器），浏览器原生 ESM 无法解析
`@tensorflow/tfjs` 这类裸模块说明符。`dsp/bp-tf-proxy.mjs` 是一个 20 行的桥，
把 basic-pitch 用到的命名导出转发到 `index.html` 通过 UMD 方式加载的全局 `window.tf`。

除上述一行外，其余文件与上游分发版一致，未作修改。
