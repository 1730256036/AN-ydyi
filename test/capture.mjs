// test/capture.mjs —— app/capture.mjs（纯净模式 + 录屏域）的特征测试
//
// 用 _harness 装浏览器桩 → 动态 import app.mjs（真实启动流程）→ 真的"点按钮"。
// 观察方式：既有外部可见效果（按钮文案 / body class / 下载次数），也有域模块的
// 只读导出（pureOn / capIsRecording()）——后者正是 ① 状态收敛想要的"状态可观测但不可改"。

import { installStubs } from './_harness.mjs';

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
await import('../app.mjs');
const cap = await import('../app/capture.mjs');
const anim = (await import('../anim/registry.mjs')).default;

const el = (id) => H.byId(id);

console.log('[capture] 纯净模式 / 录屏域特征测试');

// ─────────── ① 初始状态 ───────────
{
  ck('初始 pureOn=false', cap.pureOn === false, String(cap.pureOn));
  ck('初始未在录制', cap.capIsRecording() === false);
  ck('#btnRecord 初始文案「⏺ 录制动画」', el('btnRecord').textContent === '⏺ 录制动画', el('btnRecord').textContent);
  ck('#pbRec 初始文案「⏺ 录制」', el('pbRec').textContent === '⏺ 录制', el('pbRec').textContent);
  ck('body 初始无 pure 类', !document.body.classList.contains('pure'));
  ck('#pureBar 初始带 hidden（桩从 index.html 播种）', el('pureBar').classList.contains('hidden'));
}

// spy 模板：验证 syncTemplateChrome 是否把"藏角标"广播给了所有模板
const chromeCalls = [];
anim.register({ id: '__chrome_spy__', name: 'spy', kind: 'full', frame() {}, setChromeHidden(v) { chromeCalls.push(v); } });
ck('spy 模板已注册（前置）', anim.list().some((t) => t && t.id === '__chrome_spy__'));

// ─────────── ② 进入纯净模式 ───────────
{
  const r = H.click('btnPure');
  ck('点 #btnPure 不抛异常', r.ok, r.error && r.error.message);
  ck('进入纯净：pureOn=true', cap.pureOn === true);
  ck('进入纯净：body 带 pure 类（CSS 靠它隐藏全部界面）', document.body.classList.contains('pure'));
  ck('进入纯净：#pureBar 去掉 hidden', !el('pureBar').classList.contains('hidden'));
  ck('进入纯净：#pureBar 亮出 shown', el('pureBar').classList.contains('shown'));
  ck('进入纯净：广播 setChromeHidden(true)（画布内角标一起藏）', chromeCalls.includes(true), JSON.stringify(chromeCalls));
}

// ─────────── ③ Esc 退出（document 级监听） ───────────
{
  const e1 = H.docFire('keydown', { key: 'Escape' });
  ck('document 上确实挂了 keydown 监听', e1.ok, e1.error && e1.error.message);
  ck('Esc → 退出纯净：pureOn=false', cap.pureOn === false);
  ck('Esc → body 去掉 pure 类', !document.body.classList.contains('pure'));
  ck('Esc → 广播 setChromeHidden(false)（角标恢复）', chromeCalls[chromeCalls.length - 1] === false);
}

// ─────────── ④ 全屏态下的 Esc 不该抢浏览器的手 ───────────
{
  H.click('btnPure');
  H.setFullscreen({});                       // 假装正处于全屏
  H.docFire('keydown', { key: 'Escape' });
  ck('全屏中的 Esc 不主动退纯净（交给浏览器退全屏）', cap.pureOn === true, String(cap.pureOn));
  H.setFullscreen(null);
  H.docFire('fullscreenchange', {});
  ck('退出全屏 → 一并退出纯净模式（否则界面全没了又不在全屏，很迷惑）', cap.pureOn === false);
}

// ─────────── ⑤ 悬浮条「退出」按钮 ───────────
{
  H.click('btnPure');
  ck('前置：已进纯净', cap.pureOn === true);
  const r = H.click('pbExit');
  ck('点悬浮条「⛶ 退出」不抛异常', r.ok, r.error && r.error.message);
  ck('悬浮条退出 → pureOn=false', cap.pureOn === false);
  ck('悬浮条退出 → #pureBar 回到 hidden', el('pureBar').classList.contains('hidden'));
}

// ─────────── ⑥ togglePure 是切换语义 ───────────
{
  cap.togglePure(); ck('togglePure() → 进', cap.pureOn === true);
  cap.togglePure(); ck('togglePure() → 出', cap.pureOn === false);
}

// ─────────── ⑦ 录制：状态、UI、广播 ───────────
{
  H.click('btnPure');                        // 在纯净模式下录（顺便验证提示回显）
  ck('前置：已进纯净模式', cap.pureOn === true);

  const before = H.downloadCount;
  const r = H.click('btnRecord');
  ck('点 #btnRecord 不抛异常（2026-09-15 曾静默失败过一次）', r.ok, r.error && r.error.message);
  ck('录制中：capIsRecording=true', cap.capIsRecording() === true);
  ck('录制中：#btnRecord 文案变「■ 停止录制」', el('btnRecord').textContent === '■ 停止录制', el('btnRecord').textContent);
  ck('录制中：#pbRec 文案变「■ 停止」', el('pbRec').textContent === '■ 停止', el('pbRec').textContent);
  ck('录制中：#pureBar 带 rec 类（悬浮条常驻，否则找不到停止）', el('pureBar').classList.contains('rec'));
  ck('录制中：#pbClock 带 on（计时器已启动）', el('pbClock').classList.contains('on'));
  ck('录制中：广播 setChromeHidden(true)', chromeCalls[chromeCalls.length - 1] === true);
  ck('capTick() 在未桥接音频时安全空跑', (() => { try { cap.capTick(); return true; } catch (e) { return false; } })());

  // ⑧ 停止 → 收尾异步 → 下载
  const mr = H.MediaRecorder.last;
  mr.__chunk(2048);
  H.click('btnRecord');
  await H.sleep(80);
  ck('停止后：capIsRecording=false', cap.capIsRecording() === false);
  ck('停止后：#btnRecord 文案复原', el('btnRecord').textContent === '⏺ 录制动画', el('btnRecord').textContent);
  ck('停止后：#pureBar 的 rec 类被摘掉', !el('pureBar').classList.contains('rec'));
  ck('停止后：真的触发了下载', H.downloadCount > before, H.downloadCount + ' vs ' + before);
  // ⚠️ 此刻仍在纯净模式里，所以 hide 仍应为 true —— syncTemplateChrome 的口径是
  // `pureOn || 录制中`，不是"停止录制就必然恢复"。第一版断言我写反了，是测试的错。
  ck('停止后仍在纯净模式：画布角标保持隐藏（hide = pureOn || 录制中）',
    chromeCalls[chromeCalls.length - 1] === true, JSON.stringify(chromeCalls.slice(-3)));
  ck('录完的提示会回显到悬浮条（纯净模式下传输条是隐藏的）',
    /已保存|已导出/.test(el('pbHint').textContent), el('pbHint').textContent);
  H.click('pbExit');
  ck('退出纯净（且已不在录制）→ 广播 setChromeHidden(false)，角标恢复',
    chromeCalls[chromeCalls.length - 1] === false, JSON.stringify(chromeCalls.slice(-3)));
}

// ─────────── ⑨ 对外只读：接口面固定，没有可写容器 ───────────
{
  const fns = Object.keys(cap).filter((k) => typeof cap[k] === 'function').sort();
  const want = ['bindCapture', 'capIsRecording', 'capStart', 'capStop', 'capTick', 'capToggle',
    'configureCapture', 'enterPure', 'exitPure', 'syncTemplateChrome', 'togglePure'];
  ck('导出函数面 = 预期清单（防悄悄多出可写入口）', JSON.stringify(fns) === JSON.stringify(want), JSON.stringify(fns));
  ck('没有导出内部状态容器', cap.capRec === undefined && cap.capDest === undefined && cap.capMicGain === undefined && cap.capChunks === undefined);
  ck('唯一导出的状态是只读 pureOn', typeof cap.pureOn === 'boolean');
}

console.log(`[capture] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
