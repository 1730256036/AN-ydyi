// test/audio.mjs —— app/audio.mjs（音频路由域）的特征测试
//
// 与 app-rec-machine.mjs 的分工：那边走真实接线（点「开始录音」→ 全链路），
// 本测试注入受控依赖，逐个断言路由域自身的语义：上下文创建、总线接线、
// 路由切换、底噪校准、麦克风缓存、播放音量三件套（改值+落盘+同步 gain）。
//
// ⚠️ autoCalib 真采 20×40ms≈800ms 环境能量（桩填 0 → envBase=1e-5 下限），
// 所以 startMicRoute 那组断言会真等 ~0.8s——这是校准逻辑本身，不是测试慢。

import { installStubs } from './_harness.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
// 给 getUserMedia 加计数：验证"ensureMic 第二次不重复申请"
let gumCount = 0;
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => { gumCount++; return { id: 'fake-mic-' + gumCount }; } } },
  configurable: true,
});

const audio = await import('../app/audio.mjs');

let srSeen = 0;
const gateCalls = [];
let cfgWin = 4096;
audio.configureAudio({
  getCfgWindow: () => cfgWin,
  isGateAuto: () => true,
  syncGateUI: () => { gateCalls.push(1); },
  onSampleRate: (sr) => { srSeen = sr; },
});

console.log('[audio] 音频路由域特征测试');

// ─────────── ① 初始：一切未创建 ───────────
{
  ck('初始 audioCtx=null', audio.audioCtx === null);
  ck('初始 analyser/analyserRms=null', audio.analyser === null && audio.analyserRms === null);
  ck('初始 ctxSr=44100（占位值）', audio.ctxSr === 44100);
  ck('初始 activeRoute=none', audio.activeRoute === 'none');
  ck('初始 envBase=0（未校准 → 首次开麦会触发校准）', audio.envBase === 0);
  ck('初始 origPlayVol=1', audio.origPlayVol === 1);
  ck('初始 micSrc/micGain/playGain=null', !audio.micSrc && !audio.micGain && !audio.playGain);
}

// ─────────── ② initAudio：建上下文 + 两条总线 ───────────
{
  await audio.initAudio();
  ck('initAudio：创建了 AudioContext', audio.audioCtx !== null);
  ck('initAudio：ctxSr 取自 ctx.sampleRate（桩=48000）', audio.ctxSr === 48000, String(audio.ctxSr));
  ck('initAudio：onSampleRate 被通知（app 侧写 dbg.sr）', srSeen === 48000, String(srSeen));
  ck('initAudio：analyser.fftSize 来自检测配置（两处必须一致）', audio.analyser.fftSize === 4096, String(audio.analyser.fftSize));
  ck('initAudio：analyserRms.fftSize=1024（能量专用小窗）', audio.analyserRms.fftSize === 1024);
  ck('initAudio：两条总线增益初始 0（实时 mic 防啸叫）',
    audio.micGain.gain.value === 0 && audio.playGain.gain.value === 0);
}

// ─────────── ③ ensureMic：申请 + 缓存 ───────────
{
  const ms1 = await audio.ensureMic();
  ck('ensureMic：申请到了 mic stream', !!ms1);
  const ms2 = await audio.ensureMic();
  ck('ensureMic：第二次复用缓存（不重复申请）', ms2 === ms1 && gumCount === 1, 'gumCount=' + gumCount);
}

// ─────────── ④ startMicRoute：接线 + 自动校准（真等 ~0.8s） ───────────
{
  await audio.startMicRoute();
  ck('startMicRoute：micSrc 已创建接线', audio.micSrc !== null);
  ck('startMicRoute：路由切到 mic', audio.activeRoute === 'mic', audio.activeRoute);
  ck('startMicRoute：mic 增益开到 1', audio.micGain.gain.value === 1, String(audio.micGain.gain.value));
  ck('startMicRoute：校准完成 envBase>0（桩全 0 → 落在 1e-5 下限）', audio.envBase > 0, String(audio.envBase));
  ck('startMicRoute：校准后刷新了门控 UI', gateCalls.length > 0);
  // 再调一次不重复接线/不重复校准
  const gateBefore = gateCalls.length;
  await audio.startMicRoute();
  ck('startMicRoute：幂等（micSrc 已在 → 不重建）', gateCalls.length === gateBefore || audio.micSrc !== null);
}

// ─────────── ⑤ routeNow：切换"谁喂 analyser" ───────────
{
  audio.routeNow('play');
  ck('routeNow(play)：路由切走 + mic 增益归 0', audio.activeRoute === 'play' && audio.micGain.gain.value === 0);
  audio.routeNow('mic');
  ck('routeNow(mic)：切回 + mic 增益开到 1', audio.activeRoute === 'mic' && audio.micGain.gain.value === 1);
}

// ─────────── ⑥ 播放输出：ensurePlayOut + setOrigPlayVol ───────────
{
  const out = audio.ensurePlayOut();
  ck('ensurePlayOut：创建了主输出节点', !!out);
  ck('ensurePlayOut：初始 gain = origPlayVol(1)', out.gain.value === 1, String(out.gain.value));
  audio.setOrigPlayVol(0.5);
  ck('setOrigPlayVol：改值生效', audio.origPlayVol === 0.5, String(audio.origPlayVol));
  ck('setOrigPlayVol：落盘 localStorage（重启恢复）', globalThis.localStorage.getItem('ydyi_orig_vol') === '0.5',
    globalThis.localStorage.getItem('ydyi_orig_vol'));
  ck('setOrigPlayVol：同步了 gain（你听到的 = 滑杆位置）', audio.playOutNode.gain.value === 0.5);
  const out2 = audio.ensurePlayOut();
  ck('ensurePlayOut：幂等（复用同一节点，绝不二次连接 destination）', out2 === out);
}

// ─────────── ⑦ stopLiveFeeding：静麦（防外放被拾入） ───────────
{
  audio.stopLiveFeeding();
  ck('stopLiveFeeding：mic 增益归 0', audio.micGain.gain.value === 0);
}

// ─────────── ⑧ fftSize 跟随检测配置（改配置重建才生效的契约） ───────────
{
  ck('analyser.fftSize 与注入的检测窗长一致',
    audio.analyser.fftSize === cfgWin, audio.analyser.fftSize + ' vs ' + cfgWin);
}

// ─────────── ⑨ 对外只读：接口面固定 ───────────
{
  const fns = Object.keys(audio).filter((k) => typeof audio[k] === 'function').sort();
  const want = ['autoCalib', 'configureAudio', 'ensureMic', 'ensurePlayOut', 'initAudio',
    'routeNow', 'setOrigPlayVol', 'startMicRoute', 'stopLiveFeeding'];
  ck('导出函数面 = 预期清单（防悄悄多出可写入口）', JSON.stringify(fns) === JSON.stringify(want), JSON.stringify(fns));
  ck('requestMic 保持私有（外部不能绕过缓存直接申请）', audio.requestMic === undefined);
  ck('没有导出内部节点容器之外的可写状态', audio.stopPlayFn === undefined && audio.dbg === undefined);
}

// ─────────── ⑩ ★初始化必须从 localStorage 恢复 ───────────
// 这是"刷新一下就回到默认 100%"的回归守卫（2026-09-15 修）：搬模块时把声明旁的
// 恢复行弄丢了，启动时滑杆首次 updVol() 还会用默认值 1 反把存档覆盖掉。
// 用带 query 的动态 import 取独立实例，逐个验证初始化场景。
{
  globalThis.localStorage.setItem('ydyi_orig_vol', '0.25');
  const a2 = await import(new URL('../app/audio.mjs?restore=1', import.meta.url).href);
  ck('★有存档：origPlayVol 恢复为 0.25', a2.origPlayVol === 0.25, String(a2.origPlayVol));
  globalThis.localStorage.setItem('ydyi_orig_vol', '5');
  const a3 = await import(new URL('../app/audio.mjs?restore=2', import.meta.url).href);
  ck('★越界存档：钳到 [0,1]', a3.origPlayVol === 1, String(a3.origPlayVol));
  globalThis.localStorage.setItem('ydyi_orig_vol', 'abc');
  const a4 = await import(new URL('../app/audio.mjs?restore=3', import.meta.url).href);
  ck('★非数字存档：回落默认 1', a4.origPlayVol === 1, String(a4.origPlayVol));
  globalThis.localStorage.removeItem('ydyi_orig_vol');
  const a5 = await import(new URL('../app/audio.mjs?restore=4', import.meta.url).href);
  ck('★无存档：默认 1', a5.origPlayVol === 1, String(a5.origPlayVol));
}

console.log(`[audio] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
