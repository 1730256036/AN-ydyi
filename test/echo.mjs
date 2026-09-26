// test/echo.mjs —— app/echo.mjs 的特征测试（① 状态收敛首域的守卫）
//
// 为什么用「带 query 的动态 import」拿实例：
//   echo.mjs 的状态是模块级的（单例）。Node 把 `echo.mjs?i=3` 当成另一个 URL，
//   会独立求值一次 → 每个用例都拿到干净的初始状态，用例之间不串味。
//   同时这也验证了模块自持状态确实封在模块里（外部拿不到、也改不了）。
//
// 覆盖：localStorage 恢复与钳位 / 只读 live binding / 段确认(≥50ms 才立块) /
//       静音容忍(150ms 才断段) / 段内同向偏离切分 / 包络谷切分(v3：同音快吐不糊块) /
//       resetKey 换代清空 / 600 上限。

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

function fakeLS(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, String(v)]));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

let seq = 0;
/** 拿一个全新的 echo 模块实例（独立状态），可指定初始化时的 localStorage 内容。 */
async function fresh(lsInit) {
  globalThis.localStorage = fakeLS(lsInit);
  return await import(new URL('../app/echo.mjs?i=' + (++seq), import.meta.url).href);
}
/** 造一帧喂给 feed（live 录音帧）。 */
const frame = (audioMs, midi, extra) => Object.assign({ live: true, audioMs, voiced: true, midi }, extra);
const quiet = (audioMs, extra) => Object.assign({ live: true, audioMs, voiced: false }, extra);

console.log('[echo] 回声域特征测试');

// ─────────── ① 初始状态与 localStorage 恢复 ───────────
{
  const m = await fresh({});
  ck('默认 echoOn=false', m.echoOn === false, String(m.echoOn));
  ck('默认 echoFallMs=4200', m.echoFallMs === 4200, String(m.echoFallMs));
  ck('默认 echoNotes 为空数组', Array.isArray(m.echoNotes) && m.echoNotes.length === 0);
}
{
  const m = await fresh({ ydyi_echo: '1', ydyi_echo_fall: '1500' });
  ck('从 localStorage 恢复 echoOn=true', m.echoOn === true, String(m.echoOn));
  ck('从 localStorage 恢复 echoFallMs=1500', m.echoFallMs === 1500, String(m.echoFallMs));
}
{
  // 钳位：与 setEchoFall 同一口径（300..8000），初始恢复也必须钳
  ck('恢复时超上限钳到 8000', (await fresh({ ydyi_echo_fall: '99999' })).echoFallMs === 8000);
  ck('恢复时低于下限钳到 300', (await fresh({ ydyi_echo_fall: '10' })).echoFallMs === 300);
  ck('恢复时非数字回落 4200', (await fresh({ ydyi_echo_fall: 'abc' })).echoFallMs === 4200);
  ck('echo 开关只认字符串 "1"', (await fresh({ ydyi_echo: 'true' })).echoOn === false);
}

// ─────────── ② setter：既改 live binding，也落 localStorage ───────────
{
  const m = await fresh({});
  m.setEchoEnabled(true);
  ck('setEchoEnabled(true) 改 live binding', m.echoOn === true);
  ck('setEchoEnabled(true) 写 localStorage', globalThis.localStorage.getItem('ydyi_echo') === '1');
  m.setEchoEnabled(0);                       // 非布尔 → !! 归一
  ck('setEchoEnabled(0) 归一为 false', m.echoOn === false);
  ck('setEchoEnabled(0) 写 localStorage "0"', globalThis.localStorage.getItem('ydyi_echo') === '0');

  m.setEchoFall(5000);
  ck('setEchoFall(5000) 生效', m.echoFallMs === 5000);
  ck('setEchoFall 写 localStorage', globalThis.localStorage.getItem('ydyi_echo_fall') === '5000');
  m.setEchoFall(99999); ck('setEchoFall 超上限钳 8000', m.echoFallMs === 8000);
  m.setEchoFall(1);     ck('setEchoFall 低于下限钳 300', m.echoFallMs === 300);
  m.setEchoFall(NaN);   ck('setEchoFall(NaN) 回落 4200', m.echoFallMs === 4200);
  m.setEchoFall(1234.7); ck('setEchoFall 取整', m.echoFallMs === 1235);
}

// ─────────── ③ feed 门禁：非录音态 / 非 live 帧 / 负时间轴一律不产块 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'idle' });
  for (const t of [0, 50, 100, 150]) m.echoFeed(frame(t, 60));
  ck('非录音态：喂满 150ms 也不产块', m.echoNotes.length === 0, String(m.echoNotes.length));

  const m2 = await fresh({ ydyi_echo: '1' });
  m2.configureEcho({ getRecState: () => 'paused' });
  m2.echoFeed(frame(0, 60)); m2.echoFeed(frame(200, 60));
  ck('暂停态：不产块', m2.echoNotes.length === 0);

  const m3 = await fresh({ ydyi_echo: '1' });
  m3.configureEcho({ getRecState: () => 'rec' });
  m3.echoFeed({ audioMs: 0, voiced: true, midi: 60 });          // 无 live
  m3.echoFeed(frame(-5, 60));                                    // 负时间轴
  m3.echoFeed({ live: true, audioMs: 200, voiced: true });       // midi 缺失
  m3.echoFeed({ live: true, audioMs: 300, voiced: true, midi: NaN });
  ck('非 live / 负 audioMs / 无 midi：均不产块', m3.echoNotes.length === 0, String(m3.echoNotes.length));

  const m4 = await fresh({});                                    // echoOn=false
  m4.configureEcho({ getRecState: () => 'rec' });
  for (const t of [0, 50, 100]) m4.echoFeed(frame(t, 60));
  ck('未开回声：录音态也不产块', m4.echoNotes.length === 0);
}

// ─────────── ④ 段确认：发声满 50ms 才立块(v3 100→50)，着陆 = 段起点 + fallMs ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  m.echoFeed(frame(0, 60));
  m.echoFeed(frame(23, 60));
  ck('发声 23ms：尚未立块（<50ms 碎段无痕）', m.echoNotes.length === 0);
  m.echoFeed(frame(46, 60));
  ck('发声 46ms：仍未立块', m.echoNotes.length === 0);
  m.echoFeed(frame(69, 60));
  ck('发声 69ms：立块（≥50ms）', m.echoNotes.length === 1, String(m.echoNotes.length));
  ck('着陆时刻 = 段起点(0) + fallMs(4200)', m.echoNotes[0].t0 === 4200, String(m.echoNotes[0].t0));
  ck('块顶随时间生长 t1=4200+69', m.echoNotes[0].t1 === 4200 + 69, String(m.echoNotes[0].t1));
  ck('块音高为整数 midi 60', m.echoNotes[0].midi === 60, String(m.echoNotes[0].midi));
}

// ─────────── ⑤ fallMs 直接决定着陆延迟 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  m.setEchoFall(1000);
  for (const t of [0, 50, 100, 150]) m.echoFeed(frame(t, 64));
  ck('fallMs=1000：着陆时刻 = 段起点 + 1000', m.echoNotes.length === 1 && m.echoNotes[0].t0 === 1000,
    JSON.stringify(m.echoNotes.map((n) => n.t0)));
}

// ─────────── ⑥ 静音容忍：150ms 才断段；立过的块绝不撤 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  for (const t of [0, 50, 100, 150]) m.echoFeed(frame(t, 60));
  ck('前置：已立 1 块', m.echoNotes.length === 1);
  const kept = m.echoNotes[0];

  m.echoFeed(quiet(200));          // 静音 50ms（不足 150 → 段不拆）
  m.echoFeed(frame(250, 60));      // 复声 → 仍是同一段
  ck('静音 50ms 后复声：不产生第二块（段没断）', m.echoNotes.length === 1, String(m.echoNotes.length));
  ck('同段续吹：首块对象仍是同一个（未重建）', m.echoNotes[0] === kept);

  m.echoFeed(quiet(400));          // 静音 += 400-250 = 150 → 恰好到阈值 → 断段
  m.echoFeed(frame(700, 60));      // 新段第一帧
  ck('断段后新发声：不产块（新段要重新累计 50ms）', m.echoNotes.length === 1, String(m.echoNotes.length));
  m.echoFeed(frame(750, 60));
  ck('新段满 50ms：产生第二块', m.echoNotes.length === 2, String(m.echoNotes.length));
  ck('断段不撤旧块（第一块仍在）', m.echoNotes[0] === kept);
  ck('第二块从新段起点(700)着陆', m.echoNotes[1].t0 === 700 + 4200, String(m.echoNotes[1].t0));
}

// ─────────── ⑦ 段内同向偏离 ≥0.7 半音连续 2 帧 → 收口当前块、起新块 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  for (const t of [0, 23, 46, 69, 92, 115]) m.echoFeed(frame(t, 60));
  ck('前置：60 号音已立块', m.echoNotes.length === 1);
  const A = m.echoNotes[0];

  m.echoFeed(frame(138, 62));                       // 偏离 +2 半音，第 1 帧
  ck('偏离 1 帧：不切（要连续 2 帧）', m.echoNotes.length === 1, String(m.echoNotes.length));
  m.echoFeed(frame(161, 62));                       // 第 2 帧 → 触发切分，新段从 138 起
  m.echoFeed(frame(184, 62));
  ck('切分后新段 46ms：尚未立块（<50ms）', m.echoNotes.length === 1, String(m.echoNotes.length));
  m.echoFeed(frame(207, 62));                       // 207-138=69 ≥50 → 立新块
  ck('同向偏离 2 帧后：新块出现（每音各自成块）', m.echoNotes.length === 2, String(m.echoNotes.length));
  ck('旧块收口到首个偏离帧：t1 = 4200 + 138', A.t1 === 4200 + 138, String(A.t1));
  ck('旧块音高锁定 60（偏离帧不算入中位）', A.midi === 60, String(A.midi));
  ck('新块从偏离帧起着陆：t0 = 138 + 4200', m.echoNotes[1].t0 === 138 + 4200, String(m.echoNotes[1].t0));
  ck('新块音高 62', m.echoNotes[1].midi === 62, String(m.echoNotes[1].midi));
}
{
  // 反向：方向交替（颤音）不该切——这是"同向连续才切"的关键反例
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  for (const t of [0, 23, 46, 69, 92, 115]) m.echoFeed(frame(t, 60));
  for (let i = 0; i < 10; i++) m.echoFeed(frame(138 + i * 23, i % 2 ? 62 : 58));   // 62/58 交替
  ck('颤音(方向交替)：不误切，仍只有 1 块', m.echoNotes.length === 1, String(m.echoNotes.length));
}

// ─────────── ⑧ resetKey 换代 → 清空音符表（换片段/停止录音后不残留） ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  for (const t of [0, 50, 100, 150]) m.echoFeed(frame(t, 60, { resetKey: 'seg-1' }));
  ck('前置：第一代已立块', m.echoNotes.length === 1);
  m.echoFeed(frame(200, 60, { resetKey: 'seg-2' }));
  ck('resetKey 换代：音符表立即清空', m.echoNotes.length === 0, String(m.echoNotes.length));
}

// ─────────── ⑨ 落地上限 600（长时间录音不无限膨胀） ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  let t = 0;
  for (let n = 0; n < 620; n++) {
    m.echoFeed(frame(t, 60)); m.echoFeed(frame(t + 50, 60)); m.echoFeed(frame(t + 100, 60));  // 满 100ms 立块
    m.echoFeed(quiet(t + 150)); m.echoFeed(quiet(t + 350));                                    // 静音 200ms 断段
    t += 400;
  }
  ck('620 轮喂入后 echoNotes 仍被压在上限 600（循环真跑了 + 上限生效）',
    m.echoNotes.length === 600, String(m.echoNotes.length));
  ck('保留的是最新的块（末尾块最晚上限内生成）', m.echoNotes[m.echoNotes.length - 1].t0 > m.echoNotes[0].t0);
}

// ─────────── ⑪ 包络谷切分(v3 方案A)：同音快吐不再糊成一大块 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  // 合成 recEnv（5ms 一步，网格对齐谷点）：整体 rms=1.0，t=135/145 两肩 0.8，
  // t=140 谷底 0.5（谷深 20log10(0.8/0.5)=4.1dB ≥3 → 该切）。音高恒 60、
  // 无任何静音帧 → 旧逻辑（只有静音容忍+音高切分）整段糊成 1 块；v3 靠谷切分拆成 2 块。
  const env = [];
  for (let t = 0; t <= 560; t += 5) {
    let rms = 1.0;
    if (t === 135 || t === 145) rms = 0.8;
    else if (t === 140) rms = 0.5;
    env.push({ t, rms });
  }
  // 连续吹同音 0~560ms，每帧喂 4 个 env 点（≈24ms，跟上音频游标）
  let k = 0;
  for (let t = 0; t <= 560; t += 23) {
    m.echoFeed(frame(t, 60, { env: env.slice(0, Math.min(env.length, (k += 4) ) ) }));
  }
  // 谷 t=140 需其后 60 点(≈360ms)定案 → t≈500 后生效；560ms 时应已切
  ck('同音快吐被包络谷切成 2 块', m.echoNotes.length === 2, JSON.stringify(m.echoNotes));
  ck('左块收口在谷底：t1 = 140 + 4200', m.echoNotes[0] && m.echoNotes[0].t1 === 140 + 4200, String(m.echoNotes[0] && m.echoNotes[0].t1));
  ck('右块从谷底起：t0 = 140 + 4200', m.echoNotes[1] && m.echoNotes[1].t0 === 140 + 4200, String(m.echoNotes[1] && m.echoNotes[1].t0));
  ck('两块同音高 60（谷切分两侧各自定音）', m.echoNotes[0] && m.echoNotes[1] && m.echoNotes[0].midi === 60 && m.echoNotes[1].midi === 60);
}

// ─────────── ⑫ 块已落地：谷切点整条弃掉（绝不切已落地的块） ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  m.setEchoFall(300);                  // 下落极短：谷定案(≈500ms)之前块已落地(300ms)
  const env = [];
  for (let t = 0; t <= 560; t += 5) {
    let rms = 1.0;
    if (t === 135 || t === 145) rms = 0.8;
    else if (t === 140) rms = 0.5;
    env.push({ t, rms });
  }
  let k = 0;
  for (let t = 0; t <= 560; t += 23) {
    m.echoFeed(frame(t, 60, { env: env.slice(0, Math.min(env.length, (k += 4))) }));
  }
  ck('fall=300 块早落地：谷切点被弃，仍 1 块', m.echoNotes.length === 1, String(m.echoNotes.length));
}

// ─────────── ⑬ 浅谷（谷深 <3dB）不切 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  const env = [];
  for (let t = 0; t <= 560; t += 5) {
    let rms = 1.0;
    if (t === 135 || t === 145) rms = 0.95;
    else if (t === 140) rms = 0.9;      // 谷深 20log10(0.95/0.9)=0.47dB <3 → 不切
    env.push({ t, rms });
  }
  let k = 0;
  for (let t = 0; t <= 560; t += 23) {
    m.echoFeed(frame(t, 60, { env: env.slice(0, Math.min(env.length, (k += 4))) }));
  }
  ck('浅谷不切：仍 1 块', m.echoNotes.length === 1, String(m.echoNotes.length));
}


// ─────────── ⑭ 出块算法档位联动(snapshot 经 d.segAlgo 注入)：经典档不接包络 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  m.configureEcho({ getRecState: () => 'rec' });
  const env = [];
  for (let t = 0; t <= 560; t += 5) {
    let rms = 1.0;
    if (t === 135 || t === 145) rms = 0.8;
    else if (t === 140) rms = 0.3;      // 谷深 10.5dB：颗粒档该切，经典档不切
    env.push({ t, rms });
  }
  let k = 0;
  for (let t = 0; t <= 560; t += 23) {
    m.echoFeed(frame(t, 60, { env: env.slice(0, Math.min(env.length, (k += 4))), segAlgo: 'classic' }));
  }
  ck('经典档：包络谷不切=1块', m.echoNotes.length === 1, String(m.echoNotes.length));
}

// ─────────── ⑩ 对外只读：模块不导出任何可写入口 ───────────
{
  const m = await fresh({ ydyi_echo: '1' });
  // 只读性由 ESM 语言层保证（import 绑定不可赋值，赋值在模块外是 TypeError）。
  // 这里断言接口面：改状态只有这三个具名函数，没有裸 setter / 没有整包 state 对象。
  const fns = Object.keys(m).filter((k) => typeof m[k] === 'function').sort();
  ck('导出函数面 = configureEcho/echoFeed/setEchoEnabled/setEchoFall',
    JSON.stringify(fns) === JSON.stringify(['configureEcho', 'echoFeed', 'setEchoEnabled', 'setEchoFall']),
    JSON.stringify(fns));
  ck('没有导出名为 state/echoSeg 的可写容器', m.state === undefined && m.echoSeg === undefined);
}

console.log(`[echo] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
