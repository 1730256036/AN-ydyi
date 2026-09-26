# NOTICE — vendor/basic-pitch

## 一、来源

本目录内容取自 **basic-pitch** v1.0.1：

| 项 | 值 |
|---|---|
| 上游项目 | <https://github.com/spotify/basic-pitch> |
| npm 包 | `@spotify/basic-pitch@1.0.1` |
| 版权 | Copyright 2022 Spotify AB |
| 许可 | Apache License 2.0（全文见本目录 [`LICENSE`](./LICENSE)） |

包含文件：`index.js`、`inference.js`、`matchers.js`、`toMidi.js`（取自上游 `esm/` 构建），
以及 `model/model.json` 与 `model/group1-shard1of1.bin`（预训练模型权重）。

## 二、已修改的文件（Apache-2.0 第 4(b) 条）

> §4(b)：*You must cause any modified files to carry prominent notices stating that You changed the files.*

按此要求，修改声明已**直接写入被修改文件的头部**。改动清单：

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `inference.js` | 第 1 行 `import * as tf from '@tensorflow/tfjs'` → `import * as tf from '../../dsp/bp-tf-proxy.mjs'` | 本项目零构建（不引入打包器），浏览器原生 ESM 无法解析裸模块说明符。`dsp/bp-tf-proxy.mjs` 是 20 行的桥，把命名导出转发到 `index.html` 以 UMD 加载的全局 `window.tf`。 |
| `toMidi.js` | 移除 `@tonejs/midi` 依赖（改为 `const Midi = null`） | `generateFileData` 不被本项目使用，砍掉该依赖以保持零构建。 |

`index.js`、`matchers.js` 与模型权重文件**未作修改**。

⚠️ 若按 `app.mjs` 中 `aiTranscribe` 上方的 CDN 命令重下上述文件，会覆盖这些声明，需重新补上。

## 三、版权声明的保留情况（Apache-2.0 第 4(c) 条）

上游发布的 `esm/` 构建产物**本身不含任何版权或许可头**（已核实：四个 `.js` 文件中
均无 `Copyright` / `@license` 字样），故本目录无额外版权声明需要保留。

`LICENSE` 全文已随本目录分发，满足第 4(a) 条。

## 四、上游 NOTICE 文件（Apache-2.0 第 4(d) 条）

上游仓库根目录含 `NOTICE` 文件，其内容如下（可读副本）：

```
Basic Pitch
Copyright 2022 Spotify AB

This product includes software developed at
Spotify AB (http://www.spotify.com/).

This product includes software from Librosa (ISC).
* Copyright (C) 2013--2017, librosa development team.

This product includes software from mir_eval (MIT)
* Copyright (C) 2014 Colin Raffel

This product includes software from numpy (BSD)
* Copyright (C) 2005-2022, NumPy Developers.

This product includes software from pretty-midi (MIT)
* Copyright (C) 2014 Colin Raffel

This product includes software from resampy (ISC)
* Copyright (C) 2016, Brian McFee

This product includes software from scipy (BSD)
* Copyright (C) 2001-2002 Enthought, Inc. 2003-2022, SciPy Developers

This product includes software from tensorflow (Apache 2.0)
* Copyright (C) 2019 Google, LLC <packages@tensorflow.org>

The tests for `basic-pitch` include audio files from the
Vocadito dataset liscened under Creative Commons
Attribution 4.0 International. The dataset can be found at:
https://zenodo.org/record/5578807#.YnRm5vPMKDU
```

> 说明：上游 NOTICE 中列出的 librosa / mir_eval / numpy / pretty-midi / resampy / scipy
> 等条目属于 **Python 版**的依赖，与本目录的 ESM 构建无关（§4(d) 允许排除与衍生作品无关的通知）。
> 此处按原文**完整保留**，以免自行删减产生歧义；与本目录实际相关的是
> *tensorflow (Apache 2.0)* 一条，对应 `vendor/tfjs/`。

## 五、本目录在整体许可中的位置

本项目整体以 **AGPL-3.0** 授权，但本目录内容**不适用**该许可，仍适用其上游的
Apache-2.0。详见根目录 README 的「第三方资产与许可」一节。
