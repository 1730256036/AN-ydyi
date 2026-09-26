// ============================================================
// test/project-archive.mjs —— 存档（.ydyi / IndexedDB 记录）守卫
// 2026-09-14 加「我的存档」重做 + MIDI 归档时固化。
//
// 为什么要有这个测试：存档的失败模式全是"静默丢数据"——
//   ① MIDI 工程的音符表在 projectSave 里漏存 → 打开存档是一张空谱，不报错；
//   ② kind 推断错了 → 列表分成"导入音频"组，用户找不到自己刚存的 MIDI；
//   ③ .ydyi 导出丢了 midiNotes → 拷到别的电脑打开是空的。
//   ④ source 字段丢了 → 分类退化成"按名字猜"，录音被错标成导入音频
//      （2026-09-14 的真实案例：点「存当前」自己起名就认不出是录音了）。
// 这四件事都不会抛异常，只有跑一遍对比字段才发现。这里全部覆盖。
//
// 只测纯函数（序列化/解析/推断），不碰 IndexedDB —— node 里没有 indexedDB，
// 且 projectSave/List 只是字段搬运，真正的映射逻辑在 inferKind/projectToFile 里。
// ============================================================
import { readFileSync } from 'node:fs';
import { projectToFile, parseProjectFile, inferKind, inferSource, originLabel,
  KIND_AUDIO, KIND_MIDI,
  SOURCE_REC, SOURCE_IMPORT, SOURCE_MIDI } from '../proj/project.mjs';

let fails = 0;
const ck = (name, cond, extra = '') => {
  if (cond) console.log('  ok  ' + name + extra);
  else { fails++; console.error('  FAIL ' + name + extra); }
};

console.log('[project-archive] 存档序列化 / 类型推断守卫');

// ---------- 1. kind 推断：老存档必须能读（没有 kind 字段） ----------
console.log('\n-- 类型推断（含向后兼容）--');
ck('有音符表 → midi', inferKind({ midiNotes: [{ midi: 60, t0: 0, t1: 100 }] }) === KIND_MIDI);
ck('有音频 blob → audio', inferKind({ audioBlob: {} }) === KIND_AUDIO);
ck('只有分析帧(纯曲线) → audio', inferKind({ analysis: { frames: [{}] } }) === KIND_AUDIO);
ck('空对象 → audio(兜底不抛)', inferKind({}) === KIND_AUDIO);
ck('null → audio(兜底不抛)', inferKind(null) === KIND_AUDIO);
ck('显式 kind=midi 优先于内容', inferKind({ kind: KIND_MIDI }) === KIND_MIDI);
ck('显式 kind=audio 且无音符', inferKind({ kind: KIND_AUDIO, audioName: 'x.wav' }) === KIND_AUDIO);
// 老存档没有 kind：完全靠内容推。这条是最容易回归的（改了字段名就错分组）
ck('老存档(无 kind)有 midiNotes → midi', inferKind({ midiNotes: [{}] }) === KIND_MIDI);
ck('空 midiNotes 数组不算 midi', inferKind({ midiNotes: [] }) === KIND_AUDIO);

// ---------- 2. 来源标签：分类 tab 用 ----------
// 不能靠**名字**猜来源：只有自动命名的
// "录音 HH:MM:SS" 能认出来；用户点「存当前」自己起名 → 一律掉进兜底分支
// 变成"导入音频"，录音被错标。现改为**落库时写死 source**，这里固化该口径。
console.log('\n-- 来源标签 --');
ck('录音名(无 source，老存档兜底) → 录音', originLabel({ name: '录音 21:33:07' }) === '录音');
ck('MIDI 工程 → MIDI', originLabel({ midiNotes: [{}], name: '土耳其进行曲' }) === 'MIDI');
ck('有 audioName 无录音前缀 → 导入音频', originLabel({ name: 'my_song', audioName: 'my_song.mp3' }) === '导入音频');
// 不设「纯曲线」这一档：没有音频的音频工程对用户没有意义，
// 它现在归入「导入音频」而不是单列一栏。
ck('无音频无音符 → 导入音频(不再有"纯曲线")',
  originLabel({ name: '某工程', analysis: { frames: [] } }) === '导入音频');

// ---------- 2b. source 字段：真实来源必须压过名字猜测 ----------
console.log('\n-- source 字段（落库写死的真实来源）--');
// 核心场景：录音被用户改名成任意名字，只要 source 还在，就必须仍归为"录音"。
// 这正是 2026-09-14 那个 bug 的回归守卫。
ck('source=rec 但名字是任意串 → 仍判录音',
  inferSource({ source: SOURCE_REC, name: '我自己起的名字' }) === SOURCE_REC);
ck('source=rec 的名字规则失效也救回来',
  originLabel({ source: SOURCE_REC, name: 'asdf' }) === '录音');
ck('source=import 名字却像录音 → 仍判导入音频',
  inferSource({ source: SOURCE_IMPORT, name: '录音 10:00:00' }) === SOURCE_IMPORT);
ck('source=midi 无音符表也判 midi', inferSource({ source: SOURCE_MIDI }) === SOURCE_MIDI);
// 没有 source 的老存档：按内容/名字兜底，不能抛
ck('老存档无 source 有音符 → midi', inferSource({ midiNotes: [{}] }) === SOURCE_MIDI);
ck('老存档无 source 录音名 → rec', inferSource({ name: '录音 09:00:00' }) === SOURCE_REC);
ck('老存档无 source 其他 → import', inferSource({ name: '随便' }) === SOURCE_IMPORT);
ck('空对象 → import(兜底不抛)', inferSource({}) === SOURCE_IMPORT);
ck('null → import(兜底不抛)', inferSource(null) === SOURCE_IMPORT);
ck('非法 source 值被忽略 → 走兜底', inferSource({ source: 'bogus', midiNotes: [{}] }) === SOURCE_MIDI);

// ---------- 3. MIDI 存档 roundtrip：音符表必须活着回来 ----------
console.log('\n-- .ydyi roundtrip：MIDI 工程 --');
const midiNotes = [
  { midi: 60, t0: 0, t1: 500, vel: 0.8 },
  { midi: 64, t0: 500, t1: 900, vel: 0.6 },
  { midi: 67, t0: 900, t1: 1400, vel: 0.9 },
];
const midiProj = { id: 'm1', name: 'MIDI 测试曲 · 钢琴块', createdAt: 1700000000000,
  midiNotes, duration: 2.6, audioName: '', audioBlob: null, analysis: null };
{
  const text = await projectToFile(midiProj, { includeAudio: false });
  const o = JSON.parse(text);
  ck('导出 JSON 带 kind=midi', o.kind === KIND_MIDI, ' → ' + o.kind);
  ck('导出 JSON 带 midiNotes', Array.isArray(o.midiNotes) && o.midiNotes.length === 3);
  ck('音符字段完整(midi/t0/t1/vel)', o.midiNotes.every((n) =>
    typeof n.midi === 'number' && typeof n.t0 === 'number' && typeof n.t1 === 'number' && typeof n.vel === 'number'));
  const { proj: back, includeAudio } = parseProjectFile(text);
  ck('解析回来 kind=midi', inferKind(back) === KIND_MIDI);
  ck('解析回来音符数一致', (back.midiNotes || []).length === 3);
  ck('解析回来音符内容一致', JSON.stringify(back.midiNotes) === JSON.stringify(midiNotes));
  ck('纯 MIDI 不带音频', includeAudio === false && !back.audioBlob);
}

// ---------- 4. 音频工程 roundtrip（无音频导出，纯曲线） ----------
console.log('\n-- .ydyi roundtrip：音频工程(纯曲线导出) --');
const frames = [{ t: 0, freq: 440, voiced: true, prom: 0.9, purity: 0.9, rms: 0.1, str: 0.1 }];
const audioProj = { id: 'a1', name: '录音 10:00:00', createdAt: 1700000000001,
  analysis: { sr: 44100, windowSize: 4096, hopMs: 23, frames, stats: { minHz: 220, maxHz: 880 } },
  duration: 3.5, audioName: '录音 10:00:00', audioBlob: null };
{
  const text = await projectToFile(audioProj, { includeAudio: false });
  const o = JSON.parse(text);
  ck('导出 JSON kind=audio', o.kind === KIND_AUDIO);
  ck('导出 JSON 无 midiNotes(null)', o.midiNotes === null);
  const { proj: back } = parseProjectFile(text);
  ck('解析回来帧数一致', back.analysis.frames.length === 1);
  ck('解析回来 stats 一致', back.analysis.stats.minHz === 220 && back.analysis.stats.maxHz === 880);
  ck('分析缺失时不塞假帧(用 null)', parseProjectFile(JSON.stringify({
    magic: 'ydyi-project', version: 1, id: 'x', name: 'x' })).proj.analysis === null);
}

// ---------- 5. AI 转谱：音频工程同时挂音符表，导出不能丢音符 ----------
console.log('\n-- 音频工程 + AI 转谱音符（两者并存）--');
{
  const both = { id: 'b1', name: '转谱结果', createdAt: 1, duration: 5,
    analysis: { sr: 44100, windowSize: 4096, hopMs: 23, frames, stats: { minHz: 100, maxHz: 200 } },
    midiNotes, audioBlob: null };
  const o = JSON.parse(await projectToFile(both, { includeAudio: false }));
  ck('两者并存时仍带音符表', Array.isArray(o.midiNotes) && o.midiNotes.length === 3);
  ck('两者并存时仍带分析帧', o.analysis && o.analysis.frames.length === 1);
  // 有音符表 → 归 midi 组（钢琴块能弹，比看曲线更该被发现）
  ck('两者并存归 midi 组', inferKind(both) === KIND_MIDI);
}

// ---------- 6. env（细粒度包络）必须跟着走 ----------
// projectSave/projectToFile 必须带上 env，否则
// 打开存档后钢琴块分段比"刚录完"粗一档（气口线索丢了），且不报任何错。
console.log('\n-- 细粒度包络 env 持久化 --');
{
  const env = { hopMs: 11.6, rms: [0.01, 0.5, 0.02, 0.6, 0.01] };
  const withEnv = { id: 'v1', name: '带包络', createdAt: 1, duration: 2,
    analysis: { sr: 44100, frames: frames, stats: { minHz: 100, maxHz: 200 } }, env };
  const o = JSON.parse(await projectToFile(withEnv, { includeAudio: false }));
  ck('导出 JSON 带 env', !!o.env && Array.isArray(o.env.rms) && o.env.rms.length === 5);
  const { proj: back } = parseProjectFile(JSON.stringify(o));
  ck('解析回来 env 一致', JSON.stringify(back.env) === JSON.stringify(env));
  // 没有 env 的旧存档：必须给 null 而不是 undefined（undefined 会被 JSON 丢掉，
  // 但内存里 undefined 会让 `curProject.env` 判定成 falsy 的分支不一样）
  const { proj: noEnv } = parseProjectFile(JSON.stringify({
    magic: 'ydyi-project', version: 1, id: 'v2', name: '无包络' }));
  ck('无 env 的旧存档 → null', noEnv.env === null);
}

// ---------- 6b. 存档字段映射：两份拷贝必须对齐（2026-09-20 加）----------
// 坑的由来：写存档的字段映射有【两份拷贝】——proj/project.mjs 的 projectToFile/projectSave
// （导出与老 IDB 路径）和 app.mjs 的 projBuildRecord（archives/ 文件夹这条现行路径）。
// 2026-09-19 存档从 IndexedDB 搬到 archives/ 后，新拷贝漏了 env → 实测 9 个存档 env 全 null
// → 重开存档钢琴块分段比"录完当场"粗一档（与第 6 节同一个坑，只是换了写入路径）。
// 这类漏字段不会抛异常，只能靠对比字段集合发现，故这里做源码级断言。
console.log('\n-- 存档字段映射两份拷贝必须对齐 --');
{
  // ⚠ 必须先剥掉注释再判定：这些函数体里的注释本身就写着 env/analysis，
  // 直接 includes('env') 会恒真（本守卫第一版就是这么写空的，实测去掉映射行照样通过）。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const appSrc = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8');
  const m = /function projBuildRecord\([\s\S]*?\n\}/.exec(appSrc);
  ck('找得到 app.mjs 的 projBuildRecord', !!m);
  const body = strip(m ? m[0] : '');
  // 关键字段：analysis(曲线，对象字面量键) / env(气口线索，对象字面量键) /
  // midiNotes·audioBlob(走 if 分支赋值，用词边界判定) 一个都不能少
  ck('projBuildRecord 映射含 analysis', /\banalysis\s*:/.test(body));
  ck('projBuildRecord 映射含 env', /\benv\s*:/.test(body));
  ck('projBuildRecord 映射含 midiNotes', /\bmidiNotes\b/.test(body));
  ck('projBuildRecord 映射含 audioBlob', /\baudioBlob\b/.test(body));

  const projSrc = strip(readFileSync(new URL('../proj/project.mjs', import.meta.url), 'utf8'));
  const tf = /export function projectToFile[\s\S]*?readAsDataURL/.exec(projSrc);
  ck('找得到 project.mjs 的 projectToFile', !!tf);
  for (const f of ['analysis', 'env', 'midiNotes']) {
    ck(`projectToFile 映射含 ${f}`, !!tf && new RegExp('\\b' + f + '\\s*:').test(tf[0]));
  }
  // 打开存档时的读取映射也必须把 env 读回来（写对了但读漏了同样白搭）
  const openSrc = /function projOpenArchive\([\s\S]*?\n\}/.exec(strip(appSrc));
  ck('projOpenArchive 读取映射含 env', !!openSrc && /\benv\b\s*[,}]/.test(openSrc[0]));
}

// ---------- 6c. analysis.params（口径留痕）与 sr 语义（2026-09-20 加）----------
// 曲线依赖 kernel/sens/voicing/能量门，不记下来就没法复现、没法解释"重算后怎么变了"。
// 另固化 sr 的语义：它是【分析时解码缓冲】的采样率（不是存档音频自身的），
// 栅格权威是 hopMs —— 谁要拿存档音频重算，帧移必须按 hopMs×当前 sr 求。
console.log('\n-- 分析口径留痕 params / sr 语义 --');
{
  const { analyzePCM } = await import('../dsp/analyze.mjs');
  const sr = 44100, N = 4096, hopSize = 1024;
  const pcm = new Float32Array(sr);                     // 1s 静音足够验契约（不关心音高）
  const a1 = analyzePCM(pcm, sr, { hopSize, windowSize: N, sens: 66, kernel: 'pyin', voicing: 80 });
  ck('params 在册', !!a1.params);
  ck('params.kernel 跟随实参', a1.params && a1.params.kernel === 'pyin');
  ck('params.sens/voicing 跟随实参', a1.params && a1.params.sens === 66 && a1.params.voicing === 80);
  ck('params.energy 记了自适应底噪', !!(a1.params && a1.params.energy && a1.params.energy.mode === 'auto'
    && Number.isFinite(a1.params.energy.floorRms)), '  floorRms=' + (a1.params && a1.params.energy && a1.params.energy.floorRms));
  const a2 = analyzePCM(pcm, sr, { hopSize, windowSize: N, sens: 70, energy: { mode: 'manual', db: 40 } });
  ck('显式能量门如实记录', !!(a2.params && a2.params.energy && a2.params.energy.mode === 'manual' && a2.params.energy.db === 40));
  ck('params.hopMs 与顶层一致', a1.params.hopMs === a1.hopMs);
  // sr 语义自洽：hopMs = hopSize/sr*1000（sr 是分析缓冲的采样率，别当音频音频率用）
  ck('hopMs 与 hopSize/sr 自洽', Math.abs(a1.hopMs - hopSize / sr * 1000) < 0.02, '  hopMs=' + a1.hopMs);
}

// ---------- 7. 时长兜底（MIDI 存档的走带条） ----------
// MIDI 工程没有音频时长，只有音符表。列表/走带条要一个 duration，
// 由"最后一个音符结束时间"算。这里固化算法口径，免得日后改了 t1 单位没人发现。
console.log('\n-- MIDI 时长兜底 --');
{
  // app.mjs projRecordDuration 的口径（此处复刻，保证两边一致）：
  // duration = max(t1)/1000 + 1.2s 余量；无音符时退化为 1s
  const durOf = (rec) => {
    if (rec.duration > 0) return rec.duration;
    const ns = rec.midiNotes || [];
    if (ns.length) return Math.max(1, ns.reduce((m, n) => Math.max(m, n.t1), 0) / 1000 + 1.2);
    return 1;
  };
  ck('有 duration 时原样用', durOf({ duration: 3.5, midiNotes: [] }) === 3.5);
  ck('MIDI(末音 t1=1400ms) → 2.6s', Math.abs(durOf({ midiNotes })- 2.6) < 1e-9);
  ck('纯音符无 duration → 至少 1s', durOf({ midiNotes: [{ t1: 100 }] }) >= 1);
  ck('空存档 → 1s', durOf({}) === 1);
}

// ---------- 8. 异常输入 ----------
console.log('\n-- 异常输入 --');
{
  let threw = false;
  try { parseProjectFile('{"magic":"other"}'); } catch (e) { threw = true; }
  ck('magic 不对 → 抛错(不返回半个工程)', threw);
  let threw2 = false;
  try { parseProjectFile('not json at all'); } catch (e) { threw2 = true; }
  ck('非 JSON → 抛错', threw2);
  // 空音符数组不该被当成"有音符"
  const { proj: empty } = parseProjectFile(JSON.stringify({
    magic: 'ydyi-project', version: 1, id: 'e', name: 'e', midiNotes: [] }));
  ck('空 midiNotes 归一成 null', empty.midiNotes === null);
  ck('空 midiNotes 不误判成 midi', inferKind(empty) === KIND_AUDIO);
}

// ---------- 9. source 的 .ydyi roundtrip ----------
// 导出丢了 source → 拷到别的电脑导入后分类退化成"按名字猜"，
// 录音又被错标成导入音频（就是 2026-09-14 那个 bug 会在导入路径上复活）。
console.log('\n-- source 的 .ydyi roundtrip --');
{
  for (const [src, label] of [[SOURCE_REC, '录音'], [SOURCE_IMPORT, '导入音频'], [SOURCE_MIDI, 'MIDI']]) {
    const p = { id: 's_' + src, name: '测试', createdAt: 1, source: src, duration: 1,
      midiNotes: src === SOURCE_MIDI ? midiNotes : null, audioBlob: null };
    const o = JSON.parse(await projectToFile(p, { includeAudio: false }));
    ck('导出 JSON 带 source=' + src, o.source === src, ' → ' + o.source);
    const { proj: back } = parseProjectFile(JSON.stringify(o));
    ck('解析回来 source=' + src + '（' + label + '）', back.source === src);
    ck('解析回来仍归「' + label + '」', originLabel(back) === label
      || (src === SOURCE_MIDI && originLabel(back) === 'MIDI·转谱'));
  }
  // 老 .ydyi 没有 source：留 null，由 inferSource 兜底，不能硬塞一个默认值
  const { proj: old } = parseProjectFile(JSON.stringify({
    magic: 'ydyi-project', version: 1, id: 'o', name: '录音 08:00:00' }));
  ck('老 .ydyi 无 source → null(不瞎写)', old.source === null);
  ck('老 .ydyi 靠名字仍能认成录音', inferSource(old) === SOURCE_REC);
}

if (fails) { console.error(`[project-archive] ${fails} 项失败`); process.exit(1); }
console.log('[project-archive] 全部通过');
