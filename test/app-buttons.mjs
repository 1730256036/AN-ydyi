// ============================================================
// test/app-buttons.mjs —— 「按钮不许静默无反应」元测试（node 直跑，无浏览器）
//
// 由来：2026-09-15「点击录制动画没有任何反应」。根因是 capStart 里一行
// 不在 try 里的 TypeError（把 AudioNode 当 MediaStream 调 getAudioTracks），
// 异常顺着点击处理函数冒出去 —— 界面零反馈、日志零记录、按钮文字不变。
// 这类失败【最难查】，因为它看起来像"按钮没接上事件"。
//
// 本测试把 index.html 里的按钮全部抓出来逐个点，断言两件事：
//   ① 点击不得抛异常（能直接抓到上面那类 TypeError）
//   ② 点击必须产生可观测结果（UI 指纹变化 / 日志 / 下载），
//      否则必须出现在 ALLOW 白名单里并写明原因
// 第三条（防白名单腐烂）：白名单里的按钮必须【真的没反应】——
//   一旦它哪天开始有反应了，测试也会提醒你把白名单项删掉。
// ============================================================
import { installStubs } from './_harness.mjs';

let fails = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[app-buttons] 按钮反应元测试');

// 白名单：在此场景下点了确实"什么都不改"的按钮。每条必须写清原因——
// 白名单不是垃圾桶，它是"这些静默是设计使然"的书面依据。
const ALLOW = new Map([
  // 一、按钮在当前视图里本来就是隐藏的，点击被正确的状态守卫挡下
  ['btnAud', 'idle 态下 updateTransportUI 把"试听"设为 display:none；startListening 有 recState 守卫'],
  ['btnSaveRec', '同上隐藏；stopRecording 有 `!recorder || idle` 守卫'],
  ['btnPP', 'live 视图下播放器整条隐藏；playerPlay 有 `!pl.clip` 守卫'],
  ['btnReplay', '同上（没有片段）'],
  // 二、守卫依赖"已有录音会话"，本测试跑到它时录音已在进行
  ['btnPermit', '引导层的"开始录音"：此时已在录音中，startRecording 的 `recState!==idle` 守卫挡下'],
  // 三、效果是异步的，超出本测试 15ms 的观测窗口
  ['btnCalib', '底噪校准要采样 20×40ms≈800ms 才回写状态栏，15ms 窗口内看不到'],
  ['btnRvcRestore', '没做过变声 → 无原始音频可还原，守卫直接 return'],
  // 四、（「面板关闭类 ppClose/lpClose 点了无反应」两条：给桩补上
  //      "从 index.html 播种 class"之后，#ppPanel/#logPanel 初始就带 .hidden，
  //      这两个"关闭"按钮点击会真的改 classList = 有可观测反应，留着会被反向断言判为腐烂。）
]);

const H = installStubs();
await import('../app.mjs');

const ids = H.allButtonIds();
ck('从 index.html 抓到按钮（> 20 个）', ids.length > 20, '抓到 ' + ids.length + ' 个');

const threw = [];
const silent = [];
for (const id of ids) {
  const beforeHash = H.uiHash();
  const beforeObs = H.observable();
  const listeners = H.byId(id).__listeners.click || [];
  let bad = null;
  for (let n = 0; n < Math.max(1, listeners.length); n++) {
    const r = H.click(id, n);
    if (!r.ok) bad = r.error;
  }
  await H.sleep(15);
  const afterHash = H.uiHash();
  const afterObs = H.observable();
  if (bad) threw.push(id + ': ' + (bad.message || bad));
  else if (beforeHash === afterHash && H.observableDiff(beforeObs, afterObs).length === 0) silent.push(id);
}

ck(`全部 ${ids.length} 个按钮：点击均不抛异常`, threw.length === 0, threw.join(' | '));

const unexpected = silent.filter((id) => !ALLOW.has(id));
ck('无"点了完全没反应"的按钮（未在白名单里的）',
  unexpected.length === 0, onlyIfAny(unexpected));
function onlyIfAny(a) { return a.length ? '意外静默: ' + a.join(', ') : ''; }

// 反向：白名单不许腐烂。列进去的必须真的静默，否则提醒删除。
const stale = [...ALLOW.keys()].filter((id) => silent.indexOf(id) === -1).filter((id) => ids.indexOf(id) !== -1);
ck('白名单无腐烂项（列进去的确实仍是静默的）', stale.length === 0,
  stale.length ? '已不再静默，请从白名单删除: ' + stale.join(', ') : '');

// 白名单里的 id 必须真实存在于 index.html（防写错名字导致白名单形同虚设）
const ghost = [...ALLOW.keys()].filter((id) => ids.indexOf(id) === -1);
ck('白名单 id 都在 index.html 里存在', ghost.length === 0, ghost.join(', '));

console.log(silent.length ? `      静默按钮（全部已白名单）: ${silent.join(', ')}` : '      （没有任何静默按钮）');
console.log(fails ? `\n[app-buttons] ${fails} 项失败` : '\n[app-buttons] 全部通过');
process.exit(fails ? 1 : 0);
