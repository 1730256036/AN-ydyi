// ============================================================
// test/notes-hmm.mjs —— dsp/notes-hmm.mjs 守卫
//
// 每个用例对上一个「文献公认的歧义」或一条工程护栏：
//   1  平稳多音 + 短气口        → 音符数正确、音高正确
//   2  强颤音跨格              → 不碎成两个音（对比逐帧量化会碎）
//   3  整段偏低 40 音分         → estimateShift 对齐参照系（对比：不开则整体低一个半音）
//   4  短离群帧被吸收 / 长离群跟随 → 展示能力与诚实边界
//   5  短气口桥接 / 长静音断开   → 静音容忍是参数连续权衡，不是硬阈值
//   6  尾音衰减（可信度下降）    → 不额外切（v10 需专门加"能量上升门"，此处天然不需要）
//   7  边界：空/单帧/全静音      → 不崩、不产音符
//   8  接口契约：t0<t1、整数 midi、与 echoNotes 同构
//
// ⚠ 合成素材必须含真实成分（帧级抖动 + 气口 + 可信度差异）——理想无噪素材会
//   替你决定你能看见什么（本项目血的教训）。但即便如此，**单测只证明逻辑自洽，
//   不代表真机效果**；真实录音对照需另做离线探针。
// ============================================================
import { decodeNotes, naiveQuantize, estimateTuningShift, envGatePoints, annotateGates, HMM_DEFAULTS } from '../dsp/notes-hmm.mjs';

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`✗ ${name}  期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(got)}`); }
  else console.log(`✓ ${name}`);
}
function ok(name, cond, detail) {
  if (!cond) { fails++; console.log(`✗ ${name}${detail !== undefined ? '  ' + detail : ''}`); }
  else console.log(`✓ ${name}`);
}

const FRAME_MS = 16.7;
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
// plan 项：{ midi, ms } | { rest: true, ms }
//   可选 vibrato(半音) / vibPeriod(帧) / glideTo(终点) / drift(线性漂移到 midi+drift)
//   tail: true → 末 4 帧按"尾音"处理（可信度降、抖动增），模拟真实衰减尾巴
function build(plan, { jitter = 0.12, seed = 7 } = {}) {
  const r = rng(seed);
  const frames = [];
  let i = 0;
  const push = (midi, voiced, str) => {
    frames.push({ t: +(i * FRAME_MS).toFixed(2), midi, voiced, str });
    i++;
  };
  for (const seg of plan) {
    const n = Math.max(1, Math.round(seg.ms / FRAME_MS));
    if (seg.rest) { for (let k = 0; k < n; k++) push(NaN, false, 0.9); continue; }
    for (let k = 0; k < n; k++) {
      let m = seg.midi;
      if (seg.vibrato) m += seg.vibrato * Math.sin((2 * Math.PI * k) / (seg.vibPeriod || 8));
      if (seg.glideTo != null) m += (seg.glideTo - seg.midi) * (k / n);
      if (seg.drift) m += seg.drift * (k / n);
      const isTail = seg.tail && k >= n - 4;
      const j = isTail ? jitter * 3 : jitter;
      push(m + (r() - 0.5) * 2 * j, true, isTail ? 0.28 : 0.02);
    }
  }
  return frames;
}
const midis = (notes) => notes.map((n) => n.midi);

// ─────────── 1. 平稳三音 + 两个短气口 ───────────
{
  const f = build([
    { midi: 69, ms: 220 }, { rest: true, ms: 40 },
    { midi: 72, ms: 220 }, { rest: true, ms: 40 },
    { midi: 74, ms: 220 },
  ]);
  const r = decodeNotes(f);
  eq('三音 + 短气口 → 3 个音符', r.notes.length, 3);
  eq('三音音高正确', midis(r.notes), [69, 72, 74]);
  ok('音符时长均 ≥80ms', r.notes.every((n) => n.t1 - n.t0 >= 80),
    JSON.stringify(r.notes.map((n) => Math.round(n.t1 - n.t0))));
}

// ─────────── 2. 强颤音跨格：不碎成两个交替音 ───────────
{
  const f = build([{ midi: 69.5, ms: 600, vibrato: 0.6, vibPeriod: 8 }]);
  const r = decodeNotes(f);
  eq('强颤音(±0.6 半音跨格) → 1 个音符', r.notes.length, 1);
  ok('颤音音高落在 69/70 之一', [69, 70].includes(r.notes[0].midi), String(r.notes[0].midi));
  const nv = naiveQuantize(f, { minNoteMs: 0 });
  ok('对照：逐帧量化在同一素材上碎成多块', nv.length >= 6, `naive=${nv.length} 块`);
}

// ─────────── 3. 整段偏低 0.45 半音：格线对齐参照系 ───────────
{
  const f = build([{ midi: 68.55, ms: 400 }]);     // 真音 69，整段吹低了 0.45 半音
  const d = estimateTuningShift(f);
  ok('估出的偏移 δ ≈ −0.45 半音', Math.abs(d + 0.45) < 0.08, `δ=${d.toFixed(3)}`);
  const on = decodeNotes(f, { estimateShift: true });
  eq('开 estimateShift → 1 个音符且落在 69', midis(on.notes), [69]);
  const off = decodeNotes(f);
  eq('不开 estimateShift → 仍是 1 个音符（保持代价抗住贴边界抖动）', off.notes.length, 1);
  const nv = naiveQuantize(f, { minNoteMs: 0 });
  ok('对照：逐帧量化在此素材上块数更多（贴边界翻面）', nv.length >= 2, `naive=${nv.length} 块`);
}

// ─────────── 4. 离群帧：短的吸收、长的跟随（诚实边界） ───────────
{
  const short = build([
    { midi: 69, ms: 300 }, { midi: 81, ms: 33 }, { midi: 69, ms: 300 },
  ]);                                              // 2 帧纯八度离群
  const rs = decodeNotes(short);
  eq('2 帧八度离群被吸收 → 1 个音符', midis(rs.notes), [69]);

  const long = build([
    { midi: 69, ms: 300 }, { midi: 81, ms: 200 }, { midi: 69, ms: 300 },
  ]);                                              // 12 帧持续八度
  const rl = decodeNotes(long);
  eq('12 帧持续八度 → 跟随成 3 个音符（不假装能修好）', midis(rl.notes), [69, 81, 69]);
}

// ─────────── 5. 静音容忍是参数权衡，不是硬阈值 ───────────
{
  const same = (gapMs) => build([
    { midi: 69, ms: 250 }, { rest: true, ms: gapMs }, { midi: 69, ms: 250 },
  ]);
  eq('同音 + 40ms 短气口 → 桥接为 1 个音符', decodeNotes(same(40)).notes.length, 1);
  eq('同音 + 400ms 长静音 → 断开为 2 个音符', decodeNotes(same(400)).notes.length, 2);
  // 容忍长度 ≈ 2·lambda/silenceCost（默认 8 帧 ≈ 134ms）：调大 lambda 应更能容忍
  const tight = decodeNotes(same(200), { lambda: 2.0 });
  const loose = decodeNotes(same(200), { lambda: 8.0 });
  ok('气口容忍随 lambda 单调变化（200ms: 小λ断开 / 大λ桥接）',
    tight.notes.length === 2 && loose.notes.length === 1,
    `λ=2→${tight.notes.length}块, λ=8→${loose.notes.length}块`);
}

// ─────────── 6. 尾音衰减：不额外切 ───────────
{
  const f = build([{ midi: 69, ms: 400, tail: true }]);   // 末 4 帧可信度降、抖动增
  const r = decodeNotes(f);
  eq('尾音衰减（可信度下降）→ 仍 1 个音符', r.notes.length, 1);
}

// ─────────── 7. 边界不崩 ───────────
{
  eq('空数组 → 空音符', decodeNotes([]).notes.length, 0);
  eq('null 不崩', decodeNotes(null).notes.length, 0);
  eq('全静音 → 空音符', decodeNotes(build([{ rest: true, ms: 300 }])).notes.length, 0);
  const one = decodeNotes([{ t: 0, midi: 69, voiced: true }]);
  ok('单帧不崩（可为 0 块，因 <minNoteMs）', Array.isArray(one.notes), JSON.stringify(one.notes));
  eq('未发声帧 midi=NaN 不崩', decodeNotes(build([{ midi: 69, ms: 200 }, { rest: true, ms: 100 }])).notes.length, 1);
}

// ─────────── 8. 接口契约 ───────────
{
  const f = build([{ midi: 69, ms: 300 }, { rest: true, ms: 120 }, { midi: 71, ms: 300 }]);
  const r = decodeNotes(f);
  ok('每个音符含 t0/t1/midi 三字段',
    r.notes.every((n) => Number.isFinite(n.t0) && Number.isFinite(n.t1) && Number.isInteger(n.midi)),
    JSON.stringify(r.notes));
  ok('t1 > t0 且音符按时间有序',
    r.notes.every((n, i) => n.t1 > n.t0 && (i === 0 || n.t0 >= r.notes[i - 1].t0)),
    JSON.stringify(r.notes));
  ok('midi 落在 0..127', r.notes.every((n) => n.midi >= 0 && n.midi <= 127));
  ok('返回结构含 shift/cands/rawCount', 'shift' in r && Array.isArray(r.cands) && 'rawCount' in r);
  ok('默认参数齐备', Object.keys(HMM_DEFAULTS).length >= 6);
}

// ─────────── 10. 快吐多音：气口维度（同音快吐只能靠气口区分） ───────────
// ⚠ 气口证据**只能来自 env**（细粒度包络）：帧级 rms 在 93ms 检测窗里被抹平
//   （真实录音逐帧 dump 实证：单吐三个整段 600ms 的发声帧里，气口既无 voiced 翻转、
//   也无能量下降、音高也不变）。所以本组的"气口"必须造在 env 上，
//   且与真机同格式：5.8ms 步、谷底塌到本底附近（≈28dB 深）。
{
  const FR2 = 16.7;
  const mk = (seq, noteMs, gapMs) => {
    const frames = [], segs = [];
    let t = 0;
    for (const m of seq) {
      const n = Math.round(noteMs / FR2), t0 = t;
      for (let k = 0; k < n; k++) { frames.push({ t: +t.toFixed(2), midi: m, voiced: true, str: 0.02 }); t = +(t + FR2).toFixed(2); }
      segs.push([t0 + 2, t - 2]);                       // 发声区段（收窄 2ms 让谷更陡）
      const g = Math.max(1, Math.round(gapMs / FR2));
      for (let k = 0; k < g; k++) { frames.push({ t: +t.toFixed(2), midi: NaN, voiced: false, str: 0.9 }); t = +(t + FR2).toFixed(2); }
    }
    const env = [];                                     // 5.8ms 网格：发声 0.30 / 气口 0.012
    for (let e = 0; e <= t + 300; e += 5.8) {
      env.push({ t: Math.round(e), rms: segs.some(([a, b]) => e >= a && e <= b) ? 0.30 : 0.012 });
    }
    return { frames, env };
  };
  const withEnv = (o) => decodeNotes(annotateGates(o.frames.map((f) => ({ ...f })), o.env));
  const eight = [69, 69, 69, 69, 69, 69, 69, 69];
  const r = withEnv(mk(eight, 100, 40));
  eq('同音快吐 100ms×8（env 气口）→ 8 个块', r.notes.length, 8);
  ok('前 7 块时长≈100ms', r.notes.slice(0, 7).every((n) => Math.abs((n.t1 - n.t0) - 100) <= 30),
    JSON.stringify(r.notes.map((n) => Math.round(n.t1 - n.t0))));
  const d = withEnv(mk([69, 71, 72, 74, 76, 74, 72, 69], 100, 40));
  eq('换音快吐 → 8 个块且音高正确', midis(d.notes), [69, 71, 72, 74, 76, 74, 72, 69]);
  const r2 = withEnv(mk(eight, 80, 30));
  eq('更极端 80ms+30ms 气口 → 仍 8 个块', r2.notes.length, 8);
  // 不给 env → 退回 voiced 二值：气口被静音容忍桥接 → 糊成 1 块（证明 env 是必需的那一维）
  const noEnv = decodeNotes(mk(eight, 100, 40).frames.map((f) => ({ ...f })));
  eq('无 env → 退回二值（气口被桥接成 1 块）', noEnv.notes.length, 1);
}

// ─────────── 11. 静音期噪声误报不得出假块（真机实测："明明啥声音都没有"）───────────
{
  const FR3 = 16.7;
  // 模拟：没吹任何音，但检测器偶尔把环境噪声判成 voiced（str 高 = 不可信）
  const noise = Array.from({ length: 120 }, (_, i) => {
    const bad = i % 7 < 3;
    return {
      t: +(i * FR3).toFixed(2), midi: bad ? 60 + (i % 5) : NaN, voiced: bad,
      str: bad ? 0.85 : 0.95, rms: bad ? 0.09 : 0.06,
    };
  });
  eq('纯噪声误报 → 0 块（不可信帧不得出块）', decodeNotes(noise).notes.length, 0);
  // ⚠ 真音帧必须接在噪声**时间轴之后**（t 单调是模块契约；从 1002ms 起写的话，
  //   数组里 t 非单调 → 音符 t0 取到噪声末尾、t1 反更早 → 时长负 → 被最短时长滤掉）
  const noteT0 = 120 * FR3;
  const thenNote = noise.concat(Array.from({ length: 24 }, (_, k) => ({
    t: +(noteT0 + k * FR3).toFixed(2), midi: 69, voiced: true, str: 0.02, rms: 0.30,
  })));
  const r = decodeNotes(thenNote);
  eq('噪声后接真音 → 只出 1 块', r.notes.length, 1);
  eq('真音音高正确', midis(r.notes), [69]);
  ok('真音起点不被噪声吸走（落在噪声结束处 ≈2004ms）',
    Math.abs(r.notes[0].t0 - noteT0) < 40, String(Math.round(r.notes[0].t0)));
}

// ─────────── 12. 气口画像 envGatePoints：显著度口径（回归守卫） ───────────
// 守的是"项目里包络谷切分从未真正生效"这个根因：谷底有 ±1~2dB 逐点抖动时，
// 「相邻爬坡峰」口径会退化成拿相邻点当峰（深度恒 ~0.5dB）→ 真值 30dB 的气口被漏掉。
{
  let seed = 5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
  // 12a. 真实形态：平地 0.30（±1dB 抖动）+ 60ms 气口塌到 0.01
  const env = [];
  for (let t = 0; t <= 1200; t += 5.8) {
    const inGate = t >= 500 && t <= 560;
    env.push({ t: Math.round(t), rms: (inGate ? 0.01 : 0.30) * (1 + rnd() * 0.2) });
  }
  const pts = envGatePoints(env);
  const inG = pts.filter((p) => p.t >= 480 && p.t <= 580);
  ok('气口被识别（≥3 个点，覆盖谷宽而非单点）', inG.length >= 3, `点数=${inG.length}`);
  ok('气口强度 q 达满值（谷深≈30dB）', inG.some((p) => p.q >= 0.99), JSON.stringify(inG.slice(0, 3)));
  ok('平稳段不产气口点', pts.every((p) => p.t >= 480 && p.t <= 580), JSON.stringify(pts.map((p) => p.t)));

  // 12b. 慢速强弱起伏（2s 三角谷、相对本底仅 6dB）不该被当成气口
  const slow = [];
  for (let t = 0; t <= 2000; t += 5.8) {
    const d = Math.max(0, 1 - Math.abs(t - 1000) / 1000);
    slow.push({ t: Math.round(t), rms: 0.30 * (0.5 + 0.5 * d) });
  }
  eq('慢速起伏不产气口点', envGatePoints(slow).length, 0);

  // 12c. 定案窗：发生在末尾 gateSettleMs 之内的气口不定案（右侧峰未被下降确认）
  const tailGate = [];
  for (let t = 0; t <= 1000; t += 5.8) tailGate.push({ t: Math.round(t), rms: t >= 850 ? 0.01 : 0.30 });
  ok('末尾 150ms 的气口不定案', envGatePoints(tailGate).every((p) => p.t < 800),
    JSON.stringify(envGatePoints(tailGate).map((p) => p.t)));

  // 12d. annotateGates：时间容差 + frameLagMs 偏移（真机帧戳=窗末尾 → 传 46）
  const fr = [];
  for (let t = 0; t <= 1200; t += 16.7) fr.push({ t: +t.toFixed(1), midi: 69, voiced: true });
  const g0 = annotateGates(fr.map((f) => ({ ...f })), env, { frameLagMs: 0 });
  ok('frameLag=0：气口落在 500~580 的帧上', g0.some((f) => f.t >= 500 && f.t <= 580 && f.gate > 0.9));
  const g46 = annotateGates(fr.map((f) => ({ ...f })), env, { frameLagMs: 46 });
  ok('frameLag=46：同一气口落到 +46ms 的帧上', g46.some((f) => f.t >= 540 && f.t <= 620 && f.gate > 0.9));
  ok('无 env → 全部 gate=0（不启用气口维度）',
    annotateGates(fr.map((f) => ({ ...f })), null).every((f) => !f.gate));
  ok('重复推入的 env（真机 recEnv 是重叠窗累积）不影响结果',
    JSON.stringify(envGatePoints(env.concat(env.map((p) => ({ ...p })))).map((p) => Math.round(p.t)))
    === JSON.stringify(envGatePoints(env).map((p) => Math.round(p.t))));
}

// ─────────── 13. 帧率无关性（真机 recordRecFrame 有 30ms 节流 ≈ 33ms 帧步） ───────────
// 曾因逐帧代价不按帧长归一化：同一个 40ms 气口在 33ms 帧步下只拿到一半证据，
// 同一素材块数 33→11、80→34、51→23（阈值型判决在阈值附近整片翻面）。
{
  const mkD = (stepMs) => {
    const frames = [], segs = [];
    let t = 0;
    for (let s = 0; s < 8; s++) {
      const t0 = t;
      for (let k = 0; k < Math.round(100 / stepMs); k++) { frames.push({ t: +t.toFixed(2), midi: 69, voiced: true, str: 0.02 }); t += stepMs; }
      segs.push([t0 + 2, t - 2]);
      for (let k = 0; k < Math.max(1, Math.round(40 / stepMs)); k++) { frames.push({ t: +t.toFixed(2), midi: NaN, voiced: false, str: 0.9 }); t += stepMs; }
    }
    const env = [];
    for (let e = 0; e <= t + 400; e += 5.8) env.push({ t: Math.round(e), rms: segs.some(([a, b]) => e >= a && e <= b) ? 0.30 : 0.012 });
    return { frames, env };
  };
  const A = mkD(16.7), B = mkD(33.4);
  const ra = decodeNotes(annotateGates(A.frames, A.env));
  const rb = decodeNotes(annotateGates(B.frames, B.env));
  eq('帧率无关：16.7ms 帧步 → 8 块', ra.notes.length, 8);
  eq('帧率无关：33.4ms 帧步（真机节流）→ 同样 8 块', rb.notes.length, 8);
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
