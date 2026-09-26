// test/player.mjs —— app/player.mjs（播放器域）的特征测试
//
// 与 app-player.mjs 的分工：
//   app-player.mjs 走真实接线（动态 import app.mjs → 点按钮），验的是"整条链路通不通"；
//   本测试只 import 播放器模块本身并注入**受控依赖**，验的是"引擎语义对不对"
//   （装载/清空/播放/暂停/拖动/播完停在末尾），不依赖录音、分析、UI 那一堆东西。
//
// 这样切的好处：引擎逻辑能独立于 app 断言——不拆出来的话想单测它，
// 必须先起一整套 DOM+WebAudio+MediaRecorder 的桩。

import { installStubs } from './_harness.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
const player = await import('../app/player.mjs');
const el = (id) => H.byId(id);

console.log('[player] 播放器域特征测试');

// ─────────── 受控依赖：把引擎从 app 的其余部分里摘出来 ───────────
const calls = { routeNow: [], stopFeed: 0, loop: 0, status: [], ui: 0, noteRate: [] };
const fakeCtx = new globalThis.AudioContext();
const fakeGain = { gain: { setValueAtTime() {} }, connect() {}, disconnect() {} };
player.configurePlayer({
  getAudioCtx: () => fakeCtx,
  getPlayGain: () => fakeGain,
  ensurePlayOut: () => ({ connect() {}, disconnect() {} }),
  routeNow: (r) => calls.routeNow.push(r),
  stopLiveFeeding: () => { calls.stopFeed++; },
  ensureLoop: () => { calls.loop++; },
  setStatus: (s) => calls.status.push(s),
  updateTransportUI: () => { calls.ui++; },
  setNoteRate: (r) => calls.noteRate.push(r),
  snapshot: () => ({}),
  renderTemplate: () => {},
  getRecState: () => 'idle',
  isProjPlayback: () => false,
});

// ─────────── ① 初始状态 ───────────
{
  ck('初始 appView=live', player.appView === 'live', player.appView);
  ck('初始 curClip=null', player.curClip === null);
  ck('初始 clipSeq=0', player.clipSeq === 0, String(player.clipSeq));
  ck('初始 pl.playing=false', player.pl.playing === false);
  ck('初始 pl.pos=0 / dur=0', player.pl.pos === 0 && player.pl.dur === 0);
  ck('初始 playInfo.on=false（RAF 不空转）', player.playInfo.on === false);
}

// ─────────── ② adoptClip：装载片段 ───────────
const CLIP = { name: '片段甲', buffer: { duration: 12.5 }, blob: null };
{
  const seq0 = player.clipSeq;
  player.adoptClip(CLIP);
  ck('adoptClip：curClip 写入', player.curClip === CLIP);
  ck('adoptClip：clipSeq 自增（模板据 resetKey 复位曲线）', player.clipSeq === seq0 + 1, String(player.clipSeq));
  ck('adoptClip：pl.clip 写入', player.pl.clip === CLIP);
  ck('adoptClip：pl.dur 取 buffer.duration', player.pl.dur === 12.5, String(player.pl.dur));
  ck('adoptClip：pl.pos 归零', player.pl.pos === 0);
  ck('adoptClip：pl.playing=false', player.pl.playing === false);
}

// ─────────── ③ resetClip：清空片段 ───────────
{
  const seq0 = player.clipSeq;
  player.resetClip();
  ck('resetClip：curClip=null', player.curClip === null);
  ck('resetClip：pl.clip=null / pos=dur=0', player.pl.clip === null && player.pl.pos === 0 && player.pl.dur === 0);
  ck('resetClip：pl.playing=false', player.pl.playing === false);
  ck('resetClip：clipSeq 再自增（与 adoptClip 同一语义）', player.clipSeq === seq0 + 1, String(player.clipSeq));
}

// ─────────── ④ setView：唯一写 appView 的入口 ───────────
{
  player.setView('play');
  ck('setView(play)：appView=play', player.appView === 'play');
  ck('setView(play)：#playCtrls 显示', el('playCtrls').style.display === '', JSON.stringify(el('playCtrls').style.display));
  ck('setView(play)：#liveCtrls 隐藏', el('liveCtrls').style.display === 'none');
  player.setView('live');
  ck('setView(live)：切回录音机界面', player.appView === 'live' && el('liveCtrls').style.display === '');
  ck('setView(live)：#playCtrls 隐藏', el('playCtrls').style.display === 'none');
}

// ─────────── ⑤ 播放 ───────────
{
  player.adoptClip(CLIP);
  player.setView('play');
  const before = H.bufferSources.length;
  player.playerPlay();
  ck('playerPlay：创建了 buffer source', H.bufferSources.length === before + 1);
  ck('playerPlay：buffer 取自 pl.clip.buffer', H.bufferSources[H.bufferSources.length - 1].buffer === CLIP.buffer);
  ck('playerPlay：pl.playing=true', player.pl.playing === true);
  ck('playerPlay：playInfo.on=true（tick 据此维持 RAF）', player.playInfo.on === true);
  ck('playerPlay：切到 play 音频路由', calls.routeNow[calls.routeNow.length - 1] === 'play');
  ck('playerPlay：停掉实时 mic 喂音', calls.stopFeed > 0);
  ck('playerPlay：拉起了渲染循环', calls.loop > 0);
  ck('playerPlay：主按钮变「⏸ 暂停」', el('btnPP').textContent === '⏸ 暂停', el('btnPP').textContent);
}

// ─────────── ⑥ 暂停：位置推进而不是停在 0 ───────────
{
  fakeCtx.currentTime += 3;                 // 假装播了 3 秒
  player.playerPause();
  ck('playerPause：pl.playing=false', player.pl.playing === false);
  ck('playerPause：playInfo.on=false（RAF 可停）', player.playInfo.on === false);
  ck('playerPause：位置推进到 3s 附近', Math.abs(player.pl.pos - 3) < 0.001, String(player.pl.pos));
  ck('playerPause：主按钮复原「▶ 播放」', el('btnPP').textContent === '▶ 播放', el('btnPP').textContent);
}

// ─────────── ⑦ 拖动 seek ───────────
{
  player.playerSeek(5);
  ck('playerSeek：pos 落到 5s', player.pl.pos === 5, String(player.pl.pos));
  ck('playerSeek：暂停态不会自动开播', player.pl.playing === false);
  player.playerSeek(999);
  ck('playerSeek：超出时长被钳到 dur', player.pl.pos === player.pl.dur, String(player.pl.pos));
  player.playerSeek(-5);
  ck('playerSeek：负数被钳到 0', player.pl.pos === 0, String(player.pl.pos));
}

// ─────────── ⑧ 播完停在末尾（不是回到 0） ───────────
{
  player.playerSeek(0);
  player.playerPlay();
  const src = H.bufferSources[H.bufferSources.length - 1];
  calls.status.length = 0;
  src.onended();
  ck('播完：pl.pos 停在末尾', player.pl.pos === player.pl.dur, String(player.pl.pos));
  ck('播完：pl.playing=false', player.pl.playing === false);
  ck('播完：playInfo.on=false', player.playInfo.on === false);
  ck('播完：状态栏告知「播放结束」', calls.status[calls.status.length - 1] === '播放结束',
    JSON.stringify(calls.status));
}

// ─────────── ⑨ 从末尾重播 = 从头 ───────────
{
  player.playerReplay();
  ck('playerReplay：pos 归零', player.pl.pos === 0, String(player.pl.pos));
  ck('playerReplay：立即进入播放态', player.pl.playing === true && player.playInfo.on === true);

  // 手动停止：onended 不该再触发"播放结束"（teardown 把 manualStop 置位并摘掉回调）
  calls.status.length = 0;
  player.playerPause();
  ck('手动暂停后 pl.src 已摘除', player.pl.src === null);
}

// ─────────── ⑩ 对外只读：接口面固定 ───────────
{
  const fns = Object.keys(player).filter((k) => typeof player[k] === 'function').sort();
  const want = ['adoptClip', 'configurePlayer', 'plPos', 'playerPause', 'playerPlay', 'playerReplay',
    'playerSeek', 'playerToggle', 'resetClip', 'setPitchTape', 'setPlayRate', 'setPlayUI', 'setView',
    'teardownPlay'];
  ck('导出函数面 = 预期清单（防悄悄多出可写入口）', JSON.stringify(fns) === JSON.stringify(want), JSON.stringify(fns));
  ck('有导出对象状态 pl / playInfo', typeof player.pl === 'object' && typeof player.playInfo === 'object');
  ck('导出倍速状态 playRate / pitchTape（只读绑定，改写走 setter）',
    player.playRate === 1 && player.pitchTape === false, `${player.playRate} / ${player.pitchTape}`);
  ck('RATES 档位清单 = index.html 里的选项（8 档，含 1×）',
    JSON.stringify(player.RATES) === JSON.stringify([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]),
    JSON.stringify(player.RATES));
}

// ─────────── ⑪ 倍速（2026-09-17）───────────
// 两条口径：pitchTape=false 走"变速不变调"(整段重排后播放，速率恒 1)、
//          pitchTape=true 走"磁带式"(原 buffer + playbackRate 重采样)。
// 时间轴（pl.pos/pl.dur/plPos）两种口径下都必须是【原时长】，且按 rate 倍推进。
{
  // 真 buffer（桩的 createBuffer 带 getChannelData）：不变调档要真的重排 PCM
  const SR = 48000, LEN = SR * 4;
  const pcm = fakeCtx.createBuffer(1, LEN, SR);
  const ch = pcm.getChannelData(0);
  for (let i = 0; i < LEN; i++) ch[i] = Math.sin(2 * Math.PI * 440 * i / SR);
  const RCLIP = { name: '倍速片段', buffer: pcm, blob: null, dur: pcm.duration, silent: false };
  player.setView('play');
  player.adoptClip(RCLIP);

  ck('换片段后 pl.dur = buffer 原时长（时间轴口径不随倍速变）', Math.abs(player.pl.dur - 4) < 1e-6, String(player.pl.dur));

  // ② 磁带式：原 buffer + playbackRate
  player.setPlayRate(2);
  player.setPitchTape(true);
  player.playerSeek(1);
  let before = H.bufferSources.length;
  player.playerPlay();
  fakeCtx.currentTime += 1;                 // 播了 1s 实时（时钟在起播后才走）
  let src = H.bufferSources[H.bufferSources.length - 1];
  ck('磁带式：用的是原 buffer（不做任何重排）', src.buffer === pcm);
  ck('磁带式：倍速交给 playbackRate（2× → 2）', src.playbackRate.value === 2, String(src.playbackRate.value));
  ck('磁带式：起播点就是时间轴位置本身（offset=1s）', Math.abs(src.__start.offset - 1) < 1e-6,
    JSON.stringify(src.__start));
  ck('磁带式：播放头按倍速推进（1s 实时 → 时间轴 +2s）', Math.abs(player.plPos() - 3) < 1e-6, String(player.plPos()));

  // ③ 变速不变调：整段重排 + 速率恒 1 + 起播点按倍率换算
  player.setPitchTape(false);
  ck('切口径：正在播 → 就地续播（新建了音源，不回到 0）',
    H.bufferSources.length > before && player.pl.playing === true);
  src = H.bufferSources[H.bufferSources.length - 1];
  ck('变速不变调：换了重排后的 buffer', src.buffer !== pcm && src.buffer.numberOfChannels === 1);
  ck('变速不变调：重排后长度 ≈ 原长×倍率（2× → 一半）', Math.abs(src.buffer.length - LEN / 2) <= 1,
    `${src.buffer.length} vs ${LEN / 2}`);
  ck('变速不变调：播放速率恒为 1（时间轴靠 buffer 本身被拉长/压缩）', src.playbackRate.value === 1,
    String(src.playbackRate.value));
  ck('变速不变调：起播点按倍率换算（时间轴 3s → buffer 内 1.5s）',
    Math.abs(src.__start.offset - 1.5) < 1e-6, JSON.stringify(src.__start));
  ck('变速不变调：时间轴仍是原时长（pl.dur 不变）', Math.abs(player.pl.dur - 4) < 1e-6);

  // ④ 重排缓存：同档位重复起播不重算（0.25× 的重排 buffer 是原长 4 倍，不能每次播都算）
  const cached = src.buffer;
  player.playerPlay();
  ck('同档位重复起播复用同一份重排 buffer（没白算）',
    H.bufferSources[H.bufferSources.length - 1].buffer === cached);

  // ⑤ 暂停：位置按旧倍速结算（4s 实时 × 2 = 8s → 钳到 dur）
  fakeCtx.currentTime += 4;
  player.playerPause();
  ck('暂停：按倍速结算播放头并被 dur 钳住（不会越过末尾）', player.pl.pos === player.pl.dur,
    String(player.pl.pos));

  // ⑥ 改档位：非法值回退 1×；合法值即时生效
  player.setPlayRate(7);
  ck('非法档位回退 1×', player.playRate === 1, String(player.playRate));
  player.setPlayRate(0.5);
  ck('合法档位生效', player.playRate === 0.5);
  player.playerSeek(0);
  player.playerPlay();
  src = H.bufferSources[H.bufferSources.length - 1];
  ck('0.5× + 变速不变调：重排 buffer ≈ 原长×2', Math.abs(src.buffer.length - LEN * 2) <= 2,
    `${src.buffer.length} vs ${LEN * 2}`);
  ck('0.5× + 变速不变调：播放头推进减半（2s 实时 → 时间轴 +1s）',
    (() => { fakeCtx.currentTime += 2; return Math.abs(player.plPos() - 1) < 1e-6; })(), String(player.plPos()));

  // ⑦ 静音时间轴（MIDI 工程）：没有声音可保，一律走磁带档，不白算 4 倍长的空 buffer
  player.playerPause();
  const MCLIP = { name: 'MIDI 工程', buffer: pcm, blob: null, dur: pcm.duration, silent: true };
  player.adoptClip(MCLIP);
  player.setPlayRate(0.25);
  player.playerPlay();
  src = H.bufferSources[H.bufferSources.length - 1];
  ck('★静音时间轴：不重排（没有音高可保，重排只是白烧内存）',
    src.buffer === pcm && src.playbackRate.value === 0.25, String(src.playbackRate.value));

  // ⑧ 琴声时值缩放：播放中随倍速、停播回 1（琴声在钢琴块里按时间轴触发）
  ck('播放中：把倍速转告琴声模块', calls.noteRate[calls.noteRate.length - 1] === 0.25,
    JSON.stringify(calls.noteRate));
  player.playerPause();
  ck('停播：琴声回到实时口径 1', calls.noteRate[calls.noteRate.length - 1] === 1,
    JSON.stringify(calls.noteRate));

  // 复位，别把倍速状态留给后面的用例
  player.setPlayRate(1);
  player.setPitchTape(false);
  player.resetClip();
}

console.log(`[player] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
