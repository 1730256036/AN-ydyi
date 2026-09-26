# AN-ydyi · 音域音调仪

对着麦克风唱或吹口哨，画面实时跟着音高动。

一个网页版实时音高检测器：把麦克风音频逐帧分析成基频，喂给可插拔的 Canvas 动画模板，同时记录整条音高轨迹供回放、编辑和导出。

**零构建、零打包器** —— 原生 ES Module 直接跑，没有 webpack/vite/tsc 任何一步。所有第三方资源（音源采样、ONNX 模型运行时、音频合成引擎）都在本地，不依赖 CDN，断网可用。

---

## 特性

### 音高检测

- 四种基频检测内核，可热切换：**YIN（双阈值，默认）/ MPM / pYIN / SwiftF0**（ONNX 神经网络）
- 内核路由按置信度自动回退：主内核在某些段落失效时切到备用内核，不会出现整段空白曲线
- 八度误判由仲裁层处理 —— 多个候选频率互成 2 的幂时取低频，避免"唱着唱着跳高一个八度"
- **门控只有一份实现**（`dsp/detect.mjs`）：实时检测与离线重算走完全相同的代码，不会出现"回放和实时结果对不上"

### 动画模板

3 个可插拔模板，加一个模板 = 加一个文件：

| 模板 | 说明 |
|---|---|
| 音高轨迹 | 滚动曲线 + 半音格，音准偏差一目了然 |
| 钢琴块 | 音高曲线切成方块下落，配琴声回放 |
| 音高星盘 | 滚动音高场：音高线恒居中、星尘粒子随音而起 + 音准/音域读数（原「音高仪表」+「音高星尘」合并重做） |

接口约定见 `anim/registry.mjs` 顶部注释（每帧数据快照的字段含义都写在里面）。

### 录音 / 导入 / 存档

- 麦克风录音：支持暂停续录、试听已录片段、剪辑
- 导入音频文件（wav/mp3/webm 等）、导入 MIDI
- **倍速播放 0.25×~4×**：导入音频 / MIDI / 存档回放 与 录音试听共用同一档位。默认 **变速不变调**（`dsp/stretch.mjs`，WSOLA 时域颗粒重排：慢放只变慢，音高不动，适合听细节）；勾上「变调」则为磁带式，音高跟倍速一起变
- **录音、导入音频、MIDI 三种来源自动落库存档**，一条不落 —— 每条存成工作目录 `archives\` 里的一个 `.ydyi` 文件（资源管理器里直接可见、可拷走备份）；存档面板可打开、改名、删除

### 钢琴块与琴声

- 音高曲线 → 钢琴块，**三档出块算法**：颗粒（谷切精细分块，默认）/ 经典（纯音高分段）/ HMM 序列（序列级最优解码，回声专用）
- **29 种音色**回放，采样全部内置（约 800 个 mp3，随仓库分发），离线可用
- 回声效果（包络谷切分 + 定案尾窗 + 段确认）
- AI 转谱：音频 → 音符表（基于 basic-pitch，模型权重已内置）

### 其他

- **纯净模式**：隐藏全部 UI，只留动画，可全屏；配合录屏可导出 WebM 视频
- **曲库**：内置东方 Project 与古典示范曲，支持收藏与自建分组歌单
- 导出：音高曲线 CSV、音符表 MIDI
- 日志面板：导出运行日志与逐帧调试数据，用于排查检测问题
- PWA：可安装到桌面或手机，脱离浏览器地址栏独立窗口运行

---

## 快速开始

需要 **Node.js 22.15+**。

> 只跑服务本身（`node server.mjs`）Node 18+ 就够；但 `npm test` 整条测试链需要 **Node 22.15+**——
> `test/smoke.mjs` 与 `test/cap-record.mjs` 用了 `node:module` 的 `registerHooks`，那是 22.15 才有的 API。
> （`package.json` 的 `engines` 仍写 `>=18`，因为"能跑应用"这条门槛确实只有 18；
>  只是跑测试要更高的版本，别被 engines 误导。）

```bash
npm install
npm start
```

不用 npm 也可以：`npm start` 就是 `node server.mjs`。`npm install` 装的是检测内核之一所需的 ONNX 运行时（`onnxruntime-web`）和音频合成引擎（`spessasynth_lib`）。

> 依赖里还有两个**当前没有任何代码使用**的项，属历史遗留：`three`（只剩 `index.html` 的 importmap
> 和两个测试里的重定向桩还提到它）与 `onnxruntime-node`（devDependency，全仓无 import）。
> 清理它们要动安装面，故先在这里记一笔。

浏览器打开 <http://localhost:8000>，点「允许」授予麦克风权限。

**为什么必须走本地服务器**：Web Audio 的 `getUserMedia` 只在安全上下文（HTTPS 或 localhost）下可用。直接双击 `index.html` 以 `file://` 打开，浏览器不会给你麦克风。

端口默认 8000，可用环境变量改：`PORT=9000 npm start`

浏览器建议用 Chrome / Edge（依赖 AudioWorklet、Web Audio、IndexedDB）。

---

## 测试

```bash
npm test        # 43 个脚本，全部通过
```

`npm test` 就是 `package.json` 里 `test` 字段那条 `node xxx.mjs && node yyy.mjs && …` 的长链，没有测试框架，也可以单独挑一个直接跑。
测试**全部是 node 直跑**，不需要浏览器、不需要起服务。做法是用一套极简 DOM 桩驱动 `app.mjs`：装桩 → import 模块 → 模拟点击与哈希对比。因此有一条硬约束：**`app.mjs` 模块顶层立即执行的代码里，不许引入桩还没模拟的新 DOM API**，否则整条测试链会红。

测试覆盖：检测算法仿真、内核等价比对、变速不变调（拉伸后仍由 YIN 量回原频率）、门控行为、SMF 往返、存档读写、音频路由、动画模板冒烟、PWA、控件作用域不变量等。

另有几个手工工具**不进测试链**（依赖本地素材、耗时数秒），需要时手动跑：

```bash
node test/seg-ab.mjs                 # 钢琴块分段 A/B 对比（默认读 samples/ 下的录音）
node test/bench-real.mjs             # 真实录音与参照 MIDI 的一致性基准
node test/tongue-diag.mjs <录音.wav>  # 单段录音的逐帧诊断
node test/kb-preview.mjs             # 键盘半音格预览
```

---

## 目录结构

```
app.mjs            主控制器：状态机、视图切换、事件接线（域模块在 app/ 下）
app/               域模块（audio / capture / echo / file-store / library / logpanel / player / proj-panel）
dsp/               检测算法（core / detect / envelope / analyze / analyze-pool / analyze.worker / notes-hmm / smf / stretch / kernels/）
anim/              动画模板 + registry + 琴声引擎（pitchTrail / pianoBlocks / pitchOrb；另有一个未接线的 practice.mjs）
proj/              存档序列化、导入导出、PCM 分块、WebM 时长修复（旧 IndexedDB 代码只剩一次性迁移用）
test/              测试（全部 node 直跑）
demo/              内置示范曲 MIDI
vendor/            第三方资产（basic-pitch 补丁版与模型权重、TensorFlow.js 运行时、SwiftF0 模型、SpessaSynth worklet、音源采样）
tools/             构建辅助脚本（图标生成、按端口停服）
archives/          存档真相源：每条存档一个 .ydyi 文件（不入库）
samples/           本地测试音频素材（不入库）
logs/              本地日志与调试导出（不入库）
```

### 架构约定

- **域模块自持状态与 DOM**：`app/` 下每个域自己管自己的元素，共用 canvas 通过注入传递
- **跨域一律注入，不互相 import**：接线集中在 `app.mjs` 底部，模块之间没有反向依赖
- **状态导出用 `export let`**：ESM 的 import 绑定不可赋值，语言层面强制"单写者"
- **帧时间戳 = 分析窗起点**：实时用 `tMsOfWindow()` 而非"现在时刻"，否则实时与回放会错位

---

## 第三方资产与许可

本仓库内含以下第三方内容，**版权归各自作者所有**，使用与再分发前请核对上游许可：

| 路径 | 来源 | 说明 |
|---|---|---|
| `vendor/basic-pitch/` | Google Magenta basic-pitch | Apache-2.0；此处为打了本地化补丁的 4 个源文件 + 随仓库分发的模型权重 |
| `vendor/tfjs/` | TensorFlow.js | Apache-2.0；AI 转谱运行时的浏览器构建（`tf.min.js`） |
| `vendor/swiftf0/` | SwiftF0（lars76/swift-f0） | MIT；基频检测内核的 ONNX 模型（388KB） |
| `vendor/spessasynth/` | spessasynth_lib | AudioWorklet 处理器（浏览器 `addModule` 需独立 URL，故拷入 vendor） |
| `vendor/soundfonts/FluidR3_GM/` | FluidR3 GM SoundFont | 琴声采样 |
| `vendor/soundfonts/salamander/` | Salamander Grand Piano | 琴声采样 |
| `demo/*.mid` | 东方 Project 同人编曲 + 古典曲目 | 仅作功能示范 |

AI 转谱需要的两个大文件随仓库分发（basic-pitch 模型权重 + `vendor/tfjs/tf.min.js`，约 2.3MB），开箱即用；
`app.mjs` 中 `aiTranscribe` 附近的恢复说明只在文件被删时才用得上。SwiftF0 的 `model.onnx`（388KB）同样已入库。

---

## 已知限制

- **手机 / 局域网访问需要 HTTPS**：`server.mjs` 是纯 HTTP 服务器，只有 `localhost` 被浏览器视为安全上下文。想用手机连电脑调试，需要自行套一层 HTTPS（或部署到带 HTTPS 的静态托管）。
- **移动端 UI 未适配**：界面按桌面宽屏设计，手机上可用但布局不理想。
- **录屏输出 WebM**：目前走的是 `MediaRecorder` 实时捕获，不提供 MP4 转码。
- **倍速的代价**：变速不变调走的是颗粒重排（OLA/WSOLA），极端档位（0.25×/4×）有可听出的颗粒感，这是该类算法的固有性质；另外拉伸后样点超过约 5000 万（≈ 10 分钟音频降低到 0.25×）时会自动退回磁带式并在状态栏说明，避免把内存吃穿。MIDI 工程声音由合成琴声产生，变速天然不变调，故它的「变调」开关是隐藏的。

---

## 项目状态

个人项目，仍在持续调整中。检测参数、动画模板和交互细节都经过真实录音的反复校准。
