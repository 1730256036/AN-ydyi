// ============================================================
// anim/pianoBlocks.mjs —— 钢琴块模板 (SeeMusic/Rousseau 风格, kind:'full', 2D)
//
// 设计(2026-09-06 定案，调研 SeeMusic/PianoVFX/notefall 后自研)：
//   - 底部画键盘(音域自适应)，上方音符块下落：块底在音符起始时刻命中键盘线，
//   - 音高严格 snap 到半音格；分段=run切分+颤音折叠，转音/滑音必成块；
//   - 12 音高各自配色(hsl(pc*30))，击键瞬间在对应键位喷粒子，
//   - 键盘顶发光带 + 命中键染色 + 假 bloom(离屏 blur + lighter 叠回)。
//
// 双数据源：
//   - 工程回放(d.projMode/d.projFrames)：frames 一次性分段成音符事件表并缓存
//     (按 frames 引用)，整段"未来已知" → 完整 Synthesia 下落块；
//   - 实时录音：hist 收点(同 pitchTrail 节流)每帧重新分段(≤几百点开销可忽略)，
//     未来未知 → 音符从键盘线"生长条"升起，结束后升走淡出。
//
// 数据：d.audioMs / d.resetKey / d.projMode / d.projFrames / d.voiced /
//       d.lastGoodFreq / d.statsMin / d.statsMax
// ============================================================

// 钢琴声引擎已抽出共享(2026-09-13)：跟音练习/回声模式也弹琴，逐行搬去
// anim/piano-sound.mjs，行为与存储键零变化。
import { ensureAudio, playPianoNote, setSoundEnabled, setPianoVolume, soundEnabled, soundStatus, listTimbres, getTimbre, setTimbre } from './piano-sound.mjs';

// —— 可调 ——
const LOOKAHEAD_MS = 4200;    // 未来可视窗：4200ms 的未来铺满键盘线上方
const GAP_MS = 90;            // 相邻发声点间隔 >90ms 视为音符间断
const MERGE_GAP_MS = 110;     // 同音高音符间隔 <110ms 合并(避免同一音被静音帧切碎)
const MIN_NOTE_MS = 30;       // run 成块下限：短于 30ms(≈1帧)视为噪声丢弃
const OSC_SPAN_MS = 900;      // 实时冻结安全裕量基准(原颤音折叠组最大跨度；SAFE_MS 以它为下限)
const DOT_MS = 20;            // 实时采样节流(≈50 点/s；30 时 40ms 短音仅 1 点必被噪声过滤)
const MAXP = 600;             // 粒子上限
// —— 方案A(v4, 2026-09-11) 段边界参数：先分段、后定音 ——
// HYST_SEMI 为旧"逐帧吸附"实现(滞回换格)的常数：单帧不稳直连块。
// v4 弃用逐帧滞回，改由段边界+段内投票定音，见 segmentByPitch。
const HYST_SEMI = 0.55;       // （保留供 run 语义参考）
const BOUNDARY_SEMI = 0.70;   // 段边界①：原始帧偏离当前段中心(在线中值)超 0.7 半音
const BOUNDARY_CNT = 2;       // 且同向连续 ≥2 帧才确认断开（单帧离群/抖动被吸收）
// ⚠ 2026-09-22 复核：这条常量全文件【无引用】，segmentByPitch 里也不存在"段内投票样本不足
//   就并入相邻段"这段逻辑 —— 旧注释承诺的行为从未实现。保留位置只为不惊动历史 diff，
//   别再以为调它能改分段行为（真要这个保护得自己写）。
const SEG_MIN_VOTE = 3;       // （未使用，见上）
const SPLIT_DEPTH_DB = 4;     // run 内 rms 包络深谷切分阈值(谷深 dB)——治快吐糊成长块
                              // (实测口哨快吐谷深 4.7~8.6dB，6dB 会漏掉一半气口)
const SKIP_SOUND_MS = 30;     // 弹奏兜底阈值=MIN_NOTE_MS：能成块的都能出声(60 会误伤快吐短块)
const MIN_BLOCK_H = 14;       // 块最小可见高度(px)：46ms 短块按时速只有~4px,肉眼=闪丝(2026-09-07)
const ENV_SPLIT_DB = 3;       // 细粒度包络气口切分阈值(谷深 dB，相对两侧峰)

const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);

let ctx = null, W = 0, H = 0;
let off = null, offCtx = null;          // bloom 离屏
let geom = { lo: -1, hi: -1, geo: null };
let parts = [];                          // 粒子
let lastNow = 0;
let prevAms = -1;
let lastKey = null;
let seenKeys = new Set();                // 粒子已喷过的音符起点(t0_midi)
// 工程音符缓存(按 frames 引用判失效，与 roughCache 同思路)
let cache = { frames: null, env: undefined, notes: [] };
// 实时
let hist = [], lastDotT = -1e9;
let dbgNotes = [];              // 最近一帧实时分段结果(桩烟测/诊断用)
let dbgTrace = [];              // 实时管线帧级追踪(黑匣子：用户导出后离线验尸)

// —— 音符分段 v3.1：滞回吸附 → run → 包络深谷切分 → 过滤合并 ——
// v2 只看音高，两个先天盲区：
//   快吐同音(间隔<90ms 或连吐无静音)必然糊成一个长块——纯音高序列里"连吐两个C4"
//   与"一个长C4"不可区分，必须引入幅度包络(帧里现成有 rms，v2 没用)。
// v3 新增：②rms 包络深谷切分(谷深>阈值=吐音气口，在谷底切)。
// 数据约定：pts 项可带 {rms, prom, purity}(帧明细)；缺省时②自动跳过(纯音高输入兼容)。
// 2026-09-15 升级为「出块算法」选择；2026-09-19 收敛为两档：
//   'grain'   = 颗粒(默认)：包络谷切+音高切分，极度精细，快吐曲目用；
//   'classic' = 经典：纯音高分段(v4 管线关掉全部包络逻辑)=谷切分之前的最开始算法，
//               快吐同音会连成一块、变音才切。
// localStorage 'ydyi_block_algo'；旧值 'precise'/'vibrato' 自动回退颗粒。
const ALGO_VALUES = ['grain', 'classic', 'hmm'];   // 'hmm' 只在回声域分岔(app/echo.mjs)；本文件的分段逻辑对它等同 grain
let blockAlgo = 'grain';

// ============================================================
// —— 前端特效层 v1（2026-09-12）——
// 目标：对标钢琴视频软件的粒子观感（音符珠链拖尾 / 命中光球 / 光洒琴键 / 多级泛光）。
// 运动模型参考同类视觉软件的粒子参数（Piano VFX 的 Unity+HDRP+VFX Graph）：
//   两段速度插值(起点→终点) + 重力 + 噪声湍流力 + 寿命曲线 + 低发射率(→离散珠链而非一条线)。
// v1.1（2026-09-20）：命中加「爆闪 flipbook」（参考 MIDIVisualizer 的 flashes——
//   开源 SeeMusic 风格渲染器），程序化生成 8 帧放射爆闪，见 hitFlipbook()/drawHits ⑤。
// v1.2~v1.4（2026-09-20）：烟层(染色) + 火花流(curl noise 流场) + 珠链双层光核，
//   三层配方对标参考视频的「带色火花流 + 冒烟光感」。
// ⚠️ 本层**只作用于渲染**：分段/音频/弹奏逻辑一行不改。整层可用 FX_TRAIL.on / FX_HIT.on /
// FX_BLOOM.multi 单独关掉，便于逐层判断效果。
//
// ★★ 核心纪律：**发光 = 有声音**（2026-09-12 实测纠正）★★
//   「只有接触到钢琴块（即有声音）的时候才发光，声音结束后不该继续发光。」
//   所以：① 只在 [t0, t1) 发声窗口内吐珠——下落途中(未发声)不吐；
//        ② 声音一停，属于该音的粒子/光球立即进入 `offFade` 快速淡出，不让余光滑到下一拍。
//   判据统一用 `active`(正在发声的键集合)，工程回放与实时录音两条路径同源。
// ★★ v1.5 细分（2026-09-20）：上述"音停即散"只适用于【直接表达声音】的层——
//   珠链/光球/光柱。烟与火花是【氛围余韵】：发射窗口跟着声音（没声音绝不发射），
//   但寿命归粒子自己——音停后继续飘完自然寿命再消散。参考视频的余韵感正是来自
//   这里（"音一结束特效立刻消失，所以没有那种感觉"）。
//   暂停/停止时烟/火花与块一起整体冻结（暂停后动画不许还在动的模板约定不变）。
// v1.6（2026-09-20 烟层炫化）：烟吃 curl 流场 + 双贴图翻滚 + 内芯光染。
// v9 键盘真实感（2026-09-20，调研 piano-tutorial-player 的 per-key pointLight +
//   SeeMusic/Rousseau 的漆面反射后落地）：①动态点光层 drawKeyLights——活跃键/命中点
//   挂彩色点光，邻键按距离吃光（3D pointLight 的 2D 等价物）；②下落块漆面反射
//   drawReflections——块底越贴键线，键面同色反光越长越亮；③键帽精灵烤入象牙纹理
//   （低频竖纹+微噪声+近端磨损泛黄）+ 逐键微差色罩。低档不含①②（仍只琴键自染色）。
// ============================================================
const FX_TRAIL = {
  on: true,
  rate: 22,            // 每个发射源每秒吐珠数（低速率 → 离散珠链）
  maxSrc: 6,           // 同时发射的源上限（源更多则按比例摊薄速率，防密集音符爆量）
  max: 900,            // 珠链粒子池上限
  life: [0.40, 0.95],  // 寿命(秒)随机区间（**仅在持续发声期内有效**）
  offFade: 0.14,       // 音停后的快速淡出时长(秒) ← 保证"没声音就不发光"
  v1x: [-46, 46],      // 初速 x 范围(px/s)
  v1y: [-250, -120],   // 初速 y 范围(负=向上)
  v2y: [-40, 10],      // 末速 y（两段速度的终点）
  turb: 135,           // 湍流强度(px/s) → 轨迹弯曲幅度
  turbFreq: 1.0,       // 湍流空间频率
  grav: 70,            // 重力(px/s²)
  r0: 9.5,             // 出生半径(px)
  rShrink: 0.62,       // 寿命末端半径衰减比例
  steps: 8,            // 颜色渐变台阶数（音符色 → 白）
};
const FX_HIT = {
  on: true,
  life: 0.50,          // 冲击光球自然寿命(秒)
  offFade: 0.14,       // 音停后的快速淡出时长(秒)
  ballR: 46,           // 光球最终半径(px)
  ringR: 96,           // 冲击环最终半径(px)
  spill: 1.15,         // 光洒琴键的半宽（以键宽为单位）
  burst: 14,           // 命中瞬间额外喷出的珠数
};
const FX_BLOOM = {
  multi: true,         // 多级降采样泛光（替代旧的全画布单层 blur：更省更"肉"）
  levels: [[2, 5.0, 0.62], [4, 4.0, 0.40]],   // [降采样倍数, blur 半径(降采样域), 权重]
  single: 0.42,        // multi=false 时沿用旧参数
};
// 烟雾层（2026-09-20，配方来自 Piano VFX/VFX Graph 的「烟+光双层混合」：
//   烟 = 大尺寸低 alpha 噪声贴图 + 普通 alpha 混合(source-over)，负责体积感；
//   光 = 原有 additive 珠链/光球，负责亮度。两层叠加 + 泛光 = "冒烟的高级光感"。
//   单独堆亮粒子永远出不了烟感——这是本轮的核心认知。）
const FX_SMOKE = {
  on: true,
  rate: 6,             // 每源每秒发烟团数（烟必须少——大精灵 overdraw 高）
  maxSrc: 6,
  max: 160,            // 烟团池上限
  life: [1.2, 2.4],    // 寿命(秒)：比珠链长一个量级 → "慢慢冒"（音停后也活满）
  size: [46, 120],     // 出生半径(px)
  grow: 1.9,           // 生命末端膨胀倍数（先膨胀后消散）
  rise: [-46, -14],    // 上升速度(px/s)
  spin: [-0.7, 0.7],   // 自旋速度(rad/s)
  alpha: 0.11,         // 单团基础透明度（本体层；内芯光染层另乘）
  curl: 55,            // 涡流场推力(px/s²)——v1.6：烟与火花共用流场 → 整幅画面统一卷动
};
// 火花流层（v1.3，2026-09-20：参考截图指出"要的是带色的发光粒子流，
// 飘起来无规律"）。技术 = curl noise 流场：粒子被噪声场的旋度推动，
// 轨迹自然卷曲缠绕（流体感），+ 高发射率小亮粒 + additive = 密集火花上升流。
// 参考：bobbyroe/curl-particles、KAYAC curl-noise 文章、VFX Graph Additive sparkle。
const FX_EMBER = {
  on: true,
  rate: 48,            // 每源每秒颗数（密集是观感的一半生命）
  maxSrc: 6,
  max: 1100,           // 火花池上限（小精灵 + lighter，overdraw 可控）
  life: [0.8, 1.8],    // 寿命(秒)：音停后火花也活满（氛围余韵）
  v0x: [-34, 34],      // 出射初速 x
  vy0: [-320, -140],   // 出射上冲（v1.4：加码——用户嫌飞得不够高）
  buoy: -46,           // 浮力(px/s²，负=持续上飘)
  curl: 150,           // 涡流场推力(px/s²)——"无规律卷曲"的主导项
  curlFreq: 0.02,      // 流场空间频率（越大卷越小越碎）
  curlSpeed: 0.8,      // 流场时间演化速度（场自己在变 → 轨迹不重复）
  drag: 1.15,          // 速度阻尼(1/s)（v1.4：调小 → 同样初速飞更高）
  r: [1.0, 2.8],       // 火花半径(px)
};

// 键线能量条（v11，2026-09-20，参考截图定案·风格化路线）：
// 键线不再是淡发光带，而是「白热芯线 + 光晕 + 沿线闪粒子 + 流动明暗」的能量条。
// 配方来自 glow-line 教程共识：多层辉光（外淡内亮）+ lighter 加法 + 粒子池防 GC。
// 粒子发射：环境均匀（全线都有）+ 活跃键加权（弹哪段哪段亮=参考图的热点分布）。
// 低档只画静态芯线+光晕（无粒子无流动）；暂停冻结（模板约定）。
const FX_LINE = {
  on: true,
  rate: 90,            // 环境发射率(颗/秒，沿线均匀撒)——v11.1 用户要"激光"级密度
  actBoost: 150,       // 每个活跃键的额外发射率(颗/秒，热点加权)
  max: 420,            // 粒子池上限（小精灵 + lighter，overdraw 可控）
  life: [0.4, 1.1],    // 寿命(秒)——短命高周转 = 持续浮动感
  r: [1.0, 3.0],       // 半径(px)
  drift: 9,            // 沿线漂浮速度上限(px/s)
  rise: [-14, -2],     // 缓慢上飘(px/s)
  tw: [4, 9],          // 闪烁频率(Hz)
};

// 键盘动态光照层（2026-09-20 v9，调研 piano-tutorial-player/SeeMusic/Rousseau 后落地）：
// 3D 里"键被特效照亮"= per-key pointLight；实拍视频 = 键上贴 LED 灯条。2D 等价物 =
// 活跃键/命中点各挂一盏彩色点光（径向渐变 + lighter 叠回键面），邻键按距离衰减吃光
// ——键不再"只会自己染自己"，烟/火花经过时键面真的有光斑。
const KEY_LIGHT = {
  on: true,
  r: 3.2,              // 点光半径（以白键宽为单位）
  a: 0.15,             // 活跃键点光强度
  hitA: 0.20,          // 命中点光强度（随命中寿命衰减）
};
// 下落块漆面反射（SeeMusic/Rousseau 系标志性效果）：块越接近键线，
// 键面上那道同色反光越亮越长——钢琴漆面对环境的镜像。
const REFL = {
  on: true,
  dist: 300,           // 反射可见的块底高度范围(px)
  maxLen: 0.55,        // 反射条最长占键可见高度比例
  a: 0.38,             // 贴线时的反射强度
};

// —— 键盘观感参数（2026-09-12 按真实钢琴照片重调，集中可调）——
// 三个"不像真琴"的地方：① 白键用横向"圆柱光感"渐变 → 每个键像一根金属管；
// ② 白键靠"缩窄键宽"留缝 → 露出近黑底，宽屏下像一根根独立板条；
// ③ 黑键底部那条亮灰"前立面"太亮太宽 → 像在黑键脚上贴了胶带。
const KB = {
  sep: 1.0,                        // 白键之间的缝宽(px)：画成深灰细线，而不是让黑底露出来
  sepCol: 'rgba(24,29,37,.92)',
  frontFrac: 0.11,                 // 白键前立面(朝向观者那一面)占键高比例 → 键的"厚度"
  blackLen: 0.66,                  // 黑键长 / 键高（真实钢琴约 0.66~0.68）
  blackFront: 0.09,                // 黑键前立面占黑键长度比例（窄！宽了就成胶带）
  feltH: 4,                        // 红毡条高度(px)
  sheen: 0.07,                     // 键面玻璃反光强度
  shadow: 0.34,                    // 黑键投在白键上的影强度
};

const trail = [];                 // 珠链粒子
const hits = [];                  // 命中光球
const smoke = [];                 // 烟雾粒子（v1.2：大团低 alpha，source-over）
const embers = [];                // 火花流粒子（v1.3：小亮粒 + curl 流场，additive）
const lineParts = [];             // 键线能量条粒子（v11：贴线漂浮 + 正弦闪烁）
let prevKeys = new Set();         // 上一帧活跃键（命中检测用）
const SPRITE_CACHE = new Map();   // (pc*steps+step) → 预渲染软球精灵
let bloomBufs = null;             // 多级泛光缓冲
const SPRITE_R = 32;              // 软球精灵半径(px)

// 特效品质三档（2026-09-20，性能亲民化）：切档只翻开关与清池，零重建零分配。
//   low  = 只琴键点亮（无珠链/命中/烟/火花/泛光——核显/集显友好）
//   mid  = 珠链 + 命中 + 泛光（砍掉烟/火花两个 overdraw 大户）
//   high = 全开（默认）
// 持久化在 app.mjs（localStorage ydyi_fx_quality）；模块加载时自读一次兜底，
// 免得"面板重建前的那几帧"先按高档跑。
let fxQuality = 'high';
function applyFxQuality() {
  FX_TRAIL.on = fxQuality !== 'low';
  FX_HIT.on = fxQuality !== 'low';
  FX_SMOKE.on = fxQuality === 'high';
  FX_EMBER.on = fxQuality === 'high';
  FX_LINE.on = fxQuality !== 'low';                 // 能量线：低档只留静态芯线+光晕
  if (fxQuality === 'low') { trail.length = 0; hits.length = 0; lineParts.length = 0; }   // 立即清场
  if (fxQuality !== 'high') { smoke.length = 0; embers.length = 0; }
}
try {
  const _fxq = localStorage.getItem('ydyi_fx_quality');
  if (['low', 'mid', 'high'].includes(_fxq)) fxQuality = _fxq;
} catch (e) {}
applyFxQuality();

export function __dbgNotes() { return dbgNotes; }   // 桩烟测：读最近实时分段结果
// 桩烟测：读特效层存活量（珠链粒子数 / 命中光球数）。特效是渲染层，只能用这种方式断言
// "真的喷出来了"，否则改坏了也只是画面少点东西、测试全绿。
export function __dbgFx() { return { trail: trail.length, hits: hits.length, smoke: smoke.length, embers: embers.length, line: lineParts.length, sprites: SPRITE_CACHE.size }; }
// 离线预览专用（只有离线脚本会调它，运行时零开销）：把单片键帽的原始 RGBA 取出来，
// 让脚本能在**没有浏览器**的情况下把键帽渲染成 PNG 做外观审查。
export function __kbSpriteRGBA(kind, wPx, hPx, body, dip) {
  const cv = kbMakeSprite({ w: wPx, h: hPx }, body, kind, dip);
  const g2 = cv && cv.getContext && cv.getContext('2d');
  if (!g2 || !g2.getImageData) return null;
  const im = g2.getImageData(0, 0, wPx, hPx);
  return { w: wPx, h: hPx, data: im.data };
}
export function __dbgDump() {
  return {
    trace: dbgTrace,            // 帧级：aMs/点数/块数/冻结数/块明细ns
    hist: (hist.length ? hist : lastHist),   // 原始采样点(停止后取留存副本)
    envCuts,                    // 已定案包络切点
    liveFrozen,                 // 已冻结音符
    blockAlgo,
  };
}
export function setBlockAlgo(v) {  // 出块算法档位：'grain'|'classic'|'hmm'，未知值回退颗粒('hmm' 仅在回声域分岔)
  blockAlgo = ALGO_VALUES.includes(v) ? v : 'grain';
  try { localStorage.setItem('ydyi_block_algo', blockAlgo); } catch (e) {}
  cache = { frames: null, env: undefined, notes: [] };   // 失效工程分段缓存(否则回放中切换无效果)
  liveFrozen = []; liveFrozenEndT = -1;                  // 解冻实时块(重放区间按新状态重新落定)
}
export function getBlockAlgo() { return blockAlgo; }   // snapshot 经此把档位带给回声域(app 编排，域间不互import)

export function segmentPoints(pts, env, preCuts) {
  // preCuts：调用方已定案的包络切点时刻表(实时路径用,保证单调只增)。
  // 实时 recEnv 每帧增长,谷深随之重算会追溯变化 → 已显示的块被追溯切开/碎片
  // 丢弃 = "闪一下就消失"。离线路径 env 是最终态,不传 preCuts 走内部重扫。
  // 0) 细粒度包络气口切点(可选, dsp/envelope.mjs 产出)：93ms 检测窗看不见
  //    30-60ms 的吐音气口(实测快吐段旧窗仅 5 谷，10ms 细窗 43 谷)。
  //    谷=局部极小且谷深≥ENV_SPLIT_DB(相对两侧爬坡峰) → 强制断开时刻表。
  const cutTimes = [];
  if (blockAlgo === 'classic') {
    // 经典档：包络谷切分之前的最开始算法——env 整条忽略，纯音高+gap 分段
  } else if (preCuts) {
    for (const t of preCuts) cutTimes.push(t);
  } else if (env && env.length > 4) {
    for (let i = 2; i < env.length - 2; i++) {
      if (env[i].rms < env[i - 1].rms && env[i].rms <= env[i + 1].rms) {
        let pl = i - 1; while (pl > 1 && env[pl - 1].rms <= env[pl].rms) pl--;
        let pr = i + 1; while (pr < env.length - 2 && env[pr + 1].rms <= env[pr].rms) pr++;
        const depth = 20 * Math.log10(Math.max(env[pl].rms, env[pr].rms) / env[i].rms);
        if (depth >= ENV_SPLIT_DB) cutTimes.push(env[i].t);
      }
    }
  }

  // 1) 先分段、后定音(方案A v4)：段边界由三信号 OR 决定
  //    ① 音高持续跳变：原始帧相对当前段中心(段内在线中值)偏离 >BOUNDARY_SEMI
  //       且同向连续 ≥BOUNDARY_CNT 帧才切——单帧离群/半音内抖动被吸收(旧逐帧滞回
  //       做不到：>0.55 半音的抖动会撕裂裂纹，纯场景 1 号直接碎成 C#4 交替块)；
  //    ② 包络深谷/气口(cutTimes)：桥接帧把气口在数据上焊死，靠这里强制断开；
  //    ③ 数据级静音 gap：相邻帧间隔 >GAP_MS(旧逻辑保留)。
  //    断出的段内定音 = round(midi) 直方图众数(段内所有采样投票，起调帧/中间离群帧
  //    不独裁)，而非逐帧 round+滞回。断开的段打 cutNext/cutPrev，同音合并禁止跨越。
  const runs = segmentByPitch(pts, cutTimes);

  // 2) 包络深谷切分：run 内部 rms 局部极小、谷深 ≥SPLIT_DEPTH_DB → 谷底切开(吐音气口)
  //    切出的气口帧丢弃；无 rms 数据的 run 原样通过。
  const split = [];
  for (const r of runs) {
    const vs = (r.pts || []).filter(p => typeof p.rms === 'number' && p.rms > 0);
    if (blockAlgo === 'classic' || vs.length < 5) { split.push(r); continue; }
    const depthDb = SPLIT_DEPTH_DB;
    const cuts = [];
    for (let i = 1; i < vs.length - 1; i++) {
      if (vs[i].rms < vs[i - 1].rms && vs[i].rms <= vs[i + 1].rms) {
        let pl = i - 1; while (pl > 0 && vs[pl - 1].rms <= vs[pl].rms) pl--;
        let pr = i + 1; while (pr < vs.length - 1 && vs[pr + 1].rms <= vs[pr].rms) pr++;
        const depth = 20 * Math.log10(Math.max(vs[pl].rms, vs[pr].rms) / vs[i].rms);
        if (depth >= depthDb && i >= 2 && i <= vs.length - 3) cuts.push(i);
      }
    }
    if (!cuts.length) { split.push(r); continue; }
    // 切分块必须继承父 run 的切缘标记(丢标记=被同音合并愈合回长块——v3.1 实测教训)
    const pieces = [];
    let segStart = 0;
    for (const c of cuts) {
      if (c > segStart) pieces.push(vs.slice(segStart, c));
      segStart = c + 1;                      // 谷帧=气口，丢弃
    }
    if (segStart < vs.length) pieces.push(vs.slice(segStart));
    pieces.forEach((pp, k) => {
      const piece = runFrom(r.midi, pp);
      if (k > 0 || r.cutPrev) piece.cutPrev = true;
      if (k < pieces.length - 1 || r.cutNext) piece.cutNext = true;
      split.push(piece);
    });
  }

  // 3) 不做任何自动折叠/合并：块一旦出现就保持独立。原'vibrato'档的
  //    颤音折叠与质量折叠两步已于 2026-09-19 随档位一并删除，此步恒等。
  const folded = split;

  // 5) 过滤(<MIN_NOTE_MS) + 同音近邻合并
  //    (包络切分产生的边界带 cutPrev/cutNext 标记——那是刻意切出的吐音气口，禁止愈合)
  const notes = folded
    .filter(r => r.lastT - r.t0 >= MIN_NOTE_MS)
    .map(r => ({ midi: r.midi, t0: r.t0, t1: r.lastT, cutPrev: r.cutPrev, cutNext: r.cutNext }));
  const merged = [];
  for (const n of notes) {
    const last = merged[merged.length - 1];
    if (last && last.midi === n.midi && n.t0 - last.t1 < MERGE_GAP_MS && !(n.cutPrev || last.cutNext)) last.t1 = n.t1;
    else merged.push(n);
  }
  return merged;
}

// 帧 → 可信度(0-1)：纯音度为主 + 峰突出度归一为辅
function frameQ(p) {
  return Math.max(0, Math.min(1, p.purity * 0.6 + Math.min(1, p.prom / 18) * 0.4));
}
function med(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
// —— 方案A v4：先分段、后定音 ——
// 段边界三信号见 segmentPoints 注释。段中心用"段内 mf 在线中值"（跟随主流，
// 不被起调帧/短暂离群带偏）；段内定音用 round(midi) 直方图众数。
// 边界确认门槛 BOUNDARY_CNT=2 帧：单帧离群只计一次、方向一转即清零 → 吸收；
// 真转音（快吐变奏/滑音阶跃）是持续同向偏离，2 帧后必切。
function segmentByPitch(pts, cutTimes) {
  const runs = [];
  let cur = null, count = new Map(), ci = 0, prevT = -Infinity, prevCutOff = false;
  const pushRun = () => {
    if (!cur) return;
    // 段内定音：直方图众数；平票取先出现(Map 插入序)
    let best = NaN, bcnt = -1;
    for (const [m, c] of count) if (c > bcnt) { bcnt = c; best = m; }
    cur.midi = best;
    runs.push(closeRun(cur));
  };
  for (const p of pts) {
    while (ci < cutTimes.length && cutTimes[ci] <= prevT) ci++;
    const cutBefore = ci < cutTimes.length && cutTimes[ci] < p.t;
    const mf = 69 + 12 * Math.log2(p.f / 440);
    const m = Math.round(mf);
    // 边界信号②③：包络气口 / 数据级静音 gap
    if (cur && (cutBefore || p.t - cur.lastT > GAP_MS)) {
      if (cutBefore) cur.cutNext = true;
      pushRun(); cur = null; prevCutOff = false;
    }
    // 边界信号①：相对段中心持续同向偏离（段中心=段内 mf 在线中值）
    if (cur) {
      const dev = mf - med(cur.segMfs);
      if (Math.abs(dev) > BOUNDARY_SEMI) {
        const d = Math.sign(dev);
        if (cur.offDir === d && cur.offCnt) cur.offCnt++;
        else { cur.offDir = d; cur.offCnt = 1; }
        if (cur.offCnt >= BOUNDARY_CNT) {
          cur.cutNext = true;           // 音高断开：禁止同音合并愈合（A-B-A 中间块保护）
          pushRun(); cur = null; prevCutOff = true;
        }
      } else { cur.offCnt = 0; }
    }
    if (!cur) {
      cur = { midi: m, t0: p.t, lastT: p.t, pts: [], q: [], segMfs: [], offCnt: 0, offDir: 0 };
      if (cutBefore) cur.cutPrev = true;
      else if (prevCutOff) cur.cutPrev = true;
      prevCutOff = false;
      count = new Map();
    }
    cur.lastT = p.t;
    cur.pts.push(p);
    cur.segMfs.push(mf);
    count.set(m, (count.get(m) || 0) + 1);
    if (typeof p.purity === 'number' && typeof p.prom === 'number') {
      cur.q.push(Math.max(0, Math.min(1, p.purity * 0.6 + Math.min(1, p.prom / 18) * 0.4)));
    }
    prevT = p.t;
  }
  pushRun();
  return runs;
}
// 由帧明细构造 run(计算 q 中位数)
function runFrom(midi, pts) {
  return { midi, t0: pts[0].t, lastT: pts[pts.length - 1].t, pts, q: med(pts.map(frameQ)) };
}
function closeRun(r) { r.q = med(r.q); return r; }

// —— 12 音高配色 ——
// —— 12 音高配色 ——
const cssCache = new Map();
function noteCss(midi) {
  let c = cssCache.get(midi);
  if (!c) {
    const pc = ((midi % 12) + 12) % 12;
    c = `hsl(${pc * 30} 85% 58%)`;
    cssCache.set(midi, c);
  }
  return c;
}

// —— 键盘几何：固定 88 键全展示(A0..C8)，真实钢琴黑键偏位 ——
// 黑键相对"相邻白键分界线"的偏移(占白键宽比例)：真钢琴 C#/D# 靠左/右，
// F# 偏左、G# 居中、A# 偏右——这是真实感的关键细节之一。
const BLACK_OFF = { 1: -0.10, 3: 0.10, 6: -0.13, 8: 0, 10: 0.13 };
function ensureGeom() {
  const lo = 21, hi = 108;
  if (geom.lo === lo && geom.hi === hi && geom.geo) return;
  const whites = [];
  for (let m = lo; m <= hi; m++) if (WHITE_PC.has(((m % 12) + 12) % 12)) whites.push(m);
  const whiteW = W / Math.max(1, whites.length);
  const geo = new Map();
  const wIdx = new Map();
  whites.forEach((m, i) => { wIdx.set(m, i); geo.set(m, { x0: i * whiteW, w: whiteW, cx: i * whiteW + whiteW / 2, black: false }); });
  const bw = whiteW * 0.58;
  for (let m = lo; m <= hi; m++) {
    const pc = ((m % 12) + 12) % 12;
    if (WHITE_PC.has(pc)) continue;
    const bi = wIdx.get(m - 1);
    const bx = (bi === undefined ? whites.length * whiteW : (bi + 1) * whiteW) + (BLACK_OFF[pc] || 0) * whiteW;
    geo.set(m, { x0: bx - bw / 2, w: bw, cx: bx, black: true });
  }
  geom = { lo, hi, geo, whiteW, bw };
}

// 键盘高度按【白键宽】定，不按画布高。
// 原因：进纯净全屏会隐藏 header/recbar 并去掉浏览器边框，画布**高度**猛增
// 而宽度几乎不变，按 H*0.32 定高只会把琴键纵向抻长 30~40% → 键的长宽比走样("被拉长了，比例怪")。
// 改为与白键宽挂钩后，键高/键宽恒定：宽度不变的场景(最大化→F11)键盘尺寸一模一样；
// 宽度变了的场景整套等比缩放，比例不变。
// 88 键固定 52 白键，whiteW = W/52；取 8 之后在 1300 宽画布下 ≈200px 高，与旧观感持平。
const KB_H_PER_WHITE = 8;
function kbHeight() { return Math.max(150, Math.min(300, (W / 52) * KB_H_PER_WHITE)); }

// 工程音符表(缓存按 frames+env 引用失效)。键盘固定 88 键，不按音域缩放
function ensureProjNotes(frames, env) {
  if (cache.frames === frames && cache.env === env) return;
  const pts = [];
  for (const f of frames) {
    // voiced!==false：排除桥接帧(voiced=false 但 freq 沿用旧值)——它们会把相邻
    // run 焊成长块(快吐/变奏糊块源头)；气口交给 GAP_MS 与包络切分处理
    if (f.voiced !== false && Number.isFinite(f.freq) && f.freq > 0) pts.push({ t: f.t, f: f.freq, rms: f.rms, prom: f.prom, purity: f.purity });
  }
  cache = { frames, env, notes: segmentPoints(pts, env) };
}

// 实时收点(与 pitchTrail 同思路：节流采样 + seek 回退弹未来点)
let lastHist = [];   // 停止录音时 hist 会被清空,导调试需要留存最后一份
function collectLive(d, aMs) {
  if (!(aMs >= 0)) {
    if (hist.length) lastHist = hist;
    hist = []; lastDotT = -1e9; return;
  }
  while (hist.length && hist[hist.length - 1].t > aMs) {
    hist.pop();
    lastDotT = hist.length ? hist[hist.length - 1].t : -1e9;
  }
  if (d.voiced && aMs - lastDotT >= DOT_MS) {
    // 当帧原始判定 freqRaw 优先(d.freq 是粘滞的 lastGoodFreq,快变奏短音会被记成上一音)
    const f0 = (Number.isFinite(d.freqRaw) && d.freqRaw > 0) ? d.freqRaw
      : ((Number.isFinite(d.freq) && d.freq > 0) ? d.freq
      : ((Number.isFinite(d.lastGoodFreq) && d.lastGoodFreq > 0) ? d.lastGoodFreq : NaN));
    if (Number.isFinite(f0)) {
      lastDotT = aMs;
      hist.push({ t: aMs, f: f0, rms: d.rms, prom: d.prom, purity: d.purity });   // 质量字段供分段器
    }
  }
  const cut = aMs - LOOKAHEAD_MS - 6000;
  while (hist.length && hist[0].t < cut) hist.shift();
}

// —— 实时分段稳定化(修"块刚出就消失") ——
// 每帧对全量 hist 重新分段的话，质量折叠/同音合并会随新点到来【追溯改写】
// 已显示的块(典型：B 块出现→下一秒 A 回来→B 被两侧同音折叠吞掉)。
// 现在：结束于 SAFE_MS 之前的音符提交冻结(liveFrozen)，永不再改写；
// 每帧只对冻结线之后的开放点重新分段。SAFE_MS > OSC_SPAN_MS(900)+MERGE_GAP(110)，
// 任何分段规则的回溯半径都不超过它，冻结即终局。
const SAFE_MS = 1200;
let liveFrozen = [], liveFrozenEndT = -1, lastFreeze = 0;
// 实时包络切点(单调只增)：envCuts 定案后不再增删；envScanIdx=已定案扫描游标
const ENV_RESOLVE_PTS = 60;   // 尾窗(300ms/5ms步)内谷深未定案,暂不产出切点
let envCuts = [], envScanIdx = 0;

function refreshEnvCuts(env) {
  if (!env || env.length < 8) return;
  const hi = env.length - ENV_RESOLVE_PTS;              // 定案边界(爬坡峰被下降确认)
  if (hi <= envScanIdx) return;
  for (let i = Math.max(envScanIdx, 2); i < hi - 1; i++) {
    if (env[i].rms < env[i - 1].rms && env[i].rms <= env[i + 1].rms) {
      let pl = i - 1; while (pl > 1 && env[pl - 1].rms <= env[pl].rms) pl--;
      let pr = i + 1; while (pr < hi && env[pr + 1].rms <= env[pr].rms) pr++;
      const depth = 20 * Math.log10(Math.max(env[pl].rms, env[pr].rms) / env[i].rms);
      if (depth >= ENV_SPLIT_DB) envCuts.push(env[i].t);
    }
  }
  envScanIdx = hi;
  envCuts.sort((a, b) => a - b);
}

function stableLiveNotes(aMs, env, now) {
  refreshEnvCuts(env);                                // 单调刷新包络切点(只增不减)
  if (now - lastFreeze > 150) {                       // 冻结节流 150ms
    lastFreeze = now;
    const frontierPts = [];
    for (const p of hist) if (p.t > liveFrozenEndT && p.t <= aMs - SAFE_MS) frontierPts.push(p);
    if (frontierPts.length >= 3) {
      const seg = segmentPoints(frontierPts, env, envCuts);
      // 提交条件(双保险)：
      //   t1 ≤ horizon-110 —— 同音合并(110ms)不再可能触及；
      //   t0 ≤ frontier-900 —— 该音所在的潜在合并组(跨度≤OSC_SPAN_MS)的所有成员点
      //   都已进入前缀，组在冻结时整体成形。只看 t1 会把"组先头成员"单独冻住、
      //   其余成员留在开放区被合并 → 显示为"底部一块、升上去拆散"(实测 bug)。
      const horizon = aMs - SAFE_MS - MERGE_GAP_MS;
      const groupSafe = aMs - SAFE_MS - OSC_SPAN_MS;
      const commit = seg.filter(n => n.t1 <= horizon && n.t0 <= groupSafe);
      if (commit.length) {
        liveFrozen = liveFrozen.concat(commit);
        liveFrozenEndT = commit[commit.length - 1].t1;
        while (liveFrozen.length > 400 && liveFrozen[0].t1 < aMs - 15000) liveFrozen.shift();  // 防无限增长
      }
    }
  }
  const open = [];
  for (const p of hist) if (p.t > liveFrozenEndT) open.push(p);
  const notes = liveFrozen.concat(segmentPoints(open, env, envCuts));
  liveStat = { pts: hist.length, blocks: notes.length, frozen: liveFrozen.length };
  return notes;
}

let liveStat = null;   // 实时分段读数(录音诊断徽标用)

// 正在下拍的音符 → Map(midi → 颜色)，供键盘染色/光带
function activeNotes(notes, aMs) {
  const m = new Map();
  for (const n of notes) {
    if (n.t0 <= aMs && aMs < n.t1 && !m.has(n.midi)) m.set(n.midi, noteCss(n.midi));
  }
  return m;
}

const EMPTY_NOTES = [];         // 实时录音态：无块(共享同一空数组，避免每帧分配)

// 实时录音期没有音符表(块要等录完的离线分析)，直接把当前吹到的音点亮成琴键。
// 返回结构与 activeNotes() 一致：Map(midi → 颜色)
function liveActiveKeys(d) {
  const m = new Map();
  if (d && d.voiced && Number.isFinite(d.midi)) {
    const midi = Math.round(d.midi);
    m.set(midi, noteCss(midi));
  }
  return m;
}

// 击键粒子：音符起点落在 (prevAms, aMs] 且非 seek 跳变才喷
function spawnOnsets(notes, aMs) {
  if (prevAms < 0 || aMs <= prevAms) return;
  if (aMs - prevAms > 150) return;              // seek/拖动 → 不喷
  if (seenKeys.size > 5000) seenKeys.clear();
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.t0 > prevAms && n.t0 <= aMs) {
      const key = Math.round(n.t0) + '_' + n.midi;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const g = geom.geo.get(n.midi);
      if (g) spawnBurst(g.cx, noteCss(n.midi));
      if (soundEnabled()) {
        // ④弹奏兜底：<60ms 且两侧都不同音的孤立块不出声(视觉保留)——
        // 口哨抖动的残余错块即使漏过折叠，也不该在弹奏里冒出一个错音
        const prevN = notes[i - 1], nextN = notes[i + 1];
        const isolated = (!prevN || prevN.midi !== n.midi) && (!nextN || nextN.midi !== n.midi);
        if (!(n.t1 - n.t0 < SKIP_SOUND_MS && isolated)) {
          ensureAudio();
          playPianoNote(n.midi, (n.t0 - aMs) / 1000, n.t1 - n.t0);
        }
      }
    }
  }
}

function spawnBurst(x, c) {
  if (fxQuality !== 'high') return;            // 迸溅属粒子特效，只在"高"档
  const N = 10 + ((Math.random() * 5) | 0);
  const hitY = H - kbHeight();
  for (let i = 0; i < N && parts.length < MAXP; i++) {
    parts.push({
      x: x + (Math.random() - 0.5) * 10,
      y: hitY - 2,
      vx: (Math.random() - 0.5) * 130,
      vy: -(60 + Math.random() * 260),
      life: 1, dec: 1.4 + Math.random() * 1.2,
      c, s: 0.8 + Math.random() * 1.8,
    });
  }
}

function drawParts(dt) {
  const hitY = H - kbHeight();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= p.dec * dt;
    p.vy += 420 * dt;                            // 重力
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.life <= 0 || p.y > hitY + 8) { parts.splice(i, 1); continue; }
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life)) * 0.9;
    ctx.fillStyle = p.c;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.s * (0.5 + p.life), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 下落块(工程回放：未来已知)。块底在 t0 时刻命中键盘线，发声期钳在键线滑入
function drawBlockProj(n, aMs, speed, hitY) {
  const yB = Math.min(hitY, hitY + (aMs - n.t0) * speed);
  const yT = hitY + (aMs - n.t1) * speed;
  if (yT >= hitY - 0.5 || yB < -40) return;
  const g = geom.geo.get(n.midi); if (!g) return;
  const sounding = aMs >= n.t0 && aMs < n.t1;
  paintBlock(g, yT, yB - yT, n.midi, sounding, 1);
}

// 生长条(实时录音：未来未知)。发声时从键线向上长，结束后实心升走
// (2026-09-07：去掉 1.5s 淡出——快音块刚长出就渐隐，观感="闪一下就消失"；
//  与导入回放的实心下落块保持一致观感，出屏才消失)
function drawBlockLive(n, aMs, speed, hitY) {
  if (aMs < n.t0) return;
  const yB = aMs < n.t1 ? hitY : hitY - (aMs - n.t1) * speed;
  const yT = hitY - (aMs - n.t0) * speed;
  if (yT < -10) return;
  const g = geom.geo.get(n.midi); if (!g) return;
  const sounding = aMs >= n.t0 && aMs < n.t1;
  paintBlock(g, yT, yB - yT, n.midi, sounding, 1);
}

function paintBlock(g, yT, h, midi, sounding, alpha) {
  // 最小可见高度：短块往上加高(底部=yB 命中时机不动)，否则 46ms 块只有 4px 高=隐形
  if (h < MIN_BLOCK_H) { yT -= (MIN_BLOCK_H - h); h = MIN_BLOCK_H; }
  const c = noteCss(midi);
  const bw = g.black ? g.w * 0.85 : g.w * 0.86;
  const x = g.cx - bw / 2;
  ctx.save();
  ctx.globalAlpha = (sounding ? 1 : 0.8) * alpha;
  if (sounding) { ctx.shadowColor = c; ctx.shadowBlur = 18; }
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.roundRect(x, yT, bw, h, Math.min(bw / 2, h / 2, 14));   // 胶囊形(截图同款)
  ctx.fill();
  if (sounding) {                                // 命中段白芯提亮
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.beginPath();
    ctx.roundRect(x, Math.max(yT, yT + h - 5), bw, Math.min(5, h), 3);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ============================================================
// —— 离线 PBR 键帽（2026-09-12 v8）——
// 关于"参考软件的钢琴是不是贴图"的取证结论：它是 Unity HDRP 的**真 3D 网格 +
// 实时灯光 + 后处理**算出来的，不是贴图。canvas 2D 没有光照模型，所以过去只能
// "手绘渐变去追一个渲染器"，怎么调都不够真。
//
// v8 的做法：把"算"搬到离线。把一根键当成有倒角(bevel)的实体，用
//   Lambert 漫反射 + Blinn-Phong 高光 + 侧棱菲涅尔 + 半球天光 + 环境光遮蔽(AO)
// 逐像素着色，**只在画布尺寸变化时算一次**，缓存成小图；每帧只 drawImage。
// 键几何 88 个完全相同 → 4 张图（白/黑 × 抬起/按下）覆盖全键盘。
// 副产物：帧内从"每键建 4 个渐变对象"（约 200 个/帧）降到 88 次贴图，更快。
//
// 键态"按下"= 近端下沉：顶面/前立面的分界线下移 dipPx、前立面变矮、分界处补一道
// 接触影、顶面略压暗（对标参考软件的 blackKeyUp / blackKeyDown 两态）。
// ============================================================
const KBP = {
  bevel: 0.055,                    // 左右倒角占键宽比例（**必须窄**：宽了就成"金属管"）
  domeWhite: 0,                    // 白键顶面横向拱度（白键要平，0）
  blackDome: 0.52,                 // 黑键顶面横向拱度 → 高光在键面上扫出渐变（否则死黑）
  tiltZ: 0.30,                     // 顶面法线的 z 分量（表观倾角：>0 = 面朝观者上方）
  rough: 15,                       // Blinn-Phong 高光指数（越大越锐）
  spec: 0.85,                      // 高光强度
  fres: 0.20,                      // 侧棱菲涅尔增亮（真实键最抢眼的就是两条侧棱）
  frontSpec: 0.16,                 // 前立面高光折减（前脸是哑光倒角，不参与镜面）
  light: [-0.58, -0.66, 0.50],     // 主光方向（屏幕系：x 右 / y 下 / z 朝观者）；偏侧向才能
                                   // 在黑键上扫出高光带，太正上方会变成一片死黑
  amb: 0.26,                       // 均匀环境光
  sky: 0.20,                       // 半球天光（朝上的面分得多）
  topBoost: 0.10,                  // 正上方面积光：朝上的面额外补光。真实琴键白得发亮
                                   // 靠的就是头顶一团面光；没有它白键只能到 205 左右，发灰
  aoSeam: 0.16,                    // 键缝遮蔽（越靠侧棱越暗）
  aoFar: 0.42,                     // 远端（红毡条一侧）遮蔽强度
  aoFarLen: 0.26,                  // 远端遮蔽影响的高度 / 顶面高
  frontEdge: 0.42,                 // 顶面与前立面交线的高光强度
  frontBend: 0.30,                 // 前立面自上而下额外压暗比例（真实前脸下沿更暗）
  dipFrac: 0.030,                  // 按下时下沉量 / 键高
  dipDark: 0.10,                   // 按下时顶面额外压暗比例
  blackShadow: 0.34,               // 黑键投在白键上的接触影强度
  blackSide: 0.18,                 // 接触影左右溢出（以黑键宽为单位）
  blackBelow: 0.22,                // 接触影下方渐隐长度（以黑键长为单位）
};

let kbSpr = new Map();             // 键帽精灵缓存（键含尺寸+键体 → 画布变化时清空）

function kbDirs() {
  const L = KBP.light, ln = Math.hypot(L[0], L[1], L[2]) || 1;
  const l = [L[0] / ln, L[1] / ln, L[2] / ln];
  const h = [l[0], l[1], l[2] + 1], hn = Math.hypot(h[0], h[1], h[2]) || 1;
  return { l, h: [h[0] / hn, h[1] / hn, h[2] / hn] };
}

// 顶面法线：中间平、两侧倒角处朝外倾倒。u=0..1（键内横向位置）
// 返回 { n:法线, s:离最近侧棱的归一距离(1=平面), side:哪一侧 }
function kbTopNormal(u, bevel, dome) {
  const sl = u / bevel, sr = (1 - u) / bevel;
  const side = sl < sr ? -1 : 1;
  const s = Math.min(1, Math.max(0, Math.min(sl, sr)));
  const psi = (1 - s) * 1.5707963268;          // 0=平面, π/2=侧棱
  // dome：顶面横向微拱。黑键靠它让高光在键面上"扫"出一条渐变，否则就是一整块死黑。
  const n = [side * Math.sin(psi) + (dome || 0) * (2 * u - 1), -Math.cos(psi), KBP.tiltZ];
  const nn = Math.hypot(n[0], n[1], n[2]) || 1;
  return { n: [n[0] / nn, n[1] / nn, n[2] / nn], s, side };
}

// 单像素着色 → [r,g,b]（0..255，未钳位）
// mk = 材质覆盖 { rough, spec }：黑键用更低的高光指数 + 更高强度才出"亮黑漆"的镜面感
function kbShade(dir, n, albedo, ao, extraSpec, mk) {
  const nl = Math.max(0, n[0] * dir.l[0] + n[1] * dir.l[1] + n[2] * dir.l[2]);
  const nh = Math.max(0, n[0] * dir.h[0] + n[1] * dir.h[1] + n[2] * dir.h[2]);
  const rg = (mk && mk.rough) || KBP.rough;
  const sp = (mk && mk.spec) || 1;
  const spec = Math.pow(nh, rg) * KBP.spec * sp + (extraSpec || 0);
  const diff = KBP.amb + KBP.sky * (0.5 - n[1] * 0.5) + nl * (1 - KBP.amb - KBP.sky)
    + KBP.topBoost * Math.max(0, -n[1]);       // 正上方面积光：只有朝上的面分到
  const f = diff * ao, s = spec * 255;
  return [albedo[0] * f + s, albedo[1] * f + s, albedo[2] * f + s];
}

// 前立面法线：真实键的前缘是倒角(chamfer)的，面朝观者且略朝上 —— 所以它比顶面暗、
// 但在黑键上又比黑顶面亮（这正是 v7 里"黑键前脸比顶面亮"的成因）。
// ⚠️ 别让它太贴观者（如 (0,-0.15,0.99)）：那会正好对准半程向量，前脸被高光打爆成白条。
const KBP_FRONT_N = (() => {
  const n = [0, -0.30, 0.954], nn = Math.hypot(0, -0.30, 0.954) || 1;
  return [n[0] / nn, n[1] / nn, n[2] / nn];
})();

// —— 生成一张键帽精灵 ——
// size={w,h} 精灵像素尺寸；body={x0,y0,w,h} 键体在精灵内的整数矩形
// kind='white'|'black'；dip = 按下下沉像素（0 = 抬起态）
function h1(n) { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); }   // 确定性噪声[0,1)
function kbMakeSprite(size, body, kind, dip) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, size.w); cv.height = Math.max(1, size.h);
  const g2 = cv.getContext('2d');
  if (!g2 || !g2.createImageData) return cv;
  const img = g2.createImageData(cv.width, cv.height);
  const px = img.data;
  const dir = kbDirs();
  const white = kind === 'white';
  const A_TOP = white ? [255, 255, 255] : [36, 40, 48];
  const A_FRONT = white ? [228, 232, 240] : [72, 78, 92];
  const mk = white ? null : { rough: 8, spec: 1.9 };
  const mkF = { rough: KBP.rough, spec: KBP.frontSpec };   // 前脸哑光：不吃镜面高光
  const bx = body.x0, bw = Math.max(1, body.w), by = body.y0, bh = Math.max(1, body.h);
  const fh0 = Math.max(3, Math.round(bh * (white ? KB.frontFrac : KB.blackFront)));
  const dipPx = Math.max(0, Math.min(Math.round(dip), fh0 - 2));
  const fh = fh0 - dipPx;                       // 按下：近端沉下去 → 可见前立面变矮
  const splitY = by + bh - fh;                  // 顶面/前立面分界线（按下时下移）
  const farLen = Math.max(1, KBP.aoFarLen * Math.max(1, splitY - by));
  const seamPx = white ? Math.max(1, Math.round(KB.sep)) : 0;
  const padX = Math.max(1, bx);
  const padB = Math.max(1, cv.height - (by + bh));

  for (let y = 0; y < cv.height; y++) {
    const inRow = y >= by && y < by + bh;
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      let a = 0, r = 0, g = 0, b = 0;
      if (inRow && x >= bx && x < bx + bw) {
        const u = (x + 0.5 - bx) / bw;
        if (y < splitY) {
          // ——— 顶面 ———
          const tn = kbTopNormal(u, KBP.bevel, white ? KBP.domeWhite : KBP.blackDome);
          let ao = 1 - KBP.aoFar * (1 - Math.max(0, Math.min(1, (y - by) / farLen)));
          ao *= 1 - KBP.aoSeam * Math.pow(1 - tn.s, 3);
          let extra = KBP.fres * Math.pow(1 - tn.s, 2);
          if (dipPx > 0) {
            const bl = bh * 0.06, back = splitY - y;
            if (back < bl) ao *= 1 - 0.24 * (1 - back / bl);
            ao *= 1 - KBP.dipDark;
          }
          if (splitY - y <= 1.5) extra += KBP.frontEdge;   // 顶面/前立面交线高光
          const c = kbShade(dir, tn.n, A_TOP, ao, extra, mk);
          r = c[0]; g = c[1]; b = c[2];
          if (white) {
            // v9 象牙材质细节（确定性 hash → 精灵只算一次，帧内零成本）：
            // 低频竖纹（象牙纹路沿键长方向）+ 逐像素微噪声 + 近观者端磨损泛黄。
            // 幅度刻意小（±3~5%）：远看是"材质"，近看才见颗粒——过了就成塑料噪点。
            const grain = (h1(x * 0.37 + 11.3) - 0.5) * 0.055 + (h1(x * 12.9898 + y * 78.233) - 0.5) * 0.028;
            const wear = Math.pow(Math.max(0, (y - (splitY - bh * 0.30)) / (bh * 0.30)), 2) * 0.10;
            r = r * (1 + grain) + wear * 30;
            g = g * (1 + grain) + wear * 20;
            b = b * (1 + grain) - wear * 10;
          }
        } else {
          // ——— 前立面（倒角面）———
          const t = (y - splitY) / Math.max(1, fh);
          const sd = 0.62 + 0.38 * Math.min(1, Math.min(u, 1 - u) / (KBP.bevel * 0.8));
          const c = kbShade(dir, KBP_FRONT_N, A_FRONT, (1 - KBP.frontBend * t) * sd, 0, mkF);
          r = c[0]; g = c[1]; b = c[2];
        }
        a = 255;
        if (seamPx && x >= bx + bw - seamPx) { r = 24; g = 29; b = 37; }   // 键缝
      } else if (!white) {
        // ——— 黑键外围：接触影（半透明黑，落在白键上）———
        const dx = Math.max(0, bx - x, x - (bx + bw - 1));
        const dy = Math.max(0, y - (by + bh - 1));
        let al = dy > 0 ? Math.max(0, 1 - dy / padB) * 0.26 : 0;
        if (dx > 0 && inRow) al = Math.max(al, Math.max(0, 1 - dx / padX) * KBP.blackShadow);
        r = 0; g = 0; b = 0; a = al * 255;
      }
      if (a <= 0) continue;
      px[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      px[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      px[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      px[i + 3] = a > 255 ? 255 : a;
    }
  }
  g2.putImageData(img, 0, 0);
  return cv;
}

// 取精灵（按 尺寸+键体+类型+键态 缓存）。画布尺寸变化时清表 → 不残留旧尺寸的图。
function kbSprite(size, body, kind, dip) {
  const k = kind + '|' + size.w + 'x' + size.h + '|' + body.x0 + ',' + body.y0 + ',' + body.w + ',' + body.h + '|' + dip;
  let s = kbSpr.get(k);
  if (!s) { s = kbMakeSprite(size, body, kind, dip); kbSpr.set(k, s); }
  return s;
}

// —— 立体键盘 v8（2026-09-12 · 离线 PBR 键帽）——
// 正视图，不做透视（2026-09-06 定案：键正着放）。
// "真实感"的来源从【手绘渐变】换成【逐像素算光照】——见上方 KBP / kbMakeSprite 区块：
// Lambert 漫反射 + Blinn-Phong 高光 + 侧棱菲涅尔 + 半球天光 + 环境光遮蔽。
// 本函数只负责编排：毡条 → 贴白键精灵 → 白键命中染色 → 玻璃反光 → 贴黑键精灵(含接触影)
//                 → 黑键命中染色。
// 键态"按下"用【抬起/按下两张精灵交叉淡入】表现（不是每帧重算，开销不随按住时长增长）：
// 命中升得快 (RISE)、松开回得慢 (FALL)，像真键回弹。
// 精灵一律按【整数像素跨度】贴（相邻键 px1 接 px0）→ 既不露缝也不叠边，且不依赖
// imageSmoothing 设置（共享画布上别的模板可能改过它）。

const pressT = new Map();          // 键 → 按下进度 0..1

// 逐键微差（v9）：真实象牙键没有两根一样白——按 midi 确定性给出一点暖/冷偏色。
// 画在键帽精灵之上（fillRect 一层极淡的色罩），成本 = 每白键一次 fillRect。
const keyVarCache = new Map();
function keyVar(m) {
  let v = keyVarCache.get(m);
  if (!v) {
    const f = h1(m * 127.1 + 3.7);
    v = { a: 0.018 + f * 0.030, warm: f > 0.5 };
    keyVarCache.set(m, v);
  }
  return v;
}

function stepPress(active, dt) {
  const d = Math.max(0, Math.min(0.1, dt || 0));
  const RISE = 26, FALL = 13;      // 1/s
  for (const m of active.keys()) {
    const cur = pressT.get(m) || 0;
    pressT.set(m, cur + (1 - cur) * (1 - Math.exp(-RISE * d)));
  }
  for (const [m, v] of pressT) {
    if (active.has(m)) continue;
    const nv = v * Math.exp(-FALL * d);
    if (nv < 0.02) pressT.delete(m); else pressT.set(m, nv);
  }
}

// 命中染色：发声中的键 → 键面透色 + 外发光。black=过滤白/黑键
function tintKeys(active, black, x0, w, y0, h, radius) {
  for (const [m, c] of active) {
    const g = geom.geo.get(m);
    if (!g || g.black !== black) continue;
    ctx.save();
    ctx.shadowColor = c; ctx.shadowBlur = 16;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.roundRect(x0(g), y0, w(g), h, radius);
    ctx.fill();
    ctx.restore();
  }
}

function drawKeyboard(active, hitY, dt, refl) {
  const ky0 = hitY + KB.feltH + 1;
  const kH = H - ky0;                       // 键的可见高度
  const kHH = Math.max(1, Math.round(kH));
  const dipFull = Math.max(2, Math.round(kH * KBP.dipFrac));

  // —— 红毡条（真钢琴压键条）——
  ctx.fillStyle = '#701a24';
  ctx.fillRect(0, hitY, W, KB.feltH);
  ctx.fillStyle = 'rgba(255,130,130,.12)';           // 毡条上沿微光
  ctx.fillRect(0, hitY, W, 1);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(0, hitY + KB.feltH, W, 1);

  stepPress(active, dt);

  // —— 白键：贴 PBR 精灵（按键内整数像素跨度贴，相邻键严丝合缝）——
  for (const [m, g] of geom.geo) {
    if (g.black) continue;
    const px0 = Math.round(g.x0);
    const pw = Math.max(1, Math.round(g.x0 + g.w) - px0);
    const size = { w: pw, h: kHH }, body = { x0: 0, y0: 0, w: pw, h: kHH };
    ctx.drawImage(kbSprite(size, body, 'white', 0), px0, ky0);
    const kv = keyVar(m);                        // 逐键微差（暖黄/冷灰极淡色罩）
    ctx.fillStyle = kv.warm
      ? 'rgba(214,196,158,' + kv.a.toFixed(3) + ')'
      : 'rgba(160,172,188,' + kv.a.toFixed(3) + ')';
    ctx.fillRect(px0, ky0, pw, kHH);
    const t = pressT.get(m);
    if (t) {                                   // 按下：淡入"下沉版"
      ctx.globalAlpha = t;
      ctx.drawImage(kbSprite(size, body, 'white', dipFull), px0, ky0);
      ctx.globalAlpha = 1;
    }
  }

  // —— 白键命中染色（画在黑键之前 → 黑键照常遮挡白键的光）——
  tintKeys(active, false, (g) => Math.round(g.x0),
    (g) => Math.max(1, Math.round(g.x0 + g.w) - Math.round(g.x0) - 1),
    ky0, kHH, [2, 2, 5, 5]);

  // —— 玻璃反光：横贯键面的柔和光带（抛光感）——
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const sheen = ctx.createLinearGradient(0, ky0 + kH * 0.16, 0, ky0 + kH * 0.40);
  sheen.addColorStop(0, 'rgba(210,230,255,0)');
  sheen.addColorStop(0.5, 'rgba(210,230,255,' + KB.sheen + ')');
  sheen.addColorStop(1, 'rgba(210,230,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, ky0 + kH * 0.16, W, kH * 0.24);
  ctx.restore();

  // —— 下落块漆面反射（画在黑键之前：黑键照常遮挡反射光）——
  drawReflections(refl, hitY, ky0, kH);

  // —— 黑键：贴带接触影的 PBR 精灵 ——
  // 接触影是精灵里的半透明黑像素（左右各溢出 0.18 键宽 + 下方渐隐），
  // 所以它天然落在白键上，不用再单独画一遍渐变。
  const bwPx = Math.max(2, Math.round(geom.bw));
  const bhPx = Math.max(4, Math.round(kH * KB.blackLen));
  const padX = Math.max(1, Math.round(geom.bw * KBP.blackSide));
  const padB = Math.max(1, Math.round(bhPx * KBP.blackBelow));
  const bSize = { w: bwPx + padX * 2, h: bhPx + padB };
  const bBody = { x0: padX, y0: 0, w: bwPx, h: bhPx };
  for (const [m, g] of geom.geo) {
    if (!g.black) continue;
    const bx = Math.round(g.x0) - padX;
    ctx.drawImage(kbSprite(bSize, bBody, 'black', 0), bx, ky0);
    const t = pressT.get(m);
    if (t) {
      ctx.globalAlpha = t;
      ctx.drawImage(kbSprite(bSize, bBody, 'black', dipFull), bx, ky0);
      ctx.globalAlpha = 1;
    }
  }

  // —— 黑键命中染色 ——
  tintKeys(active, true, (g) => Math.round(g.x0), () => bwPx,
    ky0, bhPx, [0, 0, 3, 3]);
}

// —— 下落块漆面反射（v9，SeeMusic/Rousseau 系标志性效果）——
// refl = { notes, aMs, speed, isProj }（frame 循环传入；无音频帧时为 null 直接跳过）。
// 块底离键线越近，键面上那道同色反光越长越亮（prox² 曲线：远处几乎看不见，
// 贴线瞬间最亮）。lighter 叠加，画在黑键之前 → 黑键自然遮挡。
function drawReflections(refl, hitY, ky0, kH) {
  if (fxQuality === 'low' || !refl || !REFL.on) return;
  const { notes, aMs, speed, isProj } = refl;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    let yB;
    if (isProj) {
      // 工程块：aMs<t0 时块还悬在上方(bottom=hitY+(aMs-t0)*speed)，t0..t1 贴线，t1 后升走
      if (aMs < n.t0) yB = hitY + (aMs - n.t0) * speed;
      else if (aMs < n.t1) yB = hitY;
      else continue;
    } else {
      // 实时生长条：发声中贴线，结束后实心升走
      if (aMs < n.t0) continue;
      yB = aMs < n.t1 ? hitY : hitY - (aMs - n.t1) * speed;
    }
    const prox = 1 - (hitY - yB) / REFL.dist;
    if (prox <= 0) continue;
    const g = geom.geo.get(n.midi); if (!g) continue;
    const len = Math.min(kH * REFL.maxLen, 6 + kH * REFL.maxLen * prox * prox);
    const a = REFL.a * prox * prox;
    if (a < 0.01) continue;
    const pc = ((n.midi % 12) + 12) % 12;
    const [r, g2, b] = hsl2rgb(pc * 30, 85, 58);
    const gr = ctx.createLinearGradient(0, hitY, 0, hitY + len);
    gr.addColorStop(0, 'rgba(' + r + ',' + g2 + ',' + b + ',' + a.toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(' + r + ',' + g2 + ',' + b + ',0)');
    ctx.fillStyle = gr;
    const bw = g.black ? g.w * 0.85 : g.w * 0.86;
    ctx.fillRect(g.cx - bw / 2, hitY, bw, len);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// —— 动态点光层（v9）：键被特效照亮 ——
// 每盏点光 = 活跃键/命中点上一枚径向渐变（半径 ~3.2 白键宽），lighter 叠回键面：
// 本键变亮 + 邻键按距离吃光——3D 渲染器 pointLight 的 2D 等价物。
// 低档不开（低档 = 只有琴键自染色）；中/高档开。
function drawKeyLights(active, hitY) {
  if (fxQuality === 'low' || !KEY_LIGHT.on) return;
  const ky0 = hitY + KB.feltH + 1;
  const kH = H - ky0;
  const khh = Math.max(1, Math.round(kH));
  const wW = geom.whiteW || W / 52;
  const R = wW * KEY_LIGHT.r;
  const cy = ky0 + khh * 0.42;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, ky0, W, khh); ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  const light = (x, y, midi, a) => {
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const [r, g, b] = hsl2rgb(pc * 30, 85, 58);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
    gr.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    ctx.fillStyle = gr;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
  };
  for (const [m] of active) {
    const g = geom.geo.get(m); if (!g) continue;
    light(g.cx, cy, m, KEY_LIGHT.a);
  }
  if (FX_HIT.on) {
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const k = h.age / h.max;
      const off = h.fadeOut < 0 ? 1 : Math.max(0, h.fadeOut / FX_HIT.offFade);
      const a = Math.pow(1 - k, 1.6) * KEY_LIGHT.hitA * off;
      if (a > 0.01) light(h.x, cy, h.midi, a);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 键线能量条（v11.1：更粗更亮、激光感、红色）：
// ①光晕：上下 26px 红色光带（多层辉光外层）②芯线：5px 红亮带逐段流动
// （沿 x 两个不同频率的慢漂正弦相乘）+ 2px 白热芯（过曝交给 bloom）
// ③活跃键热斑。低档(FX_LINE.on=false)：静态芯线+光晕，不流动。
function drawBand(active, hitY, nowS) {
  const F = FX_LINE;
  // ② 光晕：多层辉光外层（淡而大）——红色
  const halo = ctx.createLinearGradient(0, hitY - 26, 0, hitY + 8);
  halo.addColorStop(0, 'rgba(255,60,35,0)');
  halo.addColorStop(0.62, 'rgba(255,70,40,' + (F.on ? 0.22 : 0.13) + ')');
  halo.addColorStop(1, 'rgba(255,150,110,.55)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, hitY - 26, W, 34);
  // ① 芯线：5px 红亮带（分段流动）+ 2px 白热芯（内层小而亮）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (F.on) {
    const seg = 48;
    for (let x = 0; x < W; x += seg) {
      const cx = x + seg / 2;
      const w1 = 0.5 + 0.5 * Math.sin(cx * 0.008 + nowS * 0.9);
      const w2 = 0.5 + 0.5 * Math.sin(cx * 0.021 - nowS * 0.6);
      const flow = 0.70 + 0.30 * w1 * w2;
      ctx.fillStyle = 'rgba(255,92,60,' + (0.60 * flow).toFixed(3) + ')';
      ctx.fillRect(x, hitY - 2.5, seg + 1, 5);
    }
  } else {
    ctx.fillStyle = 'rgba(255,92,60,.5)';
    ctx.fillRect(0, hitY - 2.5, W, 5);
  }
  ctx.fillStyle = 'rgba(255,238,228,.9)';        // 2px 白热芯（激光的中心）
  ctx.fillRect(0, hitY - 1, W, 2);
  ctx.restore();
  // ③ 活跃键热斑（v11.1 统一红色系：更亮更长，标出"正在响"的段落）
  for (const [m] of active) {
    const g = geom.geo.get(m); if (!g) continue;
    ctx.save();
    ctx.shadowColor = '#ff4633'; ctx.shadowBlur = 18;
    ctx.fillStyle = '#ff6a4a';
    ctx.fillRect(g.cx - g.w * 0.7, hitY - 3.5, g.w * 1.4, 7);
    ctx.restore();
  }
}

// ============================================================
// —— 特效层实现（珠链 / 命中光球 / 泛光）——
// ============================================================

// HSL → RGB（与 noteCss 的 hsl(pc*30 85% 58%) 同一套色，供精灵着色用）
function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// 预渲染软球精灵：中心白芯 + 外圈音符色。逐粒 createRadialGradient 太贵，
// 故按 (音高类, 寿命台阶) 缓存 —— 全程最多 12×steps 张，之后只 drawImage。
function trailSprite(pc, step) {
  const key = pc * FX_TRAIL.steps + step;
  const hit = SPRITE_CACHE.get(key);
  if (hit) return hit;
  const t = step / Math.max(1, FX_TRAIL.steps - 1);      // 0=新(饱和色) → 1=老(近白)
  const [r0, g0, b0] = hsl2rgb(pc * 30, 85, 58);
  const r = Math.round(r0 + (255 - r0) * t * 0.9);
  const g = Math.round(g0 + (255 - g0) * t * 0.9);
  const b = Math.round(b0 + (255 - b0) * t * 0.9);
  const cv = document.createElement('canvas');
  cv.width = cv.height = SPRITE_R * 2;
  const g2 = cv.getContext('2d');
  const gr = g2.createRadialGradient(SPRITE_R, SPRITE_R, 0, SPRITE_R, SPRITE_R, SPRITE_R);
  gr.addColorStop(0, 'rgba(255,255,255,.92)');
  gr.addColorStop(0.22, `rgba(${r},${g},${b},.85)`);
  gr.addColorStop(0.55, `rgba(${r},${g},${b},.26)`);
  gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  g2.fillStyle = gr;
  g2.fillRect(0, 0, SPRITE_R * 2, SPRITE_R * 2);
  SPRITE_CACHE.set(key, cv);
  return cv;
}

const rnd = (a, b) => a + Math.random() * (b - a);

// 喷一颗珠。power 放大初速(命中爆发用)。midi 用于音停后快速淡出（发光 = 有声音）
function spawnOrb(x, y, midi, power) {
  if (trail.length >= FX_TRAIL.max) return;
  const F = FX_TRAIL;
  trail.push({
    x: x + rnd(-4, 4), y,
    vx1: rnd(F.v1x[0], F.v1x[1]),
    vy1: rnd(F.v1y[0], F.v1y[1]) * (power || 1),
    vy2: rnd(F.v2y[0], F.v2y[1]),
    age: 0, max: rnd(F.life[0], F.life[1]),
    midi: Math.round(midi),
    fadeOut: -1,                                   // ≥0 表示正在音停淡出
    pc: ((Math.round(midi) % 12) + 12) % 12,
    seed: Math.random() * 6.283,
    r: F.r0 * (0.6 + Math.random() * 0.7),
  });
}

// ---- 烟雾层（v1.2；v1.3 按音高类染色——参考图里的烟/雾是带音符色的）----
// 贴图：程序化"噪声云团"——大径向渐隐底 + 随机加斑(云的鼓包)/挖洞(云的破洞)，
// 4 张变体 × 12 音高类惰性缓存（暖白芯 → 音符色边，避免死灰）。
const SMOKE_TEX = new Map();         // pc*4+variant → canvas
const SMOKE_VARIANTS = 4;
function smokeSprite(pc, i) {
  const key = pc * SMOKE_VARIANTS + (i % SMOKE_VARIANTS);
  let cv = SMOKE_TEX.get(key);
  if (cv) return cv;
  const [tr, tg, tb] = hsl2rgb(pc * 30, 62, 55);   // 低饱和音符色：染色不艳俗
  cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g2 = cv.getContext && cv.getContext('2d');
  if (!g2) return null;                            // 桩环境 → 烟层静默降级
  const c = 64;
  const base = g2.createRadialGradient(c, c, 0, c, c, c);
  base.addColorStop(0, 'rgba(255,244,232,.8)');    // 暖白芯（火光映亮的烟）
  base.addColorStop(0.5, 'rgba(' + tr + ',' + tg + ',' + tb + ',.34)');
  base.addColorStop(1, 'rgba(' + tr + ',' + tg + ',' + tb + ',0)');
  g2.fillStyle = base;
  g2.beginPath(); g2.arc(c, c, c, 0, Math.PI * 2); g2.fill();
  for (let n = 0; n < 9; n++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * c * 0.72;
    const rr = 128 * (0.10 + Math.random() * 0.16);
    const px = c + Math.cos(a) * d, py = c + Math.sin(a) * d;
    if (n % 2 === 0) {                              // 挖洞 → 云絮的不规则破边
      g2.globalCompositeOperation = 'destination-out';
      const hole = g2.createRadialGradient(px, py, 0, px, py, rr);
      hole.addColorStop(0, 'rgba(0,0,0,.5)');
      hole.addColorStop(1, 'rgba(0,0,0,0)');
      g2.fillStyle = hole;
    } else {                                        // 加斑 → 云的鼓包
      g2.globalCompositeOperation = 'source-over';
      const puff = g2.createRadialGradient(px, py, 0, px, py, rr);
      puff.addColorStop(0, 'rgba(' + tr + ',' + tg + ',' + tb + ',.30)');
      puff.addColorStop(1, 'rgba(' + tr + ',' + tg + ',' + tb + ',0)');
      g2.fillStyle = puff;
    }
    g2.beginPath(); g2.arc(px, py, rr, 0, Math.PI * 2); g2.fill();
  }
  g2.globalCompositeOperation = 'source-over';
  SMOKE_TEX.set(key, cv);
  return cv;
}

function spawnSmoke(x, y, midi) {
  const F = FX_SMOKE;
  if (!F.on || smoke.length >= F.max) return;
  smoke.push({
    x: x + rnd(-7, 7), y: y + rnd(-5, 5),
    vx: rnd(-9, 9), vy: rnd(F.rise[0], F.rise[1]),
    age: 0, max: rnd(F.life[0], F.life[1]),
    midi: Math.round(midi),
    pc: ((Math.round(midi) % 12) + 12) % 12,
    tex: (Math.random() * SMOKE_VARIANTS) | 0,
    rot: Math.random() * Math.PI * 2,
    vr: rnd(F.spin[0], F.spin[1]),
    s: rnd(F.size[0], F.size[1]),
  });
}

function stepSmoke(dt, nowS) {
  // v1.5：寿命归粒子自己——音停后继续飘完自然寿命（余韵感的来源）。
  // 不按 d.live 冻结粒子：暂停/停止/播完一律让残留粒子飘完寿命
  // （"中途暂停也让残留动画走完"）。
  // 冻结的只有【时间轴与下落块】——它们由 audioMs 决定，与粒子物理无关；
  // 发射口仍看 d.live，所以暂停时只会"飘完"，不会"续命"。
  const F = FX_SMOKE;
  // v1.6：烟也吃 curl 流场（与火花同场、低频大尺度）——烟随涡旋一起卷，
  // 不再是匀速慢漂的"贴纸"，整幅画面统一成一片流体。
  const cf = FX_EMBER.curlFreq * 0.6, T = nowS * FX_EMBER.curlSpeed * 0.7;
  const dragK = Math.exp(-0.5 * dt);
  for (let i = 0; i < smoke.length;) {
    const p = smoke[i];
    p.age += dt;
    if (p.age >= p.max) { smoke[i] = smoke[smoke.length - 1]; smoke.pop(); continue; }
    const X = p.x * cf + T, Y = p.y * cf * 1.11 - T * 0.42;
    const fx = -Math.sin(X) * Math.sin(Y) * 1.11;
    const fy = -Math.cos(X) * Math.cos(Y);
    p.vx = (p.vx + fx * F.curl * dt) * dragK;
    p.vy = (p.vy + fy * F.curl * dt) * dragK;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    i++;
  }
}

// 烟用【普通 alpha 混合】画在光核层下面：加法会让烟"发光"变雾状光，
// 只有 source-over 的灰白叠层才出体积感。少而大而淡是烟感的全部秘诀。
// v1.6 三件套：①双贴图交叉渐变=团内翻滚（不是刚体旋转）；②半径正弦脉动；
// ③内芯光染层（lighter 小亮团，出生时被键光照亮、随生命熄灭）=体积感的灵魂。
function drawSmoke() {
  if (!smoke.length) return;
  const F = FX_SMOKE;
  ctx.save();
  for (let i = 0; i < smoke.length; i++) {
    const p = smoke[i];
    const k = p.age / p.max;
    const env = Math.min(1, k / 0.15) * Math.pow(1 - k, 1.4);   // 淡入→膨胀淡出（自然寿命）
    if (env < 0.01) continue;
    const texA = smokeSprite(p.pc, p.tex);
    const texB = smokeSprite(p.pc, (p.tex + 1) % SMOKE_VARIANTS);
    if (!texA) continue;
    const r = (p.s * (1 + F.grow * k) / 2) * (1 + 0.06 * Math.sin(p.age * 2.1 + p.rot));
    // 翻滚权重：两张变体贴图按正弦交叉渐变 → 团内结构持续"变样"
    const w = 0.5 + 0.5 * Math.sin(p.age * 1.7 + p.rot * 2.3);
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.globalAlpha = F.alpha * env * (1 - w);
    ctx.drawImage(texA, -r, -r, r * 2, r * 2);
    ctx.globalAlpha = F.alpha * env * w;
    ctx.drawImage(texB, -r, -r, r * 2, r * 2);
    if (k < 0.6) {
      // 内芯光染：小一圈、lighter 叠加——烟被下方键光照亮，光随音符结束而"撤走"
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = F.alpha * 1.7 * env * (1 - k / 0.6);
      const ri = r * 0.52;
      ctx.drawImage(texA, -ri, -ri * 0.8 - r * 0.1, ri * 2, ri * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.rotate(-p.rot); ctx.translate(-p.x, -p.y);   // 手动逆变换，不动外层 dpr 基础变换
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ---- 火花流层（v1.3）----
// curl noise 流场：取标量场 ψ=sin(X)·cos(Y) 的旋度作为推力方向——
// 相邻粒子受力连续相关 → 集体呈流体般的卷曲缠绕（"无规律"其实是有场规律的），
// 场相位随时间演化 → 轨迹永不重复。出射上冲 + 浮力托底 + 场推力 = 参考图那种
// 密集火花沿弯曲线上升的观感。additive 小亮粒（复用珠链的白芯音符色精灵）。
function spawnEmber(x, y, midi) {
  const F = FX_EMBER;
  if (!F.on || embers.length >= F.max) return;
  embers.push({
    x: x + rnd(-5, 5), y: y + rnd(-3, 3),
    vx: rnd(F.v0x[0], F.v0x[1]), vy: rnd(F.vy0[0], F.vy0[1]),
    age: 0, max: rnd(F.life[0], F.life[1]),
    midi: Math.round(midi),
    pc: ((Math.round(midi) % 12) + 12) % 12,
    r: rnd(F.r[0], F.r[1]),
  });
}

function stepEmber(dt, nowS) {
  const F = FX_EMBER;
  // v1.5：同烟层——发射跟声音走，寿命归粒子自己；不按 d.live 冻结（见 stepSmoke）。
  const T = nowS * F.curlSpeed;
  const dragK = Math.exp(-F.drag * dt);
  for (let i = 0; i < embers.length;) {
    const p = embers[i];
    p.age += dt;
    if (p.age >= p.max) { embers[i] = embers[embers.length - 1]; embers.pop(); continue; }
    // 流场推力：ψ = sin(x·cf + T)·cos(y·cf·1.37 − T·0.6)，速度 = curl(ψ)
    const X = p.x * F.curlFreq + T, Y = p.y * F.curlFreq * 1.37 - T * 0.6;
    const fx = -Math.sin(X) * Math.sin(Y) * 1.37;
    const fy = -Math.cos(X) * Math.cos(Y);
    p.vx = (p.vx + fx * F.curl * dt) * dragK;
    p.vy = (p.vy + fy * F.curl * dt + F.buoy * dt) * dragK;
    p.x += p.vx * dt; p.y += p.vy * dt;
    i++;
  }
}

// 火花专用精灵（v1.4）：高饱和音符色、无白芯——出生"很浓很浓"，随寿命整体
// 渐隐（渐变交由 globalAlpha 曲线），让浓→淡的过渡一眼可见。
// 白芯版（trailSprite）会把颜色冲淡，只适合珠链不适合火花流。
const EMBER_SPR = new Map();         // pc → canvas
function emberSprite(pc) {
  let cv = EMBER_SPR.get(pc);
  if (cv) return cv;
  const R = 16;
  cv = document.createElement('canvas');
  cv.width = cv.height = R * 2;
  const g2 = cv.getContext && cv.getContext('2d');
  if (!g2) return null;                          // 桩环境降级
  const [r, g, b] = hsl2rgb(pc * 30, 92, 54);    // 高饱和
  const gr = g2.createRadialGradient(R, R, 0, R, R, R);
  gr.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',.98)');
  gr.addColorStop(0.45, 'rgba(' + r + ',' + g + ',' + b + ',.55)');
  gr.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
  g2.fillStyle = gr;
  g2.fillRect(0, 0, R * 2, R * 2);
  EMBER_SPR.set(pc, cv);
  return cv;
}

function drawEmber() {
  if (!embers.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < embers.length; i++) {
    const p = embers[i];
    const k = p.age / p.max;
    // 浓→淡渐变曲线（v1.4）：前半程几乎保持浓色，后半程加速熄灭 → 过渡肉眼可见
    const a = Math.pow(1 - k, 0.85) * 0.95;
    if (a < 0.02) continue;
    const spr = emberSprite(p.pc);
    if (!spr) continue;
    ctx.globalAlpha = a;
    ctx.drawImage(spr, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 发射源 → 珠（按时间摊薄，低速率 → 离散珠链）
// ★ 只在【真的在发声】的窗口吐珠：块命中键线(t0)才开始，t1 立刻停。
//   若整个下落过程都吐、结束后还留 260ms 余尾 → 观感成了"没声音也在发光"。
// —— 键线能量条粒子（v11）——
// 贴着键线出生、沿线漂浮微抖、正弦闪烁（参考图的"忽明忽暗的亮点"）。
// 复用 emberSprite 高饱和纯色精灵（无白芯），lighter 出亮。
function spawnLinePart(x, y, pc) {
  const F = FX_LINE;
  if (!F.on || lineParts.length >= F.max) return;
  lineParts.push({
    x, y: y + rnd(-3, 3),
    vx: rnd(-F.drift, F.drift), vy: rnd(F.rise[0], F.rise[1]),
    age: 0, max: rnd(F.life[0], F.life[1]),
    r: rnd(F.r[0], F.r[1]),
    tw: rnd(F.tw[0], F.tw[1]), ph: Math.random() * Math.PI * 2,
    pc: 0,                                           // v11.1：线=红色（0=hsl 0 红）
  });
}

function stepLine(dt) {
  // 不按 d.live 冻结（见 stepSmoke）。发射口 emitLine 仍看 live，中断后不新增。
  for (let i = 0; i < lineParts.length;) {
    const p = lineParts[i];
    p.age += dt;
    if (p.age >= p.max) { lineParts[i] = lineParts[lineParts.length - 1]; lineParts.pop(); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    i++;
  }
}

function drawLineParts() {
  if (!lineParts.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < lineParts.length; i++) {
    const p = lineParts[i];
    const k = p.age / p.max;
    const tw = 0.55 + 0.45 * Math.sin(p.ph + p.age * p.tw * Math.PI * 2);   // 闪烁
    const a = Math.pow(1 - k, 1.2) * tw;
    if (a < 0.03) continue;
    const spr = emberSprite(p.pc);
    if (!spr) continue;
    ctx.globalAlpha = a;
    ctx.drawImage(spr, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 发射：环境均匀撒（全线都有）+ 活跃键加权（弹哪段哪段亮）
function emitLine(dt, active, hitY, live) {
  if (!FX_LINE.on || live === false) return;
  const F = FX_LINE;
  if (Math.random() < F.rate * dt) spawnLinePart(Math.random() * W, hitY, -1);
  for (const [m] of active) {
    const g = geom.geo.get(m); if (!g) continue;
    if (Math.random() < F.actBoost * dt) spawnLinePart(g.cx + rnd(-g.w * 0.6, g.w * 0.6), hitY, ((m % 12) + 12) % 12);
  }
}

function emitTrails(dt, aMs, hitY, notes, isProj, active, live) {
  if (!FX_TRAIL.on || aMs < 0 || live === false) return;
  const srcs = [];
  if (isProj) {
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (aMs < n.t0 || aMs >= n.t1) continue;      // 只在发声窗口内
      const g = geom.geo.get(n.midi); if (!g) continue;
      srcs.push({ x: g.cx, y: hitY - 2, midi: n.midi });
    }
  } else {
    // 实时录音：没有块 → 从正在发声的键向上吐珠
    for (const [m] of active) {
      const g = geom.geo.get(m); if (!g) continue;
      srcs.push({ x: g.cx, y: hitY - 2, midi: m });
    }
  }
  if (!srcs.length) return;
  const rate = FX_TRAIL.rate * dt * Math.min(1, FX_TRAIL.maxSrc / srcs.length);
  const srate = FX_SMOKE.on ? FX_SMOKE.rate * dt * Math.min(1, FX_SMOKE.maxSrc / srcs.length) : 0;
  const erate = FX_EMBER.on ? FX_EMBER.rate * dt * Math.min(1, FX_EMBER.maxSrc / srcs.length) : 0;
  for (let i = 0; i < srcs.length; i++) {
    if (Math.random() < rate) spawnOrb(srcs[i].x, srcs[i].y, srcs[i].midi, 1);
    if (Math.random() < srate) spawnSmoke(srcs[i].x, srcs[i].y - 6, srcs[i].midi);
    if (Math.random() < erate) spawnEmber(srcs[i].x, srcs[i].y - 2, srcs[i].midi);
  }
}

// 物理：两段速度插值 + 重力 + 湍流力场（用当前位置采样两个正弦 → 确定性涡流）
// active = 正在发声的键集合：不在其中的粒子立刻进入 offFade 快速淡出（发光 = 有声音）
function stepTrail(dt, active) {
  const F = FX_TRAIL;
  for (let i = 0; i < trail.length;) {
    const p = trail[i];
    if (p.fadeOut >= 0) {                      // 音停淡出中
      p.fadeOut -= dt;
      if (p.fadeOut <= 0) { trail[i] = trail[trail.length - 1]; trail.pop(); continue; }
    } else if (!active.has(p.midi)) {
      p.fadeOut = F.offFade;                   // 声音结束 → 开始快速淡出
    }
    p.age += dt;
    const k = p.age / p.max;
    if (k >= 1) { trail[i] = trail[trail.length - 1]; trail.pop(); continue; }   // O(1) 移除
    const nf = F.turbFreq * 0.01;
    const nx = Math.sin(p.y * nf + p.seed) * Math.cos(p.x * nf * 1.3 - p.seed * 1.7);
    const ny = Math.cos(p.x * nf * 1.1 - p.seed * 0.9) * Math.sin(p.y * nf * 0.9 + p.seed);
    const vx = p.vx1 * (1 - k) + nx * F.turb;
    const vy = p.vy1 * (1 - k) + p.vy2 * k + F.grav * p.age + ny * F.turb;
    p.x += vx * dt; p.y += vy * dt;
    i++;
  }
}

function drawTrail() {
  if (!trail.length) return;
  const F = FX_TRAIL;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    const k = p.age / p.max;
    const r = p.r * (1 - F.rShrink * k);
    const off = p.fadeOut < 0 ? 1 : Math.max(0, p.fadeOut / F.offFade);   // 音停淡出系数
    const a = Math.pow(1 - k, 1.3) * 0.92 * off;
    if (a < 0.02 || r < 0.4) continue;
    const step = Math.min(F.steps - 1, (k * F.steps) | 0);
    const spr = trailSprite(p.pc, step);
    // 双层绘制（v1.2，HDR 分层的 LDR 近似）：大光晕(低 alpha) + 亮核(全 alpha)——
    // 亮度有层次，泛光才有"过曝核心"可糊；单层等亮度怎么调都是"小灯泡"
    ctx.globalAlpha = a * 0.30;
    ctx.drawImage(spr, p.x - r * 2.3, p.y - r * 2.3, r * 4.6, r * 4.6);
    ctx.globalAlpha = a;
    ctx.drawImage(spr, p.x - r, p.y - r, r * 2, r * 2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 命中：活跃键里"新出现"的 = 一次击键（工程/MIDI 与实时录音共用同一判据）
function detectHits(active, aMs) {
  const jump = prevAms < 0 || aMs < 0 || aMs < prevAms || aMs - prevAms > 150;   // 首帧/回跳/拖动
  if (!jump) {
    for (const [m] of active) {
      if (prevKeys.has(m)) continue;
      const g = geom.geo.get(m); if (!g) continue;
      spawnHit(g.cx, m);
    }
  }
  prevKeys = new Set(active.keys());
}

// 冲击光球 + 命中爆发珠（喷在键线处，形成向上升起的光柱）
function spawnHit(x, midi) {
  hits.push({
    x, midi: Math.round(midi),
    pc: ((Math.round(midi) % 12) + 12) % 12,
    age: 0, max: FX_HIT.life * (0.85 + Math.random() * 0.3),
    fadeOut: -1,
  });
  if (hits.length > 26) hits.shift();
  const hitY = H - kbHeight();
  for (let n = 0; n < FX_HIT.burst; n++) spawnOrb(x, hitY - 2, midi, 1.3);
  for (let n = 0; n < 3; n++) spawnSmoke(x + rnd(-10, 10), hitY - 8, midi);   // 命中瞬间顶出几团烟
  for (let n = 0; n < 12; n++) spawnEmber(x + rnd(-8, 8), hitY - 4, midi);    // + 一簇火花
}

function hitKeyW() {
  for (const [, g] of geom.geo) if (!g.black) return g.w;
  return W / 52;
}

// active = 正在发声的键：音停后立即快速淡出（发光 = 有声音）
function drawHits(hitY, active, dt) {
  if (!hits.length) return;
  const F = FX_HIT;
  const kw = hitKeyW();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.fadeOut >= 0) {
      h.fadeOut -= dt;
      if (h.fadeOut <= 0) { hits.splice(i, 1); continue; }
    } else if (!active.has(h.midi)) {
      h.fadeOut = F.offFade;                 // 声音结束 → 快速淡出
    }
    h.age += dt;                             // ⚠️ 必须推进：漏掉它 = 光球满亮永不衰减
    const k = h.age / h.max;
    if (k >= 1) { hits.splice(i, 1); continue; }
    const e = 1 - Math.pow(1 - k, 2);          // 缓出：先快后慢
    const off = h.fadeOut < 0 ? 1 : Math.max(0, h.fadeOut / F.offFade);
    const fade = Math.pow(1 - k, 1.8) * off;
    const [r, g, b] = hsl2rgb(h.pc * 30, 85, 62);
    const col = (a) => `rgba(${r},${g},${b},${a.toFixed(3)})`;
    // ① 光洒琴键：以命中键为中心、向两侧渐隐的横向光带（画在键盘之上 → 光真的落在琴键上）
    const hw = kw * F.spill * (1 + k * 0.5);
    const sg = ctx.createLinearGradient(h.x - hw, 0, h.x + hw, 0);
    sg.addColorStop(0, col(0));
    sg.addColorStop(0.5, col(0.30 * fade));
    sg.addColorStop(1, col(0));
    ctx.fillStyle = sg;
    ctx.fillRect(h.x - hw, hitY, hw * 2, H - hitY);
    // ② 向上的光柱（键线以上，越远越淡）
    const cw = kw * 1.5;
    const cg = ctx.createLinearGradient(0, hitY, 0, hitY - 230);
    cg.addColorStop(0, col(0.26 * fade));
    cg.addColorStop(1, col(0));
    ctx.fillStyle = cg;
    ctx.fillRect(h.x - cw / 2, hitY - 230, cw, 230);
    // ③ 光球
    const br = 12 + F.ballR * e;
    const bg = ctx.createRadialGradient(h.x, hitY, 0, h.x, hitY, br);
    bg.addColorStop(0, col(0.85 * fade));
    bg.addColorStop(0.45, col(0.34 * fade));
    bg.addColorStop(1, col(0));
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(h.x, hitY, br, 0, Math.PI * 2); ctx.fill();
    // ④ 冲击环
    ctx.strokeStyle = col(0.5 * fade);
    ctx.lineWidth = 3.5 * (1 - k) + 0.5;
    ctx.beginPath(); ctx.arc(h.x, hitY, 10 + F.ringR * e, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 假 bloom 取[多级降采样泛光]：全画布单层 blur 回贴最贵，降采样版更省也更"肉"。
// 亮度叠加走 lighter，倍率与权重见 FX_BLOOM。
function bloom(strength) {
  if (fxQuality === 'low') return;   // 低档：无泛光（只有琴键点亮）
  if (!FX_BLOOM.multi) {
    if (!off || off.width !== W || off.height !== H) {
      off = document.createElement('canvas');
      off.width = W; off.height = H;
      offCtx = off.getContext('2d');
    }
    offCtx.clearRect(0, 0, W, H);
    offCtx.filter = 'blur(9px)';
    offCtx.drawImage(ctx.canvas, 0, 0);
    offCtx.filter = 'none';
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = strength;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
    return;
  }
  const lv = FX_BLOOM.levels;
  const w0 = Math.max(1, (W / lv[0][0]) | 0);
  if (!bloomBufs || bloomBufs[0].cv.width !== w0) {
    bloomBufs = lv.map(([d]) => {
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, (W / d) | 0);
      cv.height = Math.max(1, (H / d) | 0);
      return { cv, g: cv.getContext('2d') };
    });
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < bloomBufs.length; i++) {
    const b = bloomBufs[i], blur = lv[i][1], wt = lv[i][2];
    b.g.clearRect(0, 0, b.cv.width, b.cv.height);
    b.g.filter = 'blur(' + blur + 'px)';
    b.g.drawImage(ctx.canvas, 0, 0, b.cv.width, b.cv.height);   // 降采样即预模糊，再 blur 更省
    b.g.filter = 'none';
    ctx.globalAlpha = strength * wt;
    ctx.drawImage(b.cv, 0, 0, W, H);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 画布内的"界面角标"开关（2026-09-15）：角标是状态信息、不是动画内容，
// 但它是用 ctx.fillText 画进画布的 → canvas.captureStream() 会把它一起录进视频
// （「录制时把♪琴声那行也录进去了」）。由 app.mjs 在录制中/纯净模式下广播打开；
// 默认 false，行为与改动前完全一致（不留任何默认可见性变化）。
let chromeHidden = false;
export function setChromeHidden(v) { chromeHidden = !!v; }

// —— 钢琴声状态角标（引擎本体在 anim/piano-sound.mjs）——
function drawSoundBadge() {
  const st = soundStatus();
  ctx.fillStyle = 'rgba(230,233,238,.55)';
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  // 角标跟随当前音色（声源多元化后不再写死 Salamander）
  const head = '♪ 琴声: ' + (st.timbreLabel || '—') + ' · ';
  let label;
  if (st.sampleState === 'ready') label = head + '采样就绪';
  else if (st.sampleState === 'loading') label = head + '加载中 ' + st.loadedCount + '/' + st.sampleCount;
  else if (st.sampleState === 'fallback') label = head + '采样不可用，合成器兜底';
  else if (st.sampleState === 'synth') label = head + '内置合成器';
  else label = head + '待触发加载';
  ctx.fillText(label, 8, 8);
}

function drawHint(hitY) {
  ctx.fillStyle = 'rgba(230,233,238,.30)';
  ctx.font = '13px "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('● 开始录音或播放，钢琴块将落下', W * 0.5, hitY * 0.45);
}

export default {
  id: 'pianoBlocks',
  name: '钢琴块',
  kind: 'full',

  init(c, w, h) {
    ctx = c; W = w; H = h;
    off = null;
    parts = []; hist = []; lastDotT = -1e9;
    liveFrozen = []; liveFrozenEndT = -1; lastFreeze = 0;
    envCuts = []; envScanIdx = 0; dbgNotes = []; dbgTrace = []; lastHist = [];
    prevAms = -1; lastKey = null; lastNow = 0;
    try {
      const saved = localStorage.getItem('ydyi_block_algo');
      // 未知档位值一律回退颗粒（旧键 ydyi_osc_merge 已不读取）
      blockAlgo = ALGO_VALUES.includes(saved) ? saved : 'grain';
    } catch (e) {}
    seenKeys = new Set();
    cache = { frames: null, env: undefined, notes: [] };
    geom = { lo: -1, hi: -1, geo: null };
    trail.length = 0; hits.length = 0; smoke.length = 0; embers.length = 0; lineParts.length = 0; prevKeys = new Set(); bloomBufs = null;
    pressT.clear(); kbSpr.clear();          // 键态与键帽精灵一并复位
  },
  resize(w, h) { W = w; H = h; off = null; bloomBufs = null; kbSpr.clear(); },
  setSoundEnabled(v) { setSoundEnabled(v); },
  setBlockAlgo(v) { setBlockAlgo(v); }, // 出块算法档位(面板下拉)
  // 音色切换（2026-09-13 声源多元化）：下拉单选，接口本体在 anim/piano-sound.mjs
  setTimbre(v) { return setTimbre(v); },
  listTimbres() { return listTimbres(); },
  getTimbre() { return getTimbre(); },
  __dbgDump() { return __dbgDump(); },   // 面板"导调试"按钮入口(对象方法→模块函数)
  setPianoVolume(v) { setPianoVolume(v); },
  setChromeHidden(v) { chromeHidden = !!v; },   // 录制/纯净模式：隐藏画布内的界面角标
  setFxQuality(v) {                              // 特效品质三档（低/中/高），见 applyFxQuality
    if (!['low', 'mid', 'high'].includes(v) || v === fxQuality) return;
    fxQuality = v;
    applyFxQuality();
  },

  frame(d, now) {
    if (!ctx) return;
    if (d.resetKey !== undefined && d.resetKey !== lastKey) {
      lastKey = d.resetKey;
      hist = []; lastDotT = -1e9; parts = []; prevAms = -1;
      liveFrozen = []; liveFrozenEndT = -1; lastFreeze = 0;
      envCuts = []; envScanIdx = 0;
      seenKeys = new Set();
      trail.length = 0; hits.length = 0; smoke.length = 0; embers.length = 0; lineParts.length = 0; prevKeys = new Set();   // 特效层：换片段清空
      pressT.clear();
      cache = { frames: null, env: undefined, notes: [] };
    }
    const dt = Math.min(0.05, Math.max(0, ((now || 0) - lastNow) / 1000));
    lastNow = now || 0;
    const aMs = d.audioMs;
    if (prevAms >= 0 && aMs >= 0 && aMs < prevAms - 150) {
      seenKeys.clear(); parts = [];      // 重播/大幅回跳：重置 onset 去重与粒子
      trail.length = 0; hits.length = 0; smoke.length = 0; embers.length = 0; lineParts.length = 0; prevKeys = new Set();   // 特效层一并作废
      pressT.clear();
      liveFrozen = []; liveFrozenEndT = -1;   // 冻结块一并作废(回跳区重放时重新落定)
    }
    const hitY = H - kbHeight();
    const speed = (hitY - 14) / LOOKAHEAD_MS;

    let notes, isProj = false;
    if (d.midiNotes && d.midiNotes.length) {
      notes = d.midiNotes; isProj = true;          // MIDI 工程/AI转谱：音符事件直供
    } else if (d.projMode && d.projFrames && d.projFrames.length && !d.liveRecActive) {
      ensureProjNotes(d.projFrames, d.env);
      notes = cache.notes; isProj = true;
    } else {
      // 2026-09-08 定案：**实时录音不出块**。
      // 每帧 collectLive + stableLiveNotes 把开放区全量重分一遍的话，segmentPoints
      // 的滞回吸附与深谷切分都依赖局部上下文，新点一来结论就翻 → 块左右漂(音高自改)、
      // 前后合并分裂、快吐时块刚出就消失或不出块。
      // 改为录音期只按当前音高点亮琴键，块一律等录完走离线整段分析
      // (finishRecording → autoAnalyzeClip，与导入音频同一条生产线；实测同一输入两次
      // segmentPoints 结果 JSON 全等，块不可能变)。
      notes = EMPTY_NOTES;
    }
    ensureGeom();

    // 实时录音态没有音符表(notes 为空)，改用当前检测音高点亮琴键
    const active = aMs >= 0 ? (isProj ? activeNotes(notes, aMs) : liveActiveKeys(d)) : new Map();
    // 特效层：命中检测先跑（只改状态不画），需在清屏之前拿到"新出现的活跃键"
    if (FX_HIT.on) detectHits(active, aMs);
    // 画布 2D 上下文是全模板共享同一个对象：整帧包 save/restore，避免 fillStyle/font/
    // textAlign/globalAlpha 等泄漏给别的模板（内部 10 组 save/restore 均两两配对，故安全）。
    ctx.save();
    ctx.fillStyle = '#07090d';
    ctx.fillRect(0, 0, W, H);

    if (aMs >= 0) {
      spawnOnsets(notes, aMs);
      if (isProj) for (const n of notes) drawBlockProj(n, aMs, speed, hitY);
      else for (const n of notes) drawBlockLive(n, aMs, speed, hitY);
      // d.live=false(暂停/停止/播完) 时不再吐珠：aMs 是冻结值，否则会原地持续冒粒子
      emitTrails(dt, aMs, hitY, notes, isProj, active, d.live);
    }
    // 特效推进闸：粒子/烟/尾焰【不设闸】——它们有自然寿命，任何中断（暂停/停止/播完）都该
    // 飘完再消失。按 d.live 整帧冻结的话，曲子一完 / 一按暂停，半空的粒子就僵在原地
    // （2026-09-20 两次口径调整："播完要让动画走完" → "中途暂停也不要定格"）。
    // ⚠️ 与它配套的只有一件事：发射口仍看 d.live —— 中断后不再吐新粒子，否则 aMs 是冻结值，
    //    会变成原地无限冒。冻结时间轴/下落块由 audioMs 负责，与本层无关。
    emitLine(dt, active, hitY, d.live);  // 能量线粒子：环境均匀撒 + 活跃键加权（中断后不发射）
    stepSmoke(dt, now / 1000);           // 烟层：寿命归粒子自己；curl 流场卷动
    stepEmber(dt, now / 1000);           // 火花流：curl 流场推进（场随时间演化）
    stepLine(dt);                        // 能量线粒子步进
    drawSmoke();                        // 烟垫在最下（source-over 出体积感）
    drawEmber();                        // 火花叠烟上（additive 出亮度）
    stepTrail(dt, active);              // active = 发声中的键 → 音停即快速淡出
    drawTrail();                        // 珠链：画在键盘之前 → 键线以下被键盘自然遮住
    drawParts(dt);
    drawKeyboard(active, hitY, dt, aMs >= 0 ? { notes, aMs, speed, isProj } : null);
    drawKeyLights(active, hitY);        // 点光层：活跃键/命中照亮邻键（低档不开）
    drawBand(active, hitY, now / 1000); // 能量条：光晕+流动芯线+活跃键热斑
    drawLineParts();                    // 沿线闪粒子（lighter，画在芯线之上）
    if (FX_HIT.on) drawHits(hitY, active, dt);   // 光球/光洒琴键：压在键盘与发光带之上
    if (!(aMs >= 0)) drawHint(hitY);
    bloom(0.42);
    if (soundEnabled() && !chromeHidden) drawSoundBadge();   // 录制/纯净模式下不画状态角标
    ctx.restore();
    prevAms = aMs;
  },
};
