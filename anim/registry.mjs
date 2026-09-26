// ============================================================
// anim/registry.mjs —— 动画模板注册表
//
// 目标：动画做成"可插拔模板"，想用谁用谁，以后闲了自己再写模板加进来。
// 一个模板 = 一个独立文件，export 默认对象，遵守下面的统一接口即可被加载。
// 系统只负责：注册 -> 记住当前选中 -> 每帧把数据快照喂给当前模板。
//
// ---- 模板统一接口（每个模板文件默认导出）----
// export default {
//   id:    '唯一id',               // 字符串，注册表 key
//   name:  '显示名',               // 工具条按钮文字
//   kind:  'pitch' | 'full',       // 'pitch'=自带读数栏的音高模板(音高星盘)；
//                                  // 'full'=独占整块画布(音高轨迹/钢琴块/跟音练习)
//   renderer?: 'gl',               // ⚠ 预留、当前无模板使用（全部模板都是 2D）。写着是因为
//                                  // app.mjs 侧的画布互斥切换还留着：真加 WebGL 模板时
//                                  // init 会收到独立 canvas 元素，自行创建 three renderer。
//   init(c, w, h),                 // 首次/画布重建时调用一次。c = 2d ctx 或 gl canvas
//   resize(w, h),                  // 画布尺寸变化
//   frame(d, now),                 // 每帧调用。d = 数据快照(结构见下)
// }
//
// ---- 每帧数据快照 d（由 app.mjs 每帧构造后喂给 frame）----
// d = {
//   voiced:   bool,                    // 门控判定"发声中"
//   freq:     number|NaN,              // 融合后基频 Hz（未发声=NaN）
//   midi:     number|NaN,              // 对应 MIDI（A4=69）
//   note:     string,                  // 'C5' 或 '--'
//   cents:    number,                  // 相对最近半音偏差
//   hz:       number,                  // 显示用频率
//   prom:     number,                  // 峰突出度 dB
//   rms:      number,                  // 当前块 RMS
//   spectrum: Float32Array|null,       // 频域幅度(线性0~1)，瀑布/频谱类用；null 表示暂无
//   specBins: number,                  // spectrum 数组长度
//   specFmax: number,                  // spectrum 覆盖到的最高 Hz(横轴刻度)
//   waveform: Float32Array|null,       // 最近一帧时域波形(±1)，示波器类用；null=尚未运行
//   lastGoodFreq: number,              // 平滑后用于显示的频率
//   audioMs:  number,                  // 音频游标 ms(时间类动画的时间轴基准)：
//                                      //   播放器视图=播放头位置(暂停/拖动也正确)；
//                                      //   录音中=已录时长；空闲=-1(无活动时间轴，画空态)
//   resetKey: number,                  // 片段代际(录音/导入/新建自增)：曲线类模板据此复位
//   live:     bool,                    // 此刻【真的有音频在流】：录音中/试听播放中/工程回放中=true；
//                                      //   暂停、停止、播完、空闲=false。
//                                      //   时间驱动/数据驱动类模板必须看它：为 false 时应当
//                                      //   冻结画面(不要继续推进时间轴、不要衰减动画、不要用
//                                      //   陈旧输入重新绘制)，否则表现为"暂停后动画还在动"。
//                                      //   ⚠️ 配套：snapshot 在 live=false 时会把 spectrum 置 null。
//                                      //   ⚠️ 作用域（2026-09-20 收窄）：它冻的是【由 audioMs 驱动】
//                                      //      的内容——时间轴推进、游标、下落块位置，以及"用陈旧输入
//                                      //      重新绘制"。**不要**拿它去冻有自然寿命的自由特效
//                                      //      (粒子/烟/尾焰)：那些在任何中断(暂停/停止/播完)下都该
//                                      //      飘完自然寿命再消失，一味冻结只会让它们僵在半空
//                                      //      （2026-09-20："中途暂停也让残留动画走完"）。
//                                      //      这类特效只需做到"发射口看 live"——中断后不吐新粒子，
//                                      //      物理步进不必设闸。
//   projMode:   bool,                  // 纯分析存档回放(工程查表)，无实时检测帧
//   projFrames: Array|null,            // 工程帧 [{t(ms),freq,voiced,...}]（projMode 时有效；
//                                      //   帧自带真实 t，勿按索引×hop 推时间）
// }
// ============================================================

// 注册表：id -> 模板对象
const templates = new Map();
// 已加载顺序（工具条按钮按此顺序显示）
const order = [];
// 当前选中模板 id
let currentId = null;

// 注册一个模板（模块文件在 app.mjs import 后自注册）
export function register(t) {
  if (!t || typeof t.frame !== 'function') {
    console.warn('[anim] 跳过非法模板:', t && t.id);
    return;
  }
  if (!templates.has(t.id)) order.push(t.id);
  templates.set(t.id, t);
}

// 安装一批模块（每个都是 {default: 模板}）
export function install(modules) {
  for (const m of modules) {
    const t = m.default || m;
    if (t && t.id) register(t);
  }
}

export function get(id) { return templates.get(id) || null; }

export function list() { return order.map(id => templates.get(id)); }

export function current() { return currentId ? templates.get(currentId) || null : null; }

export function setCurrent(id) {
  if (!templates.has(id)) return false;
  currentId = id;
  try { localStorage.setItem('ydyi.anim', id); } catch (e) {}
  return true;
}

// 启动时恢复上次选中的模板；没有则用列表第一个
export function initDefault() {
  let saved = null;
  try { saved = localStorage.getItem('ydyi.anim'); } catch (e) {}
  const t = (saved && templates.get(saved)) || list()[0] || null;
  if (t) currentId = t.id;
  return currentId;
}

export default { register, install, get, list, current, setCurrent, initDefault };
