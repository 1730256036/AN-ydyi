// ─────────────────────────────────────────────────────────────────────────────
// app/echo.mjs —— 回声模式（2026-09-13 v2 重做；2026-09-15 v3 包络谷切分）
//
// 吹一个音 → 实时从屏幕顶生成对应下落块 → 块落到键盘线那一刻由钢琴块原生逻辑
// 弹出同音高钢琴声。
//
// 实现：钢琴块 frame() 里 midiNotes 路径优先级最高(非空即走原生下落块+落键弹奏)，
// app 层在录音时把检测到的发声段合成为"未来音符"
// {t0=段起点+下落时长, t1=生长, midi} 注入 snapshot 的 midiNotes 字段——
// 钢琴块一行不改，观感与工程回放完全一致。
// 只在实时录音(recState==='rec')生效。下落时长=钢琴块 LOOKAHEAD_MS(4200ms)：
// 检测到即从屏幕顶出现，落键发声。出声依赖钢琴块"钢琴声"开关(面板联动自动开)。
//
// ── v3(2026-09-15)：包络谷切分，治"快速单吐糊成一大块" ──
// 症状：同音快吐时每个气口只有 30~60ms(被 ECHO_QUIET_MS=150 的静音容忍桥掉)、
// 音高又不变(0.7 半音切分永不触发) → 整串音糊成一块。而停止后的离线分析
// (同一条 recEnv + segmentPoints 的谷切分)却能正常切成小块——差距只在
// "实时路径没看包络"：echoFeed 收到的 d.env(细粒度包络 recEnv，5.8ms 步/11.6ms 窗)
// 一直没人用。
// 修法：与 pianoBlocks.refreshEnvCuts 同款的游标扫描(只增不减+定案尾窗)找
// "谷深≥ECHO_ENV_SPLIT_DB 的气口"，定案后在谷底把当前块切开，两半各自用
// 发声帧中位定音。时间上来得及：块要 fall(默认 4200ms)才落地，谷 ~350ms 就
// 定案；若用户把 fall 调得太短、谷定案前块已落地，切点整条弃掉(绝不切已落地的块)。
// 两侧任一半不足 ECHO_MIN_MS 也不切(不产空块/碎片)。
// 配套：ECHO_MIN_MS 100→50——切出的快吐短块普遍 40~90ms，100 会让它们
// 因不满段确认阈值根本立不了块，切了白切。真音最短≈一个检测窗(93ms)，
// 50 不会放走真音。
//
// ── 状态归属（2026-09-15「① 状态收敛」重构首域）──
// 本模块的可变状态（echoOn / echoFallMs / echoNotes / echoSeg / echoLastKey
// / echoLastAms / echoCuts / echoEnvScan / echoHist）**只导出只读 live binding**：
// ESM 的 import 绑定不可赋值，所以除本文件外谁也改写不了。app.mjs 要读就
// import，要改就调下面这几个具名函数。
// 这样每个域的可变状态只有一个受控的写入点，不需要任何 store 库——
// 主流框架真正值钱的"写入点受控"，靠 ESM 的模块边界就能拿到。
//
// 跨域依赖只有一个：录音态 recState。用 configureEcho 注入 getter，而不是
// import 录音域——避免域与域之间形成环（app.mjs 是唯一编排层，接线归它）。
// ─────────────────────────────────────────────────────────────────────────────

// —— 'hmm' 档（2026-09-19 新增，独立于 grain/classic）：序列级最优出块 ——
// 只有本档走序列级解码（dsp/notes-hmm.mjs 的在线版）；grain/classic 的分支一行未改。
// 状态独立（只有一个 hmmDec），切换档位或换片段时 echoReset 一并清空。
import { createOnlineNotes } from '../dsp/notes-hmm.mjs';

function readLS(k) { try { return globalThis.localStorage.getItem(k); } catch (e) { return null; } }
function writeLS(k, v) { try { globalThis.localStorage.setItem(k, v); } catch (e) {} }

let getRecState = () => 'idle';
/** app.mjs 启动时接线：注入录音态读取器（域间依赖显式化，不做反向 import）。 */
export function configureEcho(deps) {
  if (deps && typeof deps.getRecState === 'function') getRecState = deps.getRecState;
}

/** 回声是否开启（只读；改写走 setEchoEnabled） */
export let echoOn = readLS('ydyi_echo') === '1';
/** 下落时长 ms = 吹响到落键出声的延迟（只读；改写走 setEchoFall） */
export let echoFallMs = (() => {
  const f = parseInt(readLS('ydyi_echo_fall'), 10);
  return Number.isFinite(f) ? Math.max(300, Math.min(8000, f)) : 4200;
})();

const ECHO_MIN_MS = 50;          // 段确认阈值(v3：100→50，见文件头方案C)：发声满 50ms 才立块
const ECHO_QUIET_MS = 150;       // 静音容忍：连续静音150ms才判段结束(单帧检测抖动不拆块)
const ECHO_SPLIT_SEMI = 0.7;     // 段内音高切分阈值：偏离当前块中值≥0.7半音(同钢琴块 BOUNDARY_SEMI)
const ECHO_SPLIT_CNT = 2;        // 且同向连续≥2帧才切(同钢琴块 BOUNDARY_CNT；颤音交替方向不满足)
const ECHO_ENV_SPLIT_DB = 3;     // 包络谷深阈值(dB，同钢琴块 ENV_SPLIT_DB)：气口两侧峰/谷比
const ECHO_ENV_SETTLE_PTS = 60;  // 谷定案尾窗点数(recEnv 5.8ms 步 ≈350ms)：右侧峰被下降确认前不产切点
const ECHO_HIST_MS = 5000;       // 发声帧历史保留窗(谷切分两半各自定音用；> 定案延迟+静音容忍)

const echoSeg = { on: false, t0Ams: 0, quietMs: 0, midis: [], note: null, devCnt: 0, devDir: 0, devAms: 0 };
/** 合成音符表(音频游标 ms 域)：{t0=着陆时刻, t1, midi}（只读；由 feed 维护） */
export let echoNotes = [];
let echoLastKey;                 // 片段代际缓存：换片段清空音符表
let echoLastAms = -1;            // 上一帧音频游标(静音计时用)
let echoCuts = [];               // 已定案的包络切点(音频 ms，单调只增)
let echoEnvScan = 0;             // env 已定案扫描游标
let echoHist = [];               // 最近发声帧 [{t, m}](谷切分两半定音用)
let echoAlgo = 'grain';          // 出块算法档位('grain'|'classic'|'hmm'；snapshot 经 d.segAlgo 注入，域间不互 import)
// —— 'hmm' 档专属状态（与 grain/classic 完全隔离，只在本档分支内读写）——
const HMM_LAG_MS = 350;          // 解码滞后：末尾这段内的音符还没定，不出块（Short-time Viterbi 的等待窗）
let hmmDec = null;               // 在线解码器（惰性创建；切片段/换档时随 echoReset 清空）

export function setEchoEnabled(v) {
  echoOn = !!v;
  writeLS('ydyi_echo', echoOn ? '1' : '0');
}
export function setEchoFall(ms) {
  echoFallMs = Math.max(300, Math.min(8000, Math.round(ms) || 4200));
  writeLS('ydyi_echo_fall', String(echoFallMs));
}
function echoReset() {
  echoNotes = []; echoSeg.on = false; echoSeg.note = null;
  echoCuts = []; echoEnvScan = 0; echoHist = [];
  if (hmmDec) hmmDec.reset();       // 'hmm' 档：清在线解码缓冲（换片段必清，防跨片段串味）
}
function echoMedian(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}

// ── 包络谷切分（v3 方案A）──
// 与 pianoBlocks.refreshEnvCuts 同款：局部极小 + 两侧爬坡峰 + 谷深≥阈值 → 切点。
// 游标只增：已定案的切点不追溯增删（否则已显示的块被追溯切开 = "闪一下就消失"，
// pianoBlocks 2026-09-08 实测教训）。
function refreshEchoCuts(env) {
  if (echoAlgo === 'classic') return;                   // 经典档：不接包络(=谷切分之前的回声行为)
  if (!env || env.length < 8) return;
  const depthDb = ECHO_ENV_SPLIT_DB;
  const hi = env.length - ECHO_ENV_SETTLE_PTS;          // 定案边界(右侧峰被下降确认)
  if (hi <= echoEnvScan) return;
  for (let i = Math.max(echoEnvScan, 2); i < hi - 1; i++) {
    if (env[i].rms < env[i - 1].rms && env[i].rms <= env[i + 1].rms) {
      let pl = i - 1; while (pl > 1 && env[pl - 1].rms <= env[pl].rms) pl--;
      let pr = i + 1; while (pr < hi && env[pr + 1].rms <= env[pr].rms) pr++;
      const depth = 20 * Math.log10(Math.max(env[pl].rms, env[pr].rms) / env[i].rms);
      if (depth >= depthDb) echoCuts.push(env[i].t);
    }
  }
  echoEnvScan = hi;
  echoCuts.sort((a, b) => a - b);
}

function histMedian(t0, t1) {
  const a = [];
  for (const p of echoHist) if (p.t >= t0 && p.t < t1) a.push(p.m);
  return a.length ? Math.round(echoMedian(a)) : null;
}

// 消费定案切点：在谷底把"包含切点的未落地音符"切成两半。
// 覆盖两种情况：①切在当前开放段内(echoSeg.note)——右半继续生长；
// ②切在已收口但未落地的块里(如段尾静音 150ms 先断段、切点 350ms 后才定案)。
function applyEchoCuts(ams) {
  if (echoAlgo === 'classic') { echoCuts = []; return; }
  const fall = echoFallMs;
  while (echoCuts.length && echoCuts[0] < ams) {
    const c = echoCuts[0];
    let idx = -1;
    for (let i = echoNotes.length - 1; i >= 0; i--) {
      const n = echoNotes[i];
      if (n.t0 > ams && c >= n.t0 - fall && c < n.t1 - fall) { idx = i; break; }
    }
    if (idx < 0) { echoCuts.shift(); continue; }        // 已落地/找不到 → 弃
    const n = echoNotes[idx];
    const a0 = n.t0 - fall;
    const open = n === echoSeg.note;
    const a1 = open ? ams : n.t1 - fall;
    if (c - a0 < ECHO_MIN_MS || a1 - c < ECHO_MIN_MS) { echoCuts.shift(); continue; }
    const mL = histMedian(a0, c), mR = histMedian(c, a1 + 1);
    if (mL == null || mR == null) { echoCuts.shift(); continue; }
    const oldT1 = n.t1;
    n.t1 = c + fall;                                    // 左半收口在谷底
    n.midi = mL;
    const right = { t0: c + fall, t1: open ? c + fall + (ams - c) : oldT1, midi: mR };
    echoNotes.splice(idx + 1, 0, right);                // 右半新块(保持时间序)
    if (open) {
      echoSeg.note = right;
      echoSeg.t0Ams = c;
      echoSeg.midis = echoSeg.midis.filter(p => p.t >= c);
      echoSeg.devCnt = 0; echoSeg.devDir = 0;
    }
    echoCuts.shift();
  }
}

export function echoFeed(d) {
  if (!echoOn || getRecState() !== 'rec') { echoSeg.on = false; return; }
  if (!(d && d.live && Number.isFinite(d.audioMs) && d.audioMs >= 0)) return;
  if (d.resetKey !== echoLastKey) { echoLastKey = d.resetKey; echoReset(); }
  const ams = d.audioMs;
  const algo = (d.segAlgo === 'classic' || d.segAlgo === 'grain' || d.segAlgo === 'hmm') ? d.segAlgo : 'grain';
  if (algo !== echoAlgo) { echoAlgo = algo; hmmDec = null; }   // 换档：清 'hmm' 档状态
  // —— 'hmm' 档：整段独立分支（序列级解码），不进入下面 grain/classic 的任何逻辑 ——
  if (echoAlgo === 'hmm') { echoHmmFeed(d, ams); echoLastAms = ams; return; }
  refreshEchoCuts(d.env);
  applyEchoCuts(ams);
  if (d.voiced && Number.isFinite(d.midi)) {
    echoHist.push({ t: ams, m: d.midi });
    while (echoHist.length && echoHist[0].t < ams - ECHO_HIST_MS) echoHist.shift();
    if (!echoSeg.on) {
      echoSeg.on = true;
      echoSeg.t0Ams = ams; echoSeg.quietMs = 0;
      echoSeg.midis = []; echoSeg.note = null;
      echoSeg.devCnt = 0; echoSeg.devDir = 0; echoSeg.devAms = 0;
    }
    echoSeg.quietMs = 0;
    echoSeg.midis.push({ t: ams, m: d.midi });

    // —— 段内音高变化切分(流式版，口径对齐钢琴块 BOUNDARY_SEMI/CNT) ——
    // 连吹/快吹不同音时若没有≥150ms的气口，原本会并成一个长块(只出一个键)。
    // 这里：同向偏离当前块中值≥0.7半音且连续≥2帧 → 当前块在首个偏离帧收口，
    // 新起一块。这样每个音各自成块，空中可同时存在多个下落块。
    // (颤音是方向交替，不满足"同向连续"，不会误切——与钢琴块颤音折叠同哲学。)
    if (echoSeg.note) {
      const diff = d.midi - echoSeg.note.midi;
      const dir = diff >= ECHO_SPLIT_SEMI ? 1 : (diff <= -ECHO_SPLIT_SEMI ? -1 : 0);
      if (dir !== 0 && dir === echoSeg.devDir) echoSeg.devCnt++;
      else if (dir !== 0) { echoSeg.devDir = dir; echoSeg.devCnt = 1; echoSeg.devAms = ams; }
      else { echoSeg.devCnt = 0; echoSeg.devDir = 0; }
      if (echoSeg.devCnt >= ECHO_SPLIT_CNT) {
        // 收口当前块：t1 到首个偏离帧；midi 取本块自己的帧(去掉偏离帧)的中位数
        echoSeg.note.t1 = echoSeg.note.t0 + (echoSeg.devAms - echoSeg.t0Ams);
        const keep = Math.max(1, echoSeg.midis.length - echoSeg.devCnt);
        echoSeg.note.midi = Math.round(echoMedian(echoSeg.midis.slice(0, keep).map(p => p.m)));
        // 新段从首个偏离帧起(换音的瞬间就是新块的段起点)
        echoSeg.t0Ams = echoSeg.devAms;
        echoSeg.midis = [{ t: ams, m: d.midi }];
        echoSeg.note = null;
        echoSeg.devCnt = 0; echoSeg.devDir = 0;
      }
    }

    if (!echoSeg.note && (ams - echoSeg.t0Ams) >= ECHO_MIN_MS) {
      // 段确认后才立块(着陆=段起点+FALL → 检测到即从屏幕顶出现)。
      // v2 的"先立块、碎段再撤"是闪现即消失的根因：碎段现在根本不立块，无痕。
      echoSeg.note = { t0: echoSeg.t0Ams + echoFallMs, t1: echoSeg.t0Ams + echoFallMs + (ams - echoSeg.t0Ams), midi: Math.round(d.midi) };
      echoNotes.push(echoSeg.note);
      if (echoNotes.length > 600) echoNotes.splice(0, echoNotes.length - 600);   // 已落地的老块滚出
    }
    if (echoSeg.note) {
      echoSeg.note.t1 = echoSeg.note.t0 + (ams - echoSeg.t0Ams);   // 还在吹：块顶持续生长(满列下落)
      const recent = echoSeg.midis.length > 30 ? echoSeg.midis.slice(-30) : echoSeg.midis;
      echoSeg.note.midi = Math.round(echoMedian(recent.map(p => p.m)));     // 近30帧中位定音(着陆前完成，块色稳)
    }
  } else if (echoSeg.on) {
    // 静音容忍：不足 ECHO_QUIET_MS 的掉帧桥过去(块不拆)；超时才判段结束。
    // 立过的块【绝不撤】——它必然 ≥ECHO_MIN_MS 且未着陆，会落到键盘线出声。
    echoSeg.quietMs += Math.max(0, ams - echoLastAms);
    if (echoSeg.quietMs >= ECHO_QUIET_MS) {
      echoSeg.on = false;
      if (echoSeg.note) {
        echoSeg.note.midi = Math.round(echoMedian(echoSeg.midis.map(p => p.m)));   // 终定音
        echoSeg.note = null;
      }
    }
  }
  echoLastAms = ams;
}

// ══════════════════════════════════════════════════════════════════════
// —— 'hmm' 档（2026-09-19 新增）：序列级最优出块 ——
// 与 grain/classic **完全独立**：整段逻辑都在这里，另两档在 echoFeed 一进来
// 就被上面的 return 挡住了，互不影响。要彻底移除本档 = 删本函数 + echoFeed 里
// 那两行 + 顶部 import + 三个状态量 + 白名单里的 'hmm'（grain/classic 全程无感）。
//
// 与另两档的行为差异（必须知道）：
//   · 块的出现时机 = 音符「已定」之后（结束时刻距当前 ≥HMM_LAG_MS，且连续三次解码
//     结果一致）→ 比 grain/classic 晚约 HMM_LAG_MS(350ms) 上屏。换来的是块**绝不会被
//     改写或消失**（本项目 v2 的老病），且块序严格单调不重叠。
//   · 落键时刻不看这个延迟：落键 = t0 + fall，仍与原音时刻对齐 → 对听到的声音无影响。
//   · 本档不做"生长块"（边吹边长）：生长块要把正在吹的音先推入、之后再回填收口，
//     与"已输出绝不改写"互相拉扯，实测会产出同一时刻的重复块与时间倒序
//     （1378/1745/1495/1612）。宁可用固定延迟换结构稳定。
// ══════════════════════════════════════════════════════════════════════
function echoHmmFeed(d, ams) {
  // ⚠ 帧戳 = 检测窗**末尾**（4096 @44.1k ≈ 93ms），而该帧代表的音频中心在窗内中点
  //   → 气口证据要按 t−46 对齐；不校正会整体错位半窗、落到相邻帧上，
  //   于是"该切开的音"拿不到证据（真机上表现为快吐切不开）。
  const FRAME_LAG_MS = 46;
  if (!hmmDec) hmmDec = createOnlineNotes({ lagMs: HMM_LAG_MS, frameLagMs: FRAME_LAG_MS });
  // ⚠ 必须把 **env** 一起喂进去：气口信息只活在细粒度包络里（帧级 rms 被 93ms 检测窗
  //   平均抹平——真机逐帧 dump 实证：单吐三个整段的 600ms 发声帧里，气口既无 voiced
  //   翻转、也无能量下降、音高也不变）。不带 env 会退回 voiced 二值 → 40ms 气口被
  //   静音容忍桥接 → 快吐糊成一块。
  const r = hmmDec.push({ t: ams, midi: d.midi, voiced: !!d.voiced, str: d.str, env: d.env });
  const fall = echoFallMs;

  // 只落地「已定」音符：块一旦推入就绝不再被改写。
  // ⚠ 为什么不做"生长块"（把正在吹的音先推入、之后再回填收口）：它与"已输出的块绝不
  //   被改写"互相拉扯——回填要么漏配、要么把块挪到别处，实测出现同一时刻的重复块与
  //   时间倒序（块序列 1378/1745/1495/1612）。宁可用固定延迟换"块结构绝对稳定"。
  //   代价：完整块比 grain/classic 晚约 HMM_LAG_MS(350ms) 上屏；但**落键时刻不看这个**
  //   （落键 = t0 + fall，仍与原音时刻对齐）→ 对听到的声音没有影响，只是块晚一点出现。
  for (const n of r.settled) {
    const t0 = n.t0 + fall, t1 = n.t1 + fall;
    const last = echoNotes.length ? echoNotes[echoNotes.length - 1] : null;
    if (last && t0 < last.t1) continue;      // 防重叠：重叠块在钢琴块里 = 同一时刻两个键
    echoNotes.push({ t0, t1, midi: n.midi });
  }

  if (echoNotes.length > 600) echoNotes.splice(0, echoNotes.length - 600);
}
