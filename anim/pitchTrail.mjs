// ============================================================
// anim/pitchTrail.mjs —— 音高曲线模板：心电图式卷帘 (kind:'full')
//
// 设计（2026-09-06 定案，替代"跟随式中央基准卷帘"）：
//   - 横轴=时间(ms)，纵轴=半音音高；
//   - "此刻"线钉在画面右 78% 处：它代表当前音频游标 audioMs，
//     最新检测点从此刻线向左铺开，历史曲线铺满左段可视窗(≈10s)；
//   - 时间轴用【音频时钟 d.audioMs】(回放=播放头位置, 录音=已录时长)，
//     不用渲染帧时钟——掉帧只影响点密度，曲线与声音严格同步；
//   - 气口(有声进行但瞬时未测到)不冻结：audioMs 继续推进、窗口左移、
//     曲线留空(短气口自动桥接)；只有暂停/停止(游标静止)画面才冻结；
//   - 音高纵向窗口围绕当前音【居中缓动】(±1 八度窗，feian n3 移植)：
//     目标=最新音区段的中位数(中值窗抗单帧气音/假频)，每帧按比例速度
//     speed=clamp(K·Δpx, min, max) px/s 渐进逼近，近慢远快、帧率无关；
//     死区 10px 内静止，永不瞬移；静音(无新 voiced 点)时目标冻结、窗口不漂移；
//     不做"缩放适配可见全貌"——那会让刻度不断变化，且一段高音压扁整条曲线。
//     超出当前 ±1 八度窗的历史曲线部分直接在窗外不可见(2026-09-06 定案)。
//
// 双数据源，共用同一心电图渲染：
//   - 实时(录音/回放实时检测)：逐帧把 voiced 点 {t,f} 收进 hist；
//   - 工程帧(纯分析存档回放, d.projMode)：直接取 d.projFrames，帧自带
//     真实 t（按索引推算横轴在分片拼接后会错位）；
//     voiced=false 但 freq>0 的桥接帧画细灰弱线。
//
// 数据：d.voiced / d.freq / d.lastGoodFreq / d.audioMs / d.resetKey /
//       d.projMode / d.projFrames
// ============================================================
import { freqToNote } from '../dsp/core.mjs';
import { promNorm, rmsNorm } from './viz-common.mjs';
import { fxInit, fxSet, fxReset, fxConfig, fxFeed, drawFxBars, drawFxSpectrum, drawFxOverlays, drawFxHead } from './trailFx.mjs';

// —— 可调 ——
const NOW_FRAC = 0.78;        // 此刻线在画布宽度占比(右端偏内)
const WIND_MS = 10000;        // 可视时间窗跨度(历史向左 10 秒)
const SEMI_RANGE = 12;        // 纵轴半音窗半径(±1 八度)
const SEMI_MIN = 21;          // 纵轴可显示最低半音 = A0(27.5Hz，与 detect freqMin 一致)
const SEMI_MAX = 108;         // 纵轴可显示最高半音 = C8(4186Hz，与 detect freqMax 一致)
// —— 纵轴居中缓动参数(feian n3 移植 + 比例速度)——
const FOLLOW_DEAD_PX = 10;    // 死区：窗口中心与目标差距≤10px 静止(防抖)
const FOLLOW_MIN_PX_S = 60;   // 最慢速度(px/s)：近处仍保证收敛(≈1px/帧@60fps)
const FOLLOW_MAX_PX_S = 1800; // 最快速度(px/s)：限速防止瞬移(≈30px/帧@60fps)
const FOLLOW_K = 6;           // 比例系数：speed = clamp(K*|Δpx|, MIN, MAX)，近慢远快无档位感
// —— 视角跟随"大中值窗 + 目标限速"（2026-09-11 二次修复）——
// 气音/假频可能连续 2~4 帧给出同一个离谱低音(如 A1)。光有"远跳确认"不够：
// 确认后若瞬移目标，气音持续 5 帧照样把视角猛拉走再弹回。正确做法是——
//   - TARGET_BUF_N=15 大中值窗：A1 只占少数帧，中位数被多数 C5 拉回；
//   - 目标每帧限速 YF_STEP_SEMI=1.2 半音：即使中位数短暂被污染，视角也只缓慢
//     漂移一点、气音一停立刻回正；真换音持续占满窗口则平滑滚动跟过去。
const TARGET_BUF_N = 15;      // 目标中值窗帧数：气音少数帧翻不过多数主音
const YF_STEP_SEMI = 1.2;     // 目标每帧最大移动(半音)：限速防瞬移式跳变
const DOT_MS = 30;            // 实时采样节流(≈33 点/s，窗内 ~300 点)
const GAP_MS = 900;           // 相邻采样间隔 > 此值视为长停，抬笔断开
const BRIDGE_DOT_MS = 120;    // 实时桥接帧独立节流(比 voiced 采样稀，画灰弱段)
const TREND_STEP_MS = 350;    // 趋势折线取点间隔(主曲线 23-30ms 的粗采样版，直线相连)
const C_LABEL = 'rgba(230,233,238,.4)';
const HAIR = 'rgba(230,233,238,.07)';
const HAIR_FADE = 'rgba(230,233,238,.035)';
const ACCENT = '#8ce6ff';       // 2026-09-10 提亮：大屏深色背景下更醒目(原 #7dd3fc)

// —— 曲线平滑：One Euro Filter（2026-09-20）——
// 现状问题：曲线本体画的是【原始逐帧检测值】(23~30ms/帧)，颤音/换音/气声交界处
//   有肉眼可见的锯齿抖动；TARGET_BUF_N 中值窗只作用于"视口中心跟随"，曲线本身不受益。
// One Euro Filter(Casiez 2012) 的精髓 = 截止频率随速度自适应：
//   fc = fcMin + β·|ẋ|  → 慢速(稳定长音)用极低截止强滤，抹平抖动；
//                          快速(颤音/滑音/换音)截止抬高，几乎不滤 → 不拖延迟、不吃颤音。
//
// ⚠⚠ **必须在对数域(半音)上滤，不能在 Hz 域**（2026-09-20 实测踩到）：
//   Hz 域下同样的"半音幅度"在高低音区对应完全不同的 Hz 速度 → 同样的参数在高音区
//   几乎不滤、低音区滤过头；且 β 的量纲随音区漂移，根本调不出统一手感。
//   改到半音域后，高音区(A4)与低音区(A2)实测结果**逐项相同**（33%/33%、70%/70%…），
//   β 也有了直观量纲(每"半音/秒"抬高多少 Hz 截止)。
//
// 参数标定（30ms/帧，DFT 测量颤音与高频残差）：
//   β=3 → 真颤音(5.5Hz ±45c)保留 70%；检测抖动(±5~15cents)在 12~14Hz 的残差只剩 15~21%
//        （即压掉 79~85%）。β 越大越保颤音、抖动漏得越多；β=2 抖到 13~24% 但颤音只剩 60%。
//   取 β=3 是"颤音留 70% 有余量、抖动压掉 8 成"的折中。
// ⚠ 不要用"二阶差"评估颤音保留——33Hz 采样下 5.5Hz 每周期仅 6 点，二阶差对相位极敏感，
//   会把"相位滞后"误读成"幅度丢失"（曾据此误判成"颤音被吃掉 3/4"）。用 DFT 幅度或 RMS 偏差。
const EOF_ENABLED_DEFAULT = true;
const EOF_FC_MIN = 1.1;       // 最低截止(Hz)：越低越平滑。0.5~1.5 是可辨区间
const EOF_BETA = 3.0;         // 速度系数(半音域)：越大 → 快速段放行越多(颤音保得越好、抖动漏得越多)
const EOF_D_CUTOFF = 1.0;     // 速度信号自身的低通截止(Hz)，标准实现取 1.0
let eofOn = EOF_ENABLED_DEFAULT;
let eofFcMin = EOF_FC_MIN, eofBeta = EOF_BETA;
// 工程帧模式的平滑预热时长：滤波器从窗口左缘再往前这么多毫秒开始喂(输出丢弃)。
// 取 1500ms，实测在 fcMin=1.1Hz 下已足够让滤波器进入稳态(时间常数 ~1/(2π·1.1)≈145ms)。
const EOF_WARMUP_MS = 1500;

// 一维 One Euro 滤波器实例（纯对象，无类）；首点直接采用，不滤波
function mkEof(fcMin, beta, dCut) {
  return { y: NaN, dy: 0, xPrev: NaN, tPrev: NaN, fcMin, beta, dCut };
}
// 输入：半音值 x 与时间 t（秒）。返回滤后的半音值。
function eofStep(s, x, t) {
  if (!Number.isFinite(s.y) || !Number.isFinite(s.tPrev)) {
    s.y = x; s.tPrev = t; s.xPrev = x; return x;
  }
  let dt = t - s.tPrev;
  if (!(dt > 0)) dt = 1 / 60;                 // 时钟未推进(同一帧重复喂)：按 60fps 估
  s.tPrev = t;
  const aD = dt / (dt + 1 / (2 * Math.PI * s.dCut));
  const dx = (x - s.xPrev) / dt;
  s.dy = s.dy + aD * (dx - s.dy);
  s.xPrev = x;
  const fc = s.fcMin + s.beta * Math.abs(s.dy);
  const a = dt / (dt + 1 / (2 * Math.PI * fc));
  s.y = s.y + a * (x - s.y);
  return s.y;
}
let eofM = mkEof(EOF_FC_MIN, EOF_BETA, EOF_D_CUTOFF);
function resetEof() { eofM = mkEof(eofFcMin, eofBeta, EOF_D_CUTOFF); }
// 对单个采样点做平滑（返回新对象；prom 原样透传）
// 入口/出口都在 Hz，内部在半音域运算（见上"必须在对数域滤"）。
function eofPoint(t, f, prom) {
  const y = eofOn ? Math.pow(2, (eofStep(eofM, semiOf(f), t / 1000) - 69) / 12) * 440 : f;
  return { t, f: y, prom };
}

// 大屏适配：主线宽随画布宽度微调，避免大屏下曲线显得过细。
// ⚠ 2026-09-20 线宽实测偏细 → 整条基准宽上调一档：
//   原 (3.2, 5.2, /420) 实测小屏只有 3.2px、1920 宽才 5px，投影/远看都像发丝。
//   现 (4.6, 7.6, /360) → 1280 宽 ≈5.2px、1920 宽 ≈7.6px（触上限）。
//   classic 主线（drawMain）的线宽基准。2026-09-20 四新档删除后这是唯一消费者。
const W_BASE_MIN = 4.6;       // 基准宽下限(px)
const W_BASE_MAX = 7.6;       // 基准宽上限(px)
const W_BASE_DIV = 360;       // 基准宽 = W / 此值
const mainW = () => Math.min(W_BASE_MAX, Math.max(W_BASE_MIN, W / W_BASE_DIV));

// —— 显示级聚合（对标同类应用"秒桶取代表点"）——
// aggMs = 聚合桶宽(ms)：0=逐帧(原样)；>0 把 dt<桶宽的一批帧压缩成一个代表点
// (组内频率取中位数，抗单帧离群)。可视选项: 60/125/250/500/1000ms
// (≈ 3/5/11/22/43 帧 @23ms)。断开判定 gapLim 随 aggMs 放大，防聚合后连续段被误断。
let aggMs = 0;

// —— 废案风档（feian，2026-09-20 新增）：46ms 节流 + 双阈值断连 + 粗实线 ——
const FA_DOT_MS = 46;         // 采样节流：22050Hz / bufferSize=1024 无重叠 → 21.5 帧/s ≈ 46ms/点
const FA_FIT_SEMI = 6;        // 断连阈值①：相邻点 |Δ半音| > 6 抬笔（r3 绘制 lambda 实锤）
const FA_FIT_MS = 500;        // 断连阈值②：相邻点 |Δt| > 500ms 抬笔（同上）
const FA_OCT_SEMI = 11;       // 八度保护：与上一采样点 |Δ| > 11 半音(≈1.9×)视为可疑跳变（d6.n）
const FA_OCT_PROB = 0.9;      // 八度保护：promNorm < 0.9 才丢弃（置信高 = 真跳变放行）
const FA_COLOR = '#4be15f';   // 荧光绿（取色基准，可按需微调）
const faW = () => Math.min(11, Math.max(6.5, W / 240));   // 废案线宽：粗实线基准，可按需微调
// 律动背景柱宽：按【数据源实际采样间隔】× px/ms × 0.72 留缝，钳 2~6px（trailFx 专用）。
// ⚠ 不能写死 FA_DOT_MS(46ms)：工程帧/录音活工程路径是 23ms 分析帧间隔，按 46ms 算柱宽
//   会让相邻柱重叠糊成一片（2026-09-22 修）。
const fxBarWFor = (stepMs) => Math.max(2, Math.min(6, stepMs * (nowX() - padL) / WIND_MS * 0.72));
const FA_STABLE_N = 5;        // 当前音大字防抖：同音连续 N 个采样点才显示（r3→f3/q1 计数 ≥5 实锤）
const FA_NOTE_COLOR = '#8bc34a';      // 段音名标签浅绿（r3 实锤 0xff8bc34a）
const FA_INTERVAL_COLOR = '#ff9800';  // 段间音程标注橙（r3 实锤 0xffff9800，虚线 DashPathEffect[2,15]）
const FA_INTERVAL_GAP_MS = 1000;      // 相邻段时间隔 ≤ 此值才画音程连接（长气口不连）
const FA_GLIDE_MIN_SEMI = 2;  // 滑音渐隐：段内相邻点 |Δsemi| 超过此值的连线降 alpha（同类应用 2Hz 判据的半音域换算）
const FA_GLIDE_FADE = 0.55;   // 滑音渐变强度：中段相对端点的变暗幅度（要"很强的渐变"，原式 1−atan(1+0.25·min(6,Δpx−6))/π 偏弱已调陡）
const FA_GLIDE_REACH = 12;    // 滑音渐变作用距离(px)：片中心离连线两端超过此距离 alpha 到最低
const FA_GLIDE_SLICE_PX = 5;  // 滑音连线沿线切片步长(px)：逐片 alpha 形成连续渐变（r3 沿线插值 min(d,dist−d) 对称形态实锤）
// 当前音大字稳定计数（r3 内 f3/q1{a:上帧midi,b:音名,c:连续计数} 的等价物）
let faStable = { midi: NaN, note: '', count: 0 };

// —— 废案曲线本体渲染开关（2026-09-21 二轮，全部做成可选）——
// ⚠ 默认全关：默认观感 = 已验收的废案一比一（trail-feian 守卫锁死无光晕/线宽=faW）。
//   localStorage 'ydyi_fa_*' 持久化，'1'=开。音高判据/断连/采样全部不动。
const FA_BODY_KEYS = { ribbon: 1, glow: 1, breath: 1, shadow: 1, smooth: 1, hue: 1 };
let faBody = { ribbon: false, glow: false, breath: false, shadow: false, smooth: false, hue: false };
const FA_RIBBON_DEPTH = 56;                 // 色带填充向下渐隐深度(px)
// 辉光：2026-09-22 改为【整层模糊副本】——曲线照常画一遍到专用 glow 画布，
// 再用 ctx.filter='blur()' 低 alpha 整体贴到主画布。旧的"每段 shadowBlur"是
// 每帧 ~200 次模糊（canvas 最贵操作之一），大屏/长录音掉帧，且逐段模糊衔接不均。
const FA_GLOW_BLUR = 6;                     // 模糊半径(px，filter blur)
const FA_GLOW_ALPHA = 0.55;                 // 辉光层透明度
const FA_SHADOW_DX = 4, FA_SHADOW_DY = 6;   // 落影偏移(px)
// 落影颜色：舞台底 #0b0f14 近黑，纯黑影完全不可见（真机反馈"看不到变化"）
// → 用暗绿回声（比线暗一个档、比底亮一点）才有"浮起"层次。
const FA_SHADOW_STYLE = 'rgba(18,46,30,.55)';
const FA_BREATH_MIN = 0.6, FA_BREATH_MAX = 1.5;     // 响度呼吸线宽倍率夹紧（0.75~1.35 真机太弱，加大）
// 呼吸线宽：pw=rmsNorm(rms)(0~1，真响度) → 倍率 0.6~1.5；pw 缺失按 0.5（≈基准宽）
// ⚠ 2026-09-22 由 promNorm 改为 rmsNorm：prom 是"音高显著度"不是音量，语义不符。
function faBreathW(pw) {
  const p = Number.isFinite(pw) ? Math.max(0, Math.min(1, pw)) : 0.5;
  return faW() * (FA_BREATH_MIN + (FA_BREATH_MAX - FA_BREATH_MIN) * p);
}
// 八度色相：以基准绿(#4be15f≈hsl130)为中心，每八度 ±10° 色相（90~170 绿-青域，±5° 真机太弱）
export function faColorForSemi(s) {
  const oct = Math.max(0, Math.min(8, Math.floor(s / 12) - 1));
  return `hsl(${130 + (oct - 4) * 10},68%,56%)`;
}
export function faBodyWidthFor(pw) { return faBreathW(pw); }

// 档位白名单【唯一来源】：classic + feian。
// ⚠ 保留回落语义——localStorage('ydyi_trail_style') 里可能存着未知档名：
// 查不到 → 一律回落 classic，不会卡在空档。
const KNOWN_STYLES = { classic: 1, feian: 1 };

let style = 'classic';
let ghostAlpha = 0.2;      // 兼容老 localStorage 读取保留（当前绘制不使用）
let dotsOn = true;         // 同上
const DOTS_R = 3.0;        // 兼容路径引用的常量

let ctx = null, W = 0, H = 0;
// 全音域大图(off) + 视口(主画布) 双层渲染：
// 曲线以【绝对半音坐标】画进纵向覆盖 SEMI_MIN~SEMI_MAX 的离屏画布，
// 主画布每帧只 blit 视口窗口(viewY)那一带。垂直平移仅移动裁剪矩形，
// 曲线本体静止不重算 → 上下拖动不再闪断(2026-09-11)
let offCv = null, offC = null, offPx = 2;   // offPx: 大图像素/半音
let glowCv = null, glowC = null;            // 辉光专用层（只画亮线本身，供模糊贴图，见 blitGlow）
let trendOn = true;           // 浅色趋势折线开关(传输条"趋势"勾选框，localStorage 持久化)
let hist = [];                // 实时采样点 [{t(音频时钟ms), f(Hz)}]，t 递增
let lastDotT = -1e9;          // 上次采样点的音频时钟(采样节流用)
let lastBridgeDotT = -1e9;    // 上次桥接点的音频时钟(桥接帧节流用)
let centerSemi = 60;          // 纵轴窗口中心(半音，float，缓动的"当前值")
let targetSemi = 60;          // 纵轴窗口中心目标(=目标中值窗的中位数，居中语义)
let targetBuf = [];           // 目标中值窗缓冲(最近 TARGET_BUF_N 次 voiced 采样，半音)
let lastStepT = 0;            // 上次缓动帧的时间戳(计算 dt，帧率无关)
let seenVoice = false;
let lastKey = null;           // d.resetKey：片段切换时曲线复位
let userPanning = false;      // 用户按住画布上下拖动(纵轴平移查看)：期间冻结自动跟随

export default {
  id: 'pitchTrail',
  name: '音高轨迹',
  kind: 'full',

  init(c, w, h) {
    ctx = c; W = w; H = h;
    hist = []; lastDotT = -1e9; lastBridgeDotT = -1e9; centerSemi = 60; targetSemi = 60;
    targetBuf = []; lastStepT = 0; seenVoice = false;
    faStable = { midi: NaN, note: '', count: 0 };
    resetEof();
    // 恢复用户上次的趋势折线开关
    try { trendOn = localStorage.getItem('ydyi_trend') !== '0'; } catch (e) {}
    // 恢复显示聚合档位
    try { const v = parseInt(localStorage.getItem('ydyi_agg') || '0', 10); aggMs = v > 0 ? v : 0; } catch (e) {}
    // 恢复曲线样式（现仅 classic；localStorage 里的未知档名一律回落 classic）
    try { const s = localStorage.getItem('ydyi_trail_style'); style = KNOWN_STYLES[s] ? s : 'classic'; } catch (e) {}
    try { const g = parseFloat(localStorage.getItem('ydyi_trail_ghost') || '0.2'); ghostAlpha = Number.isFinite(g) ? Math.max(0, Math.min(0.6, g)) : 0.2; } catch (e) {}
    try { dotsOn = localStorage.getItem('ydyi_trail_dots') !== '0'; } catch (e) {}
    // 恢复曲线平滑开关
    try { eofOn = localStorage.getItem('ydyi_trail_smooth') !== '0'; } catch (e) {}
    // 恢复视觉特效开关(trailFx：彗星头/涟漪/火花/律动背景，默认全开)
    fxInit();
    fxConfig({ fitMs: FA_FIT_MS, triggerSemi: FA_GLIDE_MIN_SEMI });
    // 恢复废案曲线本体渲染开关（默认全关=一比一观感）
    for (const k of Object.keys(FA_BODY_KEYS)) {
      try { faBody[k] = localStorage.getItem('ydyi_fa_' + k) === '1'; } catch (e) {}
    }
  },
  resize(w, h) { W = w; H = h; },
  // 趋势折线开关(app.mjs 的"趋势"勾选框调用；持久化在 localStorage)
  setTrendEnabled(v) {
    trendOn = !!v;
    try { localStorage.setItem('ydyi_trend', trendOn ? '1' : '0'); } catch (e) {}
  },
  // 显示聚合档位(ms；0=逐帧)。app.mjs "画线"下拉调用，持久化。
  setAggMode(ms) {
    aggMs = ms > 0 ? ms : 0;
    try { localStorage.setItem('ydyi_agg', String(aggMs)); } catch (e) {}
  },
  // 曲线样式：现仅 classic。保留回落语义——localStorage 里的未知档名一律落回 classic。
  setStyle(v) {
    style = KNOWN_STYLES[v] ? v : 'classic';
    try { localStorage.setItem('ydyi_trail_style', style); } catch (e) {}
  },
  setGhost(a) {                       // 兼容接口：保留为 no-op，避免外部调用报错
    ghostAlpha = Number.isFinite(a) ? Math.max(0, Math.min(0.6, a)) : 0.2;
    try { localStorage.setItem('ydyi_trail_ghost', String(ghostAlpha)); } catch (e) {}
  },
  setDots(v) {                        // 兼容接口：保留为 no-op，避免外部调用报错
    dotsOn = !!v;
    try { localStorage.setItem('ydyi_trail_dots', dotsOn ? '1' : '0'); } catch (e) {}
  },
  // 曲线平滑开关（One Euro Filter）。默认开。切换时重置滤波器状态，
  // 避免"开→关→开"之间残留半滤状态造成曲线前几帧偏软。
  setSmooth(v) {
    eofOn = !!v;
    resetEof();
    try { localStorage.setItem('ydyi_trail_smooth', eofOn ? '1' : '0'); } catch (e) {}
  },
  // 视觉特效开关（trailFx，name ∈ head/ripple/spark/bars；持久化在 localStorage ydyi_fx_*）
  setFx(name, v) { fxSet(name, v); },
  // 废案曲线本体渲染开关（name ∈ ribbon/glow/breath/shadow/smooth/hue；ydyi_fa_*，默认全关）
  setFaBody(name, v) {
    if (!FA_BODY_KEYS[name]) return;
    faBody[name] = !!v;
    if (name === 'smooth') resetEof();   // 喂不喂 EOF 突变，重置滤波器防半滤残留
    try { localStorage.setItem('ydyi_fa_' + name, faBody[name] ? '1' : '0'); } catch (e) {}
  },
  // 用户按住画布垂直拖动(纵轴平移查看窗外曲线)：开始/结束标记，期间冻结自动跟随
  setUserPanning(v) { userPanning = !!v; if (!userPanning) lastStepT = 0; },
  // 按垂直位移(px)平移纵轴窗口中心，"内容跟手"：鼠标往下拉(dy>0)→曲线跟着下移→高音区进入视野
  panY(dyPx) {
    const pxPerSemi = (H - padT - padB) / (2 * SEMI_RANGE);
    if (!(pxPerSemi > 0)) return;
    const dSemi = dyPx / pxPerSemi;
    centerSemi = Math.max(SEMI_MIN + SEMI_RANGE, Math.min(SEMI_MAX - SEMI_RANGE, centerSemi + dSemi));
    // 同步目标，避免 stepYFollow 快速拉回用户手的位置(放开后再自动跟随)
    targetSemi = centerSemi;
    lastStepT = 0;
  },

  frame(d) {
    if (!ctx) return;
    // 片段切换(录音/导入/新建/打开存档) → 曲线整体复位
    if (d.resetKey !== undefined && d.resetKey !== lastKey) {
      lastKey = d.resetKey;
      hist = []; lastDotT = -1e9; lastBridgeDotT = -1e9; centerSemi = 60; targetSemi = 60;
      targetBuf = []; lastStepT = 0; seenVoice = false; userPanning = false;
      faStable = { midi: NaN, note: '', count: 0 };
      fxReset();
      resetEof();
    }
    const aMs = d.audioMs;
    if (aMs >= 0 && !userPanning) stepYFollow();   // 纵轴居中缓动(用户拖动时冻结)
    if (d.projMode && d.projFrames && d.projFrames.length) drawProject(d.projFrames, aMs, d.live, d.spectrum, d.specFmax);
    else drawLive(d, aMs);
  },
};

// ============================================================
// 显示级聚合（纯函数，可单测导出）：把一批帧压缩成"桶代表点"
// items: [{t(ms), f(Hz), prom?}] 升序 → 返回同构但更稀疏的数组。
// 按绝对时间槽 floor(t/aggMs) 分桶，组内频率取中位数(抗单帧离群)，
// 代表 t 取组内最新点(曲线左缘"到此刻为止")。aggMs<=0 → 原样返回。
// prom 同样取组内中位数（与 f 一致的口径：代表点的可靠度应是该桶的中心趋势，
// 取均值会被单个高 prom 帧拉高，取中位数与"抗离群"的初衷一致）。
// ============================================================
export function aggregateItems(items, aggMs) {
  if (!(aggMs > 1) || !items.length) return items;
  const out = [];
  const fs = [];
  const ps = [];
  let bucket = null, bSlot = 0;
  const flush = () => {
    if (!bucket) return;
    const s = fs.slice().sort((a, b) => a - b);
    const rep = { t: bucket.t, f: s[s.length >> 1] };
    // prom 只在确实存在有效值时带上（老存档帧可能没有 prom 字段）
    if (ps.length) {
      const q = ps.slice().sort((a, b) => a - b);
      const med = q[q.length >> 1];
      if (Number.isFinite(med)) rep.prom = med;
    }
    out.push(rep);
    bucket = null;
  };
  const pushProm = (v) => { if (Number.isFinite(v)) ps.push(v); };
  for (const it of items) {
    const slot = Math.floor(it.t / aggMs);
    if (bucket === null) { bucket = it; bSlot = slot; fs.length = 0; ps.length = 0; fs.push(it.f); pushProm(it.prom); continue; }
    if (slot === bSlot) { bucket = it; fs.push(it.f); pushProm(it.prom); continue; }   // 同槽：更新代表时间+收集
    flush();                                                                          // 跨槽：出代表点
    bucket = it; bSlot = slot; fs.length = 0; ps.length = 0; fs.push(it.f); pushProm(it.prom);
  }
  flush();
  return out;
}

// ============================================================
// 工程帧模式：数据源 = d.projFrames(每帧带真实 t)
// 帧数可达数万(长音频 23ms/帧)，每帧只处理时间窗口内的一段：
// 先二分定位窗口左端(lowerBoundT)，再从那里向后遍历、越过窗口即停，
// 避免整段全扫(查表主路径下这是每帧热路径)。
function drawProject(frames, aMs, live, spec, specFmax) {
  if (!(aMs >= 0)) { ctx.clearRect(0, 0, W, H); drawGrid(liveViewWindow()); return; }
  // 纵轴跟随播放头当前音(与实时模式同一居中缓动，stepYFollow 在 frame 中逐帧渐进)，
  // 不再缩放适配可见内容——适配式纵轴导致刻度不断变化、一段高音会把整条曲线压扁。
  // 跟随式：超出现有音域的部分直接在窗外不可见。
  const cur = cursorFrameAt(frames, aMs);
  if (cur) updateYTarget(cur.freq);
  const viewY = liveViewWindow();
  const winLo = aMs - WIND_MS;

  // 组装窗口内语义点（freq>0 的 voiced/桥接帧），可选聚合
  // prom(峰突出度 dB) 一并透传（aggregateItems 聚合时取中位数）；线宽编码当前无消费方。
  //
  // ⚠ 平滑预热：One Euro 是有状态 IIR，直接从窗口左缘起滤会让前 ~1s 的点处于
  //   "滤波器还没稳定"的过渡态 → 表现为窗口左缘曲线偏软/被拖向历史。工程帧是
  //   可随机访问的整段数组，故从窗口左缘【再往前 EOF_WARMUP_MS】起预热：
  //   预热段的输出丢弃、只保留滤波器状态，窗口内的点用稳定态输出。
  //   预热与正式遍历共用同一个滤波器实例，且每帧重建 —— 工程帧不持有跨帧状态，
  //   拖动播放头任意跳转都不会残留脏状态。
  const iStart = lowerBoundT(frames, winLo - 100 - EOF_WARMUP_MS);
  const cands = [];
  const pw = mkEof(eofFcMin, eofBeta, EOF_D_CUTOFF);
  for (let i = iStart; i < frames.length; i++) {
    const f = frames[i];
    if (f.t > aMs + 100) break;
    if (!(Number.isFinite(f.freq) && f.freq > 0)) continue;
    if (style === 'feian' && !faBody.smooth) {
      // 废案不喂 EOF：逐帧原始值直接画（跳变 1-2 点到位，无拖尾）
      if (f.t < winLo - 100) continue;
      cands.push({ t: f.t, f: f.freq, prom: f.prom, rms: f.rms });
    } else {
      // 半音域滤波（与实时路径同一套；见 eofStep 上方"必须在对数域滤"）。
      // 废案平滑开关打开时 feian 也走这里（预热丢弃逻辑同 classic）。
      const m = eofOn ? eofStep(pw, semiOf(f.freq), f.t / 1000) : semiOf(f.freq);
      if (f.t < winLo - 100) continue;             // 预热段：只喂滤波器，不产点
      cands.push({ t: f.t, f: Math.pow(2, (m - 69) / 12) * 440, prom: f.prom, rms: f.rms });
    }
  }
  // 废案无聚合概念（46ms 逐点采样是一比一观感的一部分），忽略 aggMs；classic 照旧。
  const src = (aggMs > 0 && style !== 'feian') ? aggregateItems(cands, aggMs) : cands;

  // —— 曲线层：一次画进全音域大图(绝对半音坐标)，不按视口裁剪 → 上下拖动不闪断 ——
  ensureOff();
  offC.clearRect(0, 0, offCv.width, offCv.height);
  // 废案无趋势线（完整一比一）
  if (trendOn && style !== 'feian') drawTrend(trendPointsFrom(frames, f => f.freq, winLo, aMs, viewY, offYOf), offC);  // 浅色趋势折线(垫底)
  // 曲线绘制：feian 走废案双阈值断连 + drawMainFa；else 为 classic 直通块（内容一字未改）。
  if (style === 'feian') {
    // 废案断连(r3)：相邻点 |Δt|>500ms 或 |Δ半音|>6 → 抬笔
    // ⚠ 录音也走这里（录音活工程 projMode=true）→ 视觉特效发射口必须挂在本分支：
    //   fxFeed 内部高水位边沿检测保证 drawProject 每帧重放窗口旧点不重复发射。
    const faPts = [];
    let prev = null;
    for (const p of src) {
      if (prev !== null && (p.t - prev.t > FA_FIT_MS || Math.abs(semiOf(p.f) - semiOf(prev.f)) > FA_FIT_SEMI)) faPts.push(null);
      faPts.push({ x: xOfT(p.t, aMs), s: semiOf(p.f), t: p.t, pw: Number.isFinite(p.rms) ? rmsNorm(p.rms) : 0.5 });
      if (p.t <= aMs) {
        fxFeed({ tAudio: p.t, semi: semiOf(p.f), now: performance.now(), live: !!live, energy: rmsNorm(p.rms) });
      }
      prev = p;
    }
    drawMainFa(faPts, offC, (p) => offYOf(p.s));
    if (faBody.glow) { // 辉光层：只画亮线本身（跳过色带/落影/标注），供整层模糊贴图
      ensureGlow();
      glowC.clearRect(0, 0, glowCv.width, glowCv.height);
      drawMainFa(faPts, glowC, (p) => offYOf(p.s), true);
    }
  } else {
    const gapLim = aggMs > 0 ? Math.max(GAP_MS, aggMs * 1.5) : GAP_MS;
    const mainPts = [];
    let prevT = null;
    for (const p of src) {
      if (prevT !== null && p.t - prevT > gapLim) mainPts.push(null);
      mainPts.push({ x: xOfT(p.t, aMs), s: semiOf(p.f) });
      prevT = p.t;
    }
    drawMain(mainPts, offC, (p) => offYOf(p.s));   // 主曲线(voiced+桥接一体，实时同款)
  }
  // —— 主画布：律动背景(trailFx，仅 feian，垫底：回放无频谱 → 响度柱) + 网格 + blit ——
  ctx.clearRect(0, 0, W, H);
  if (style === 'feian') {
    const specDone = drawFxSpectrum(ctx, {
      spec, specFmax,
      x0: padL, x1: nowX(), bottom: H - padB, maxH: H - padT - padB,
    });
    if (!specDone) {
      // 柱宽按【本帧数据源实际间隔】算（工程帧 23ms、feian 实时 46ms 自适应）
      const stepMs = src.length > 1 ? (src[src.length - 1].t - src[0].t) / (src.length - 1) : FA_DOT_MS;
      drawFxBars(ctx, {
        winLo: aMs - WIND_MS, bottom: H - padB, maxH: H - padT - padB,
        barW: fxBarWFor(Number.isFinite(stepMs) && stepMs > 0 ? stepMs : FA_DOT_MS),
        xOfT: (t) => xOfT(t, aMs),
      });
    }
  }
  if (style === 'feian' && faBody.glow) blitGlow(viewY);   // 辉光垫在曲线之下
  drawGrid(viewY);
  blitView(viewY);
  drawCursorAt(aMs, cur, viewY);
  // 起音涟漪 + 转音火花 + 彗星头部（trailFx，仅 feian；叠加在曲线之上）
  if (style === 'feian') {
    drawFxOverlays(ctx, {
      now: performance.now(),
      xOfT: (t) => xOfT(t, aMs),
      yOfSemi: (s) => yOfSemi(s, viewY),
    });
    if (cur) drawFxHead(ctx, nowX(), yOfSemi(semiOf(cur.freq), viewY));
  }
  drawTimeAxis(aMs);
  drawFutureZone();
}

// 二分：帧 t 单调递增，返回第一个 t >= tMs 的索引
function lowerBoundT(frames, tMs) {
  let lo = 0, hi = frames.length - 1;
  if (frames[hi].t < tMs) return frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < tMs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// 播放头吸附最近 voiced 帧：从游标二分位置起，向两侧限幅 ±2s 内找最近
// (长气口处游标落在静音段时返回 null，不显示音名点——与实时语义一致)
function cursorFrameAt(frames, aMs) {
  const n = frames.length;
  if (!n) return null;
  const i0 = lowerBoundT(frames, aMs);
  const spanMs = 2000;
  let k = i0;
  while (k > 0 && frames[k - 1].t >= aMs - spanMs) k--;
  let best = null, bestD = Infinity;
  for (; k < n && frames[k].t <= aMs + spanMs; k++) {
    const f = frames[k];
    if (f.voiced && Number.isFinite(f.freq) && f.freq > 0) {
      const dms = Math.abs(f.t - aMs);
      if (dms < bestD) { bestD = dms; best = f; }
    }
  }
  return best;
}

// ============================================================
// 实时模式：voiced 点收进 hist，再走同一心电图
// ============================================================
function drawLive(d, aMs) {
  // 无活动时间轴(未录音未播放)：清空并画就绪空态
  if (!(aMs >= 0)) { hist = []; drawReadyState(); return; }

  // seek 回退修复(导入/录音回放往回拖时间线后"没曲线")：
  // 播放前进时窗口裁剪(cutT)只删过旧点，不删"未来点"；往回拉后 hist 尾部残留
  // 一批 t>游标 的点，造成两个后果——
  //   (1) 采样节流被 lastDotT 卡住：aMs-lastDotT 为大负数，游标要"追回"旧位置
  //       才恢复采样 → 期间一个新点都不产生；
  //   (2) 绘制遍历遇到 p.t>aMs 就 break(前提是 hist 有序)，残留未来点 + 之后
  //       以更小 t 追加的新点使 hist 乱序 → 提前 break，曲线整段消失，
  //       直到游标越过残留点时间区才"恢复正常"。
  // 对策：每帧把尾部晚于游标的点弹出并同步回退 lastDotT——hist 恒有序且只含
  // ≤游标的历史；小幅回拉时仍能看到回拉点之前的历史曲线，新点无缝衔接。
  // ⚠ seek 回退后滤波器状态建立在"已被弹出的点"的历史上 → 必须重置，
  //   否则回退点到下一个有声点之间会滤出基于未来(已丢弃)值的中间量。
  //   重置代价 = 回退后前几帧滤波不充分(约 2~3 帧)，肉眼不可见。
  let rewound = false;
  while (hist.length && hist[hist.length - 1].t > aMs) {
    hist.pop();
    lastDotT = hist.length ? hist[hist.length - 1].t : -1e9;
    lastBridgeDotT = -1e9;
    rewound = true;
  }
  if (rewound) resetEof();

  const voiced = d.voiced && Number.isFinite(d.lastGoodFreq) && d.lastGoodFreq > 0;
  if (style === 'feian') {
    // —— 废案风采样（2026-09-20，一比一）——
    // 46ms 节流(21.5 帧/s)；八度跳变保护(d6.n)：与上一采样点比 |Δ|>11 半音、
    // 且间隔 ≤500ms、且置信不足(promNorm<0.9) → 丢帧（间隔>500ms = 气口后新起音，放行）；
    // 不喂 EOF（逐帧原始值直接画，跳变 1-2 点到位）；无桥接（断连交给绘制层双阈值）。
    if (voiced && aMs - lastDotT >= FA_DOT_MS) {
      const s = semiOf(d.lastGoodFreq);
      const tail = hist.length ? hist[hist.length - 1] : null;
      const jump = (tail && aMs - tail.t <= FA_FIT_MS) ? Math.abs(s - semiOf(tail.f)) : 0;
      if (jump > FA_OCT_SEMI && promNorm(d.prom) < FA_OCT_PROB) {
        // 丢帧：不推进 lastDotT，下一帧重新判
      } else {
        lastDotT = aMs;
        // 废案平滑开关（faBody.smooth）：开=喂 One Euro（与 classic 同一套）；关=逐帧原始值（废案一比一）
        // rms 一并入库：响度呼吸（faBody.breath）与特效能量柱的真响度来源（2026-09-22）。
        hist.push(faBody.smooth ? { ...eofPoint(aMs, d.lastGoodFreq, d.prom), rms: d.rms }
                                : { t: aMs, f: d.lastGoodFreq, prom: d.prom, rms: d.rms });
        seenVoice = true;
        updateYTarget(d.lastGoodFreq);
        // —— 视觉特效发射口（trailFx，仅 feian 路径走到这里）——
        // 发射口看 d.live（粒子合同：中断不吐新粒子，已发射的飘完寿命）；
        // 涟漪/火花判据由 fxFeed 内部按 (t,semi) 边沿检测（见 fxFeed 注释）。
        fxFeed({
          tAudio: aMs, semi: s, now: performance.now(), live: !!d.live,
          energy: rmsNorm(d.rms),
        });
        // 当前音大字稳定计数（同类应用 f3/q1）：同音连续 ≥FA_STABLE_N 个采样点才显示
        const zm = Math.round(semiOf(d.lastGoodFreq));
        if (zm === faStable.midi) faStable.count++;
        else {
          faStable.midi = zm; faStable.count = 1;
          const nn = freqToNote(d.lastGoodFreq);
          faStable.note = nn.name + nn.oct;
        }
      }
    }
  } else if (voiced && aMs - lastDotT >= DOT_MS) {
    lastDotT = aMs;
    hist.push(eofPoint(aMs, d.lastGoodFreq, d.prom));
    lastBridgeDotT = aMs;
    seenVoice = true;
    updateYTarget(d.lastGoodFreq);
  } else if (Number.isFinite(d.lastGoodFreq) && d.lastGoodFreq > 0
             && aMs - lastDotT >= 0 && aMs - lastDotT <= GAP_MS
             && aMs - lastBridgeDotT >= BRIDGE_DOT_MS) {
    // 实时桥接(与离线 analyzePCM bridgeMs=900 同语义)：voiced=false 但最近一次
    // 发声在 900ms(GAP_MS)内 → 用保持的 lastGoodFreq 补点，避免"离线分析有曲线、
    // 实时却断线"的观感差异(实为同一套 createDetector)。间隔稀于 voiced 采样。
    // ⚠ 桥接点【不滤波】：它的 f 是"上一点的保持值"(阶梯常数)，喂进滤波器只会把
    //   滤波器拖向旧值 → 真发声回来时反而更迟钝。阶梯本身就不抖，无需滤。
    lastBridgeDotT = aMs;
    hist.push({ t: aMs, f: d.lastGoodFreq, prom: d.prom });
  }
  // 丢弃远早于窗口的旧点(留 2s 余量，轻微 seek 后退时仍在)
  const cutT = aMs - WIND_MS - 2000;
  while (hist.length && hist[0].t < cutT) hist.shift();

  const viewY = liveViewWindow();
  // 丢弃晚于游标的点(t>aMs，seek 后退瞬时)
  const nowItems = [];
  for (const p of hist) { if (p.t > aMs) break; nowItems.push(p); }
  // —— 曲线层：一次画进全音域大图(绝对半音坐标)，不按视口裁剪 → 上下拖动不闪断 ——
  ensureOff();
  offC.clearRect(0, 0, offCv.width, offCv.height);
  // 显示聚合开启时先压缩成桶代表点(中位数)，楼点更少、曲线更净；
  // 废案无聚合概念（46ms 逐点采样是一比一观感的一部分），忽略 aggMs。
  const histSrc = (aggMs > 0 && style !== 'feian') ? aggregateItems(nowItems, aggMs) : nowItems;
  // 曲线绘制：feian 走废案双阈值断连 + drawMainFa；else 为 classic 直通块（内容一字未改）。
  if (style === 'feian') {
    // 废案断连(r3)：相邻点 |Δt|>500ms 或 |Δ半音|>6 → 抬笔
    const faPts = [];
    let prev = null;
    for (const p of histSrc) {
      if (prev !== null && (p.t - prev.t > FA_FIT_MS || Math.abs(semiOf(p.f) - semiOf(prev.f)) > FA_FIT_SEMI)) faPts.push(null);
      faPts.push({ x: xOfT(p.t, aMs), s: semiOf(p.f), t: p.t, pw: Number.isFinite(p.rms) ? rmsNorm(p.rms) : 0.5 });
      prev = p;
    }
    drawMainFa(faPts, offC, (p) => offYOf(p.s));
    if (faBody.glow) { // 辉光层：只画亮线本身（跳过色带/落影/标注），供整层模糊贴图
      ensureGlow();
      glowC.clearRect(0, 0, glowCv.width, glowCv.height);
      drawMainFa(faPts, glowC, (p) => offYOf(p.s), true);
    }
  } else {
    const gapLim = aggMs > 0 ? Math.max(GAP_MS, aggMs * 1.5) : GAP_MS;
    const pts = [];
    let prevT = null;
    for (const p of histSrc) {
      if (prevT !== null && p.t - prevT > gapLim) pts.push(null);
      pts.push({ x: xOfT(p.t, aMs), s: semiOf(p.f) });
      prevT = p.t;
    }
    drawMain(pts, offC, (p) => offYOf(p.s));
  }
  // 废案无趋势线（完整一比一）
  if (trendOn && style !== 'feian') drawTrend(trendPointsFrom(hist, p => p.f, aMs - WIND_MS, aMs, viewY, offYOf), offC);
  // —— 主画布：律动背景(trailFx，仅 feian，垫底：有频谱画真频谱、否则响度柱) + 网格 + blit ——
  ctx.clearRect(0, 0, W, H);
  if (style === 'feian') {
    const specDone = drawFxSpectrum(ctx, {
      spec: d.spectrum, specFmax: d.specFmax,
      x0: padL, x1: nowX(), bottom: H - padB, maxH: H - padT - padB,
    });
    if (!specDone) {
      drawFxBars(ctx, {
        winLo: aMs - WIND_MS, bottom: H - padB, maxH: H - padT - padB,
        barW: fxBarWFor(FA_DOT_MS),      // 实时 feian 采样间隔 = 46ms
        xOfT: (t) => xOfT(t, aMs),
      });
    }
  }
  if (style === 'feian' && faBody.glow) blitGlow(viewY);   // 辉光垫在曲线之下
  drawGrid(viewY);
  blitView(viewY);
  drawCursorAt(aMs, voiced ? d.lastGoodFreq : null, viewY);
  // 起音涟漪 + 转音火花 + 彗星头部（trailFx，仅 feian；叠加在曲线之上）
  if (style === 'feian') {
    drawFxOverlays(ctx, {
      now: performance.now(),
      xOfT: (t) => xOfT(t, aMs),
      yOfSemi: (s) => yOfSemi(s, viewY),
    });
    if (voiced) drawFxHead(ctx, nowX(), yOfSemi(semiOf(d.lastGoodFreq), viewY));
  }
  if (style === 'feian' && hist.length) drawFaBigNote();
  drawTimeAxis(aMs);
  drawFutureZone();
}

function liveViewWindow() { return { lo: centerSemi - SEMI_RANGE, hi: centerSemi + SEMI_RANGE }; }

// 设置纵轴缓动目标 = 最近 TARGET_BUF_N 次 voiced 采样的中位数(居中语义：目标窗口中心=当前音)。
// 用中值窗而非最新单帧(feian 是"邻近一致帧簇取均值")——单帧气音/假频翻不过中位数。
//
// 2026-09-11 二次修复：上一版"远跳确认"在确认后瞬移目标，气音连续 5 帧照样把视角
// 猛拉走再弹回(只是延迟发生)。真正确保稳定的是【大中值窗 + 目标限速】：
//   - 中值窗加大到 TARGET_BUF_N(15) 帧：气音 A1 只占其中少数几帧，翻不过多数 C5 → 中位数仍是 C5
//   - 即便中位数被短暂污染，目标每帧也最多移动 YF_STEP_SEMI(1.2) 半音 → 视角只是缓慢
//     漂移一点，气音一停立刻回正；真换音(持续多帧占满窗口)则平滑滚动跟过去
function updateYTarget(freq) {
  targetBuf.push(semiOf(freq));
  if (targetBuf.length > TARGET_BUF_N) targetBuf.shift();
  const sorted = targetBuf.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  // 限速滑动：目标每帧最多移动 YF_STEP_SEMI 半音，杜绝瞬移式跳变
  const d = med - targetSemi;
  targetSemi += (d > 0 ? Math.min(YF_STEP_SEMI, d) : Math.max(-YF_STEP_SEMI, d));
}

// ============================================================
// 纵轴居中缓动(feian n3 逐帧循环移植 + 比例速度)：
//   target = 目标中值窗中位数；死区 FOLLOW_DEAD_PX(px) 内窗口静止(防抖)；
//   超出后速度按"离目标距离"算法计算，近慢远快连续无档位感：
//     speed(px/s) = clamp(K × |Δpx|, MIN, MAX)，并按帧间隔 dt 累积位移 →
//   帧率无关；近处指数式收敛、远处限速不瞬移；静音时 target 冻结 → 窗口停住不漂移。
//   末段步长 clamp 不越过目标，避免过冲振荡。
// ============================================================
function stepYFollow() {
  const pxPerSemi = (H - padT - padB) / (2 * SEMI_RANGE);
  if (!(pxPerSemi > 0)) return;
  const dPx = (targetSemi - centerSemi) * pxPerSemi;
  if (Math.abs(dPx) <= FOLLOW_DEAD_PX) return;              // 死区：静止
  const now = performance.now();
  const dt = Math.min(100, lastStepT > 0 ? now - lastStepT : 16.7);  // 钳制 dt 防卡顿后猛跳
  lastStepT = now;
  const speed = Math.max(FOLLOW_MIN_PX_S, Math.min(FOLLOW_MAX_PX_S, FOLLOW_K * Math.abs(dPx)));
  const stepPx = Math.min(Math.abs(dPx), speed * dt / 1000); // 折成当前帧位移，末段一步到位
  centerSemi += (dPx > 0 ? stepPx : -stepPx) / pxPerSemi;
  // 窗中心限制在 [A0+R, C8-R]，保证可视窗完整落进 A0~C8 物理音域：
  // 唱到 G7/A7 等高音时窗口顶到 C8(108)，曲线在窗内正常铺开，不再被压扁在顶边
  centerSemi = Math.max(SEMI_MIN + SEMI_RANGE, Math.min(SEMI_MAX - SEMI_RANGE, centerSemi));
}

// 就绪空态：参照网格 + 提示
function drawReadyState() {
  ctx.clearRect(0, 0, W, H);
  drawGrid(liveViewWindow());
  ctx.fillStyle = 'rgba(230,233,238,.28)';
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('● 开始录音，音高曲线将在此展开', W * 0.5, H * 0.45);
}

// ============================================================
// 坐标与公共绘制
// ============================================================
const padL = 10, padR = 12, padT = 16, padB = 20;
function nowX() { return Math.max(padL + 60, W * NOW_FRAC); }
function xOfT(t, aMs) { return padL + (t - (aMs - WIND_MS)) / WIND_MS * (nowX() - padL); }
function yOfSemi(s, v) {
  const t = (s - v.lo) / Math.max(1, v.hi - v.lo);
  return padT + (1 - Math.max(0, Math.min(1, t))) * (H - padT - padB);
}
function semiOf(f) { return 69 + 12 * Math.log2(f / 440); }
// —— 全音域大图坐标：曲线绝对定位，视口只是裁剪 ——
// 让"±SEMI_RANGE 窗口"恰好占满可视高度，(2R)*offPx = H-padT-padB → 主画布 blit 时 1:1 无缩放
function offYOf(s) { return padT + (SEMI_MAX - s) * offPx; }
function ensureOff() {
  // ⚠ 必须先按**当前** H 算出本帧该有的 offPx，再拿它算 needH 去比：
  //   旧写法用"还停在上一帧的 offPx"算 needH，而 offCv.height 正是同一个 offPx 建的
  //   → 恒等，守卫退化成"只比宽度"。同宽改高（拖窗口下边缘、状态栏换行导致的高度抖动）时
  //   会提前 return，offPx 不更新 → 曲线按旧缩放贴图、网格按新 H 画，纵向错位。
  //   2026-09-18 修（高压线，单独提交，便于回退）。
  const wantPx = (H - padT - padB) / (2 * SEMI_RANGE);   // 像素/半音：与主画布可视高度 1:1
  const needH = Math.ceil((SEMI_MAX - SEMI_MIN) * wantPx + padT * 2);
  if (offCv && offCv.width === Math.max(1, Math.floor(W)) && offCv.height === needH) return;
  offPx = wantPx;
  const w = Math.max(1, Math.floor(W)), h = Math.ceil((SEMI_MAX - SEMI_MIN) * offPx + padT * 2);
  if (!offCv) offCv = document.createElement('canvas');
  offCv.width = w; offCv.height = h;
  offC = offCv.getContext('2d');
}
// 视口窗口半音范围 → 大图中的像素带[sy, sy+sh)；顺带 1:1 blit 到主画布可视区
function blitView(v) {
  const sy = offYOf(v.hi), sh = Math.max(1, (v.hi - v.lo) * offPx);
  ctx.drawImage(offCv, 0, sy, W, sh, 0, padT, W, H - padT - padB);
}

// —— 辉光层（faBody.glow，2026-09-22 改整层模糊副本）——
// 每段直线上挂 shadowBlur = 每帧 ~200 次模糊（canvas 最贵操作之一），大屏/长录音
// 掉帧且逐段衔接不均。现在：曲线（只亮线本身，不含色带/落影/标注）另画一份进 glow 画布，
// 再用 ctx.filter='blur()' 低 alpha 整体贴到主画布 = 每帧 1 次模糊，且辉光连续均匀。
// ⚠ 环境不支持 canvas filter（ctx.filter 非字符串）时直接跳过，避免贴出未模糊的硬副本。
function ensureGlow() {
  const wantPx = (H - padT - padB) / (2 * SEMI_RANGE);
  const needH = Math.ceil((SEMI_MAX - SEMI_MIN) * wantPx + padT * 2);
  const w = Math.max(1, Math.floor(W));
  if (glowCv && glowCv.width === w && glowCv.height === needH) return;
  if (!glowCv) glowCv = document.createElement('canvas');
  glowCv.width = w; glowCv.height = needH;
  glowC = glowCv.getContext('2d');
}
function blitGlow(v) {
  if (!glowC || typeof ctx.filter !== 'string') return;
  const sy = offYOf(v.hi), sh = Math.max(1, (v.hi - v.lo) * offPx);
  ctx.save();
  ctx.filter = `blur(${FA_GLOW_BLUR}px)`;
  ctx.globalAlpha = FA_GLOW_ALPHA;
  ctx.drawImage(glowCv, 0, sy, W, sh, 0, padT, W, H - padT - padB);
  ctx.restore();
}

// 主曲线：发光亮青 + 白芯。
// 逐段独立 stroke(与 drawGrid 同款路径)——bug2 排查期间发现超长单路径 stroke
// 在该环境下不落像素(原因未明，逐段后立即现形)，故保留逐段结构。
// 目标 ctx 与 y 定位函数可传(曲线层统一走全音域大图 offYOf，不做视口裁剪)
//
// ⚠ 2026-09-20 线宽实测偏细 → 本档只调了两个【线宽数值】：
//   主线 mainW()（基准 3.2~5.2 → 4.6~7.6，见常量）与白芯下限 1.1 → 1.7px。
//   结构、路径画法、发光、断开判据一律未动（classic 不许动），
//   改动可 diff 逐符号核对 = 仅这两行。
function drawMain(pts, g, yf) {
  if (!pts.length) return;
  g = g || ctx; yf = yf || ((p) => p.y);
  g.lineCap = 'round'; g.lineJoin = 'round';
  let pen = false;
  const strokeSeg = () => {
    g.lineWidth = mainW();
    g.strokeStyle = hexA(ACCENT, 0.95);
    g.shadowColor = ACCENT; g.shadowBlur = 12;
    g.stroke();
    g.shadowBlur = 0;
    g.lineWidth = Math.max(1.7, mainW() * 0.42);
    g.strokeStyle = 'rgba(240,247,255,.55)';
    g.stroke();
  };
  for (const p of pts) {
    if (!p) { if (pen) strokeSeg(); pen = false; continue; }
    if (!pen) { g.beginPath(); g.moveTo(p.x, yf(p)); pen = true; }
    else g.lineTo(p.x, yf(p));
  }
  if (pen) strokeSeg();
}

// 废案风主曲线（feian 专用，2026-09-20）：荧光绿粗实线。
// 废案档的观感硬约束：
//   无白芯、无光晕(shadowBlur=0)、无淡化连、不按 y 调色、端点不成串；
//   逐帧原始值直画（抖动保留）。逐段独立 stroke(bug2 教训：超长单路径不落像素)。
// 颜色/线宽为初始基准，可按需微调。
// 色带填充（faBody.ribbon，最先画=垫底）：按逻辑笔画收集 run，逐 run 画等深渐隐面积。
// ⚠ 几何必须【正沿曲线过去 + 沿曲线整体下移 depth 折返】= 底边跟随曲线起伏的等深带。
//   第一版用"首点 y 锚 gradient + 首尾直线底边"：音高一起伏，填充区就错位/翻转，
//   真机表现为"只有曲线落到后面（历史段）才能看到部分色带"（2026-09-21 修）。
//   两段式平铺渐隐（内 0.12/56px + 外 0.05/112px）代替 gradient——gradient 锚在
//   run 首点 y，曲线纵向移动时带体颜色会整段错位。
function fillFaRibbons(pts, g, yf) {
  let run = null;
  const band = (depth, alpha) => {
    g.fillStyle = hexA(FA_COLOR, alpha);
    g.beginPath();
    g.moveTo(run[0].x, yf(run[0]));
    for (let i = 1; i < run.length; i++) g.lineTo(run[i].x, yf(run[i]));
    for (let i = run.length - 1; i >= 0; i--) g.lineTo(run[i].x, yf(run[i]) + depth);
    g.closePath();
    g.fill();
  };
  const flush = () => {
    if (!run || run.length < 2) { run = null; return; }
    band(FA_RIBBON_DEPTH, 0.12);
    band(FA_RIBBON_DEPTH * 2, 0.05);
    run = null;
  };
  for (const p of pts) { if (!p) { flush(); continue; } (run = run || []).push(p); }
  flush();
}

// 废案风主曲线（feian 专用，2026-09-20）：荧光绿粗实线。
// 废案档的观感硬约束：
//   无白芯、无光晕(shadowBlur=0)、无淡化连、不按 y 调色、端点不成串；
//   逐帧原始值直画（抖动保留）。逐段独立 stroke(bug2 教训：超长单路径不落像素)。
// 2026-09-21 二轮：四个本体渲染项以 faBody.* 开关接入（默认全关=一比一不变）——
//   ribbon=色带填充（垫底最先画）；glow=辉光（整层模糊副本，见 blitGlow）；
//   breath=响度呼吸（线宽随 rmsNorm(rms) 在 0.6~1.5×基准宽起伏）；shadow=落影（先画偏移暗影）；
//   hue=八度色相（绿-青域 ±10°/八度）。
//   glowPass=true 时只画"亮线本身"（跳过色带/落影/标注）供模糊层使用，避免整块色带与
//   标注文字一起被糊成雾（2026-09-22）。
function drawMainFa(pts, g, yf, glowPass) {
  if (!pts.length) return;
  g = g || ctx; yf = yf || ((p) => p.y);
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (faBody.ribbon && !glowPass) fillFaRibbons(pts, g, yf);
  const segColor = (sMid) => (faBody.hue ? faColorForSemi(sMid) : FA_COLOR);
  const pairWidth = (a, b) => (faBody.breath ? faBreathW(((a.pw ?? 0.5) + (b.pw ?? 0.5)) / 2) : faW());
  let prev = null, pend = null;
  const strokePair = (a, b) => {
    const dSemi = Math.abs(b.s - a.s);
    const y1 = yf(a), y2 = yf(b);
    const w = pairWidth(a, b);
    if (dSemi > FA_GLIDE_MIN_SEMI) {
      // 滑音连线：沿线插值切片、逐片 alpha——r3 实锤形态为 min(d, dist−d) 的对称距离
      // （两端实、中段虚的连续渐变）。强度/作用距离/步长见 FA_GLIDE_* 常量。
      const dpx = Math.max(Math.abs(b.x - a.x), Math.abs(y2 - y1));
      const n = Math.max(2, Math.min(16, Math.ceil(dpx / FA_GLIDE_SLICE_PX)));
      let px0 = a.x, py0 = y1;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const px1 = a.x + (b.x - a.x) * t, py1 = y1 + (y2 - y1) * t;
        const dEnd = Math.min(dpx * (k - 0.5), dpx * (n - k + 0.5)) / n;   // 片中心到较近端
        g.globalAlpha = 1 - FA_GLIDE_FADE * (Math.atan(0.6 * Math.min(FA_GLIDE_REACH, dEnd)) / (Math.PI / 2));
        g.beginPath(); g.moveTo(px0, py0); g.lineTo(px1, py1);
        g.lineWidth = w;
        g.strokeStyle = segColor(a.s + (b.s - a.s) * (k - 0.5) / n);
        g.stroke();
        px0 = px1; py0 = py1;
      }
      g.globalAlpha = 1;
      return;
    }
    if (faBody.shadow && !glowPass) {
      g.globalAlpha = 1;
      g.beginPath(); g.moveTo(a.x + FA_SHADOW_DX, y1 + FA_SHADOW_DY); g.lineTo(b.x + FA_SHADOW_DX, y2 + FA_SHADOW_DY);
      g.lineWidth = w; g.strokeStyle = FA_SHADOW_STYLE; g.stroke();
    }
    g.globalAlpha = 1;
    g.beginPath(); g.moveTo(a.x, y1); g.lineTo(b.x, y2);
    g.lineWidth = w;
    g.strokeStyle = segColor((a.s + b.s) / 2);
    g.stroke();
  };
  const strokeDot = (a) => {
    const y1 = yf(a);
    const w = faBody.breath ? faBreathW(a.pw ?? 0.5) : faW();
    if (faBody.shadow && !glowPass) {
      g.globalAlpha = 1;
      g.beginPath(); g.moveTo(a.x + FA_SHADOW_DX, y1 + FA_SHADOW_DY); g.lineTo(a.x + 0.01 + FA_SHADOW_DX, y1 + FA_SHADOW_DY);
      g.lineWidth = w; g.strokeStyle = FA_SHADOW_STYLE; g.stroke();
    }
    g.globalAlpha = 1;
    g.beginPath(); g.moveTo(a.x, y1); g.lineTo(a.x + 0.01, y1);
    g.lineWidth = w; g.strokeStyle = segColor(a.s); g.stroke();
  };
  for (const p of pts) {
    if (!p) { if (pend) strokeDot(pend); pend = null; prev = null; continue; }
    if (prev) { strokePair(prev, p); pend = null; }
    else pend = p;
    prev = p;
  }
  if (pend) strokeDot(pend);
  g.globalAlpha = 1;
  if (!glowPass) drawFaAnnotations(pts, g, yf);
}

// —— 废案标注层（2026-09-21 二轮；仅 feian 档调用）——
// 当前音大字：白色 34px 右对齐固定右上角；同音连续 ≥FA_STABLE_N 个采样点才显示（防抖计数）。
// 静音时保持显示最后稳定音（q1 不更新、字不消失）。
function drawFaBigNote() {
  if (faStable.count < FA_STABLE_N || !faStable.note) return;
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = '600 34px "Segoe UI", sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillText(faStable.note, W - 16, padT + 6);
}

const FA_INTERVALS = ['纯一度', '小二度/增一度', '大二度', '小三度/增二度', '大三度/减四度', '纯四度',
  '增四度/减五度', '纯五度', '小六度', '大六度', '小七度', '大七度', '纯八度'];

// 段标注 + 段间音程（画进 offC 曲线层，随视口滚动/裁剪）：
// 每段取代表音（semi 中位数，抗单帧离群）→ 浅绿音名 + 八度圆点（oct-4：>0 上标点 / <0 下标点）；
// 相邻段时间隔 ≤FA_INTERVAL_GAP_MS → 橙色虚线连接 + 音程名（|Δmidi| 查表，纯一度~纯八度，r3 packed-switch）。
function drawFaAnnotations(pts, g, yf) {
  const segs = [];
  let cur = null;
  for (const p of pts) {
    if (!p) { if (cur && cur.length >= 2) segs.push(cur); cur = null; continue; }
    if (!cur) cur = [];
    cur.push(p);
  }
  if (cur && cur.length >= 2) segs.push(cur);
  if (!segs.length) return;
  const reps = segs.map((seg) => {
    const ss = seg.map((p) => p.s).sort((a, b) => a - b);
    return ss[ss.length >> 1];
  });
  // 段音名 + 八度点标 + 段间音程，单循环按 x 顺序放置：
  // 音名锚点 = 段左端（r3 形态）；避让链必须 x、y 双维度——x 相交且 |Δy|<12px（≈一行）
  // 才算真重叠（不同音高的相邻段 y 天然错开，不该被跳过；同音高被断开的相邻段才会撞）。
  let lastLabel = null;   // 最后放置的文字 {right, y}
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i], rep = reps[i];
    const f = Math.pow(2, (rep - 69) / 12) * 440;
    const nn = freqToNote(f);
    const label = nn.name + nn.oct;
    const lx = seg[0].x + 4;
    const ty = yf({ s: rep }) - 8;
    g.font = '600 11px "Segoe UI", sans-serif';
    const lw = g.measureText(label).width;
    const crowded = lastLabel && lx < lastLabel.right + 6 && Math.abs(ty - lastLabel.y) < 12;
    if (!crowded) {
      g.fillStyle = FA_NOTE_COLOR;
      g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText(label, lx, ty);
      lastLabel = { right: lx + lw, y: ty };
      const grp = nn.oct - 4;
      if (grp !== 0) {
        g.fillStyle = FA_NOTE_COLOR;
        g.beginPath();
        for (let k = 0; k < Math.abs(grp); k++) {
          const px = lx + lw + 3;
          const py = grp > 0 ? ty - 5 - k * 5 : ty + 5 + k * 5;
          g.moveTo(px, py);
          g.arc(px, py, 1.5, 0, Math.PI * 2);
        }
        g.fill();
      }
    }
    // 段间音程（橙虚线保留；音程文字放虚线中点上方，纳入同一条避让链）
    if (i < segs.length - 1) {
      const a = segs[i][segs[i].length - 1], b = segs[i + 1][0];
      if (b.t - a.t <= FA_INTERVAL_GAP_MS) {
        const iv = Math.min(12, Math.abs(Math.round(reps[i]) - Math.round(reps[i + 1])));
        const x1 = a.x, y1 = yf(a), x2 = b.x, y2 = yf(b);
        g.save();
        g.setLineDash([2, 15]);
        g.strokeStyle = FA_INTERVAL_COLOR; g.lineWidth = 2; g.globalAlpha = 0.9;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        g.restore();
        const ivText = FA_INTERVALS[iv];
        g.font = '11px "Segoe UI", sans-serif';
        const iw = g.measureText(ivText).width;
        const midX = (x1 + x2) / 2, ivY = (y1 + y2) / 2 - 6;
        const crowdedIv = lastLabel && midX - iw / 2 < lastLabel.right + 4
          && Math.abs(ivY - lastLabel.y) < 12;
        if (!crowdedIv) {
          g.fillStyle = FA_INTERVAL_COLOR;
          g.textAlign = 'center'; g.textBaseline = 'bottom';
          g.fillText(ivText, midX, ivY);
          lastLabel = { right: midX + iw / 2, y: ivY };
        }
      }
    }
  }
}

// 浅色趋势折线：主曲线同数据的【粗采样版】——每 TREND_STEP_MS 取一个发声帧，
// 直线相连(点稀疏 → 呈明显折线段)，走势与主曲线一致，直观展示音高变化方向。
// 与主曲线同一音高轴；浅灰白细线，垫在主线之下。逐段 stroke(bug2 教训)。
// y 定位函数可传(缺省=视口相对)；曲线层统一走全音域大图 offYOf——趋势不按视口裁剪
const TREND_STYLE = 'rgba(230,233,238,.38)';
function trendPointsFrom(items, getFreq, winLo, aMs, viewY, yf) {
  // 采样钉在【绝对音频时间槽】上：slot = floor(t / TREND_STEP_MS)，每槽取第一个
  // 发声帧。绝不能以"数据里第一个发声帧"作锚点链式推导——实时模式 hist 持续裁剪
  // (窗 10s+2s 余量)，锚点每帧滑动 → 整条折线每帧重推导(实测换血率 100%)，
  // 表现为折线临近左边消失时鬼畜乱动、成段消失。绝对槽网格与窗口/裁剪完全解耦，
  // 点位只随播放平滑左移；实时/工程帧两模式同语义。
  yf = yf || ((s) => yOfSemi(s, viewY));
  const pts = [];
  let lastSlot = null;
  for (const it of items) {
    const t = it.t;
    if (t > aMs) break;
    if (t < winLo - TREND_STEP_MS * 2) continue;      // 窗外远端跳过(左端平滑退出)
    const freq = getFreq(it);
    if (!(Number.isFinite(freq) && freq > 0)) continue;
    const s = semiOf(freq);
    const slot = Math.floor(t / TREND_STEP_MS);
    if (slot === lastSlot) continue;                  // 每槽只取第一个发声帧
    if (lastSlot !== null && slot - lastSlot >= 2) pts.push(null);  // 空窗≥2槽(700ms)断线
    pts.push({ x: xOfT(t, aMs), y: yf(s) });
    lastSlot = slot;
  }
  return pts;
}
function drawTrend(pts, g) {
  if (pts.length < 2) return;
  g = g || ctx;
  g.lineCap = 'round'; g.lineJoin = 'round';
  let pen = false;
  const strokeSeg = () => {
    // 1.2 → 1.8px（2026-09-20 随主线整体加粗；趋势线是"垫底参考"，不能比主线粗，
    //   但也不能细到看不清——主线下限已 4.6px，1.8 仍明显更细，层级关系保持）
    g.lineWidth = 1.8;
    g.strokeStyle = TREND_STYLE;
    g.stroke();
  };
  for (const p of pts) {
    if (!p) { if (pen) strokeSeg(); pen = false; continue; }
    if (!pen) { g.beginPath(); g.moveTo(p.x, p.y); pen = true; }
    else g.lineTo(p.x, p.y);
  }
  if (pen) strokeSeg();
}

// 此刻线 + 当前音圆点/音名(cur：实时传 Hz；工程传吸附帧 {freq})
function drawCursorAt(aMs, cur, viewY) {
  const nx = nowX();
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = 'rgba(125,211,252,.65)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(nx, padT); ctx.lineTo(nx, H - padB); ctx.stroke();
  ctx.restore();
  let f = null;
  if (typeof cur === 'number' && cur > 0) f = cur;
  else if (cur && Number.isFinite(cur.freq) && cur.freq > 0) f = cur.freq;
  if (!(f > 0)) return;
  const y = yOfSemi(semiOf(f), viewY);
  const nn = freqToNote(f);
  ctx.fillStyle = '#f0f7ff';
  ctx.shadowColor = ACCENT; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(nx, y, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(240,247,255,.95)';
  ctx.font = '600 13px "Segoe UI", sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(nn.name + nn.oct, nx + 10, y);
  ctx.fillStyle = 'rgba(230,233,238,.45)';
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.fillText(f.toFixed(1) + ' Hz', nx + 10, y + 14);
}

// 此刻线右侧"未来"区：淡遮罩 + 标签
function drawFutureZone() {
  const nx = nowX();
  if (nx >= W - padR - 4) return;
  ctx.fillStyle = 'rgba(230,233,238,.02)';
  ctx.fillRect(nx, padT, W - padR - nx, H - padT - padB);
  ctx.strokeStyle = 'rgba(230,233,238,.10)';
  ctx.beginPath(); ctx.moveTo(nx + 1, padT); ctx.lineTo(nx + 1, H - padB); ctx.stroke();
  ctx.fillStyle = 'rgba(230,233,238,.25)';
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('即将到来', nx + 8, H - padB - 4);
}

// 横向半音网格(纵轴标尺)：每半音淡线，C 加亮 + 标音名
function drawGrid(v) {
  const loS = Math.floor(v.lo), hiS = Math.ceil(v.hi);
  ctx.lineWidth = 1;
  for (let s = loS; s <= hiS; s++) {
    const y = yOfSemi(s, v);
    if (y < padT + 4 || y > H - padB - 4) continue;
    const pc = ((s % 12) + 12) % 12;
    const isC = pc === 0;
    ctx.strokeStyle = isC ? 'rgba(230,233,238,.18)' : HAIR_FADE;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    if (isC) {
      const oct = Math.floor(s / 12) - 1;
      ctx.fillStyle = C_LABEL;
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('C' + oct, 2, y);
    }
  }
}

// 底部时间轴：相对此刻的秒刻度(0s=此刻线)，步进自适应 WIND
function drawTimeAxis(aMs) {
  if (!(aMs >= 0)) return;
  const pxPerMs = (nowX() - padL) / WIND_MS;
  const steps = [250, 500, 1000, 2000, 5000];
  let step = 5000;
  for (const s of steps) { if (s * pxPerMs < 90) step = s; }
  ctx.fillStyle = 'rgba(230,233,238,.30)';
  ctx.font = '9px "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = aMs - (aMs % step); t >= aMs - WIND_MS; t -= step) {
    const rel = (t - aMs) / 1000;
    if (rel === 0) continue;                    // 0s 已在右端单独标
    ctx.fillText(rel.toFixed(0) + 's', xOfT(t, aMs), H - padB + 3);
  }
  ctx.textAlign = 'center';
  ctx.fillText('0s', nowX(), H - padB + 3);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
