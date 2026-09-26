// ============================================================
// test/app-rec-machine.mjs —— 录音状态机特征测试（node 直跑，无浏览器）
//
// 背景：2026-09-15 体检发现 app.mjs（3558 行）几乎零自动化覆盖——录音状态机、
// 播放器、存档、曲库、转谱、RVC、画布拖动全是裸奔。要在这种状态下做结构重构，
// 等于闭着眼改。这个文件就是给【录音状态机】建的第一张网。
//
// 它不测"应该怎样"，只钉【现状如何】——所以叫特征测试（characterization test）：
// 先把行为固定下来，重构时任何意外变化都会被它抓到。
//
// 状态机（app.mjs 实际实现）：
//   idle --btnRec--> rec --btnRec--> paused --btnRec--> rec
//   rec|paused --btnAud--> listen --btnRec--> rec
//   任意非 idle --btnSaveRec--> idle
//   rec|paused|listen 中导入音频 --> abortRecordSession（丢弃本次录音，不保存）
// 每条边都要断言"状态 + 按钮文案 + recorder 的真实调用序列"。
// ============================================================
import { installStubs } from './_harness.mjs';

let fails = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[app-rec-machine] 录音状态机特征测试');

const H = installStubs();
await import('../app.mjs');

const el = (id) => H.byId(id);
// 录音机界面下所有可见信号的快照（都是 app.mjs 真的会写的地方）
const ui = () => ({
  btn: el('btnRec').textContent,
  aud: el('btnAud').textContent,
  audShown: el('btnAud').style.display !== 'none',
  saveShown: el('btnSaveRec').style.display !== 'none',
  seekShown: el('recSeek').style.display !== 'none',
  clock: el('recClock').textContent,
  status: el('recStatus').textContent,
});
const rec = () => H.MediaRecorder.all[0];
const calls = () => (rec() ? rec().__calls.join(',') : '(无 recorder)');
const logHas = (re) => H.logs.some((e) => re.test(JSON.stringify(e)));
const ctx = () => H.contexts[0];

// ---------- 初始态 ----------
{
  const u = ui();
  ck('初始：按钮是「● 开始录音」', u.btn === '● 开始录音', u.btn);
  ck('初始：试听按钮隐藏', !u.audShown);
  ck('初始：保存按钮隐藏', !u.saveShown);
  ck('初始：走带条隐藏', !u.seekShown);
  ck('初始：时钟为「⏺ 00:00.0」（fmtClock 带十分位）', u.clock === '⏺ 00:00.0', u.clock);
}

// ---------- 前置守卫：idle 时点「试听」必须无动作 ----------
{
  const before = ui();
  const r = H.click('btnAud');
  const after = ui();
  ck('idle 点试听：不抛异常', r.ok, r.error && r.error.message);
  ck('idle 点试听：界面无变化（不产生副作用）',
    after.btn === before.btn && after.audShown === before.audShown && after.status === before.status);
  ck('idle 点试听：一个 MediaRecorder 都没被创建', H.MediaRecorder.all.length === 0);
}

// ---------- idle → rec ----------
{
  H.click('btnRec');
  await H.sleep(1200);                    // startRecording 内有 autoCalib（20×40ms）
  const u = ui();
  ck('开始录音：创建了 MediaRecorder', H.MediaRecorder.all.length === 1);
  ck('开始录音：recorder 状态 = recording', rec() && rec().state === 'recording', rec() && rec().state);
  ck('开始录音：recorder.start 被调用', rec() && rec().__calls.includes('start'), calls());
  ck('开始录音：录的是麦克风流（不是画布）', rec() && rec().stream && rec().stream.id === 'fake-mic',
    rec() && JSON.stringify(rec().stream));
  ck('开始录音：按钮变「⏸ 暂停录音」', u.btn === '⏸ 暂停录音', u.btn);
  ck('开始录音：试听按钮出现且为「⏯ 试听」', u.audShown && u.aud === '⏯ 试听', u.aud);
  ck('开始录音：保存按钮出现', u.saveShown);
  ck('开始录音：rec 态走带条隐藏（录音中无需拖动）', !u.seekShown);
  ck('开始录音：状态栏提示可暂停/试听/停止', /录音中/.test(u.status) && /试听/.test(u.status), u.status);
  ck('开始录音：时钟前缀是 ⏺', u.clock.startsWith('⏺'), u.clock);
  ck('开始录音：写了日志', logHas(/开始录音/));
}

// ---------- 推进音频时钟 + 推帧 → 累积录音 PCM（试听要用） ----------
{
  ctx().currentTime = 2.0;
  H.pump(); H.pump();
  ck('推进时钟后时钟读数跟上（⏺ 00:02.0）', el('recClock').textContent === '⏺ 00:02.0', el('recClock').textContent);
}

// ---------- rec → paused ----------
{
  H.click('btnRec');
  const u = ui();
  ck('暂停：recorder.pause 被调用', rec().__calls.includes('pause'), calls());
  ck('暂停：按钮变「▶ 继续录音」', u.btn === '▶ 继续录音', u.btn);
  ck('暂停：走带条出现（可回看曲线）', u.seekShown);
  ck('暂停：走带时间显示 位置/总长', /\//.test(el('recSeekT').textContent), el('recSeekT').textContent);
  ck('暂停：状态栏提示三种去向', /已暂停/.test(u.status) && /继续录音/.test(u.status), u.status);
  // 时钟必须【冻结】：把音频时钟推到 9 秒，界面读数不得跟涨
  ctx().currentTime = 9.0;
  ck('暂停：时钟冻结在 00:02.0（不随音频时钟前进）', el('recClock').textContent === '⏺ 00:02.0', el('recClock').textContent);
}

// ---------- paused → listen（关键：试听时长必须是"冻结点"，不是当前时钟） ----------
{
  const r = H.fire('btnAud', 'click');
  const u = ui();
  ck('试听：不抛异常', r.ok, r.error && r.error.message);
  ck('试听：按钮变「● 回到录音续录」', u.btn === '● 回到录音续录', u.btn);
  ck('试听：试听按钮变「⏸ 暂停试听」（正在播）', u.aud === '⏸ 暂停试听', u.aud);
  ck('试听：走带条出现（可拖到任意位置试听）', u.seekShown);
  ck('试听：播放器真的起了 buffer source', H.bufferSources.length > 0, 'bufferSources=' + H.bufferSources.length);
  ck('试听：状态栏里的时长是冻结值 2.0s（不是音频时钟的 9.0s）',
    /录到 2\.0s/.test(u.status), u.status);
  // recorder 进入 paused 即"试听期间不再采录"；此处它本来就是 paused（暂停态直接试听），
  // 所以 startListening 不会重复调 pause —— 正确行为，不是漏调。
  ck('试听：recorder 处于 paused（不再采录）', rec().state === 'paused', rec().state);
  ck('试听：全程只 pause 过一次（不重复调用）', rec().__calls.filter((x) => x === 'pause').length === 1, calls());
}

// ---------- listen → rec（回到原处续录） ----------
{
  H.click('btnRec');
  const u = ui();
  ck('续录：按钮回到「⏸ 暂停录音」', u.btn === '⏸ 暂停录音', u.btn);
  ck('续录：recorder.resume 被调用', rec().__calls.includes('resume'), calls());
  ck('续录：状态栏写明从冻结处续录', /续录/.test(u.status) && /2\.0s/.test(u.status), u.status);
}

// ---------- rec → idle（停止并保存） ----------
{
  H.click('btnSaveRec');
  await H.sleep(30);
  const u = ui();
  ck('停止：recorder.stop 被调用', rec().__calls.includes('stop'), calls());
  ck('停止：按钮回到「● 开始录音」', u.btn === '● 开始录音', u.btn);
  ck('停止：试听/保存/走带条重新隐藏', !u.audShown && !u.saveShown && !u.seekShown);
  ck('停止：写了「停止录音」日志并带上冻结总时长(2000ms)', logHas(/停止录音/) && logHas(/2000/),
    H.logs.map((e) => JSON.stringify(e)).filter((s) => /停止/.test(s)).join(' | '));
}

// ---------- idle 时点「停止并保存」必须无动作（不能反过来造出一个空片段） ----------
{
  const n0 = H.MediaRecorder.all.length;
  const r = H.click('btnSaveRec');
  ck('idle 点停止保存：不抛异常且不新建任何东西',
    r.ok && H.MediaRecorder.all.length === n0, r.error && r.error.message);
}

// ---------- 录音中导入音频 → abortRecordSession（丢弃本次录音，转去播新片段） ----------
{
  H.click('btnRec');
  await H.sleep(1200);
  ck('第二轮录音已开始（按钮为暂停态）', el('btnRec').textContent === '⏸ 暂停录音', el('btnRec').textContent);
  const r = H.fire('fileAudio', 'change', { target: { files: [H.fakeFile('新片段.wav')], value: '' } });
  ck('录音中选文件：不抛异常', r.ok, r.error && r.error.message);
  await H.sleep(60);                       // decodeBuf → loadClip 是异步链
  ck('录音中导入 → 本次录音被丢弃（写了「已丢弃未保存的录音会话」）',
    logHas(/已丢弃未保存的录音会话/));
  ck('导入后视图切到播放器（新建按钮可见）', el('playCtrls').style.display !== 'none');
}

console.log(fails ? `\n[app-rec-machine] ${fails} 项失败` : '\n[app-rec-machine] 全部通过');
process.exit(fails ? 1 : 0);
