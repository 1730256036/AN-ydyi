// ============================================================
// test/app-player.mjs —— 播放器引擎特征测试（node 直跑，无浏览器）
// 与 app-rec-machine.mjs 同一目的：给 app.mjs 的第二块裸奔区（播放器，160 行）建网，
// 只钉现状、不改行为，供后续结构重构当回归护栏。
//
// 入口走【MIDI 导入】：它是同步可确定的一条路（parseSMF 是纯函数、importMidiNotes 不触分析），
// 不像导入音频要走 decodeAudioData + 后台整段分析（node 里没有 Worker）。
// ============================================================
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installStubs } from './_harness.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let fails = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { fails++; console.error('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[app-player] 播放器特征测试');

const H = installStubs();
await import('../app.mjs');

const el = (id) => H.byId(id);
// 「导入即播」默认勾选会让 MIDI 导入直接开播（2026-09-19 修的正确行为，
// 由 scope-guards 钉住）；本文件测的是传输机构（播放/暂停/拖动/重播），
// 先关掉它，保证每一段都从「停止态」出发。
el('autoPlayOnImport').checked = false;
const ctx = () => H.contexts[0];
const lastSrc = () => H.bufferSources[H.bufferSources.length - 1];
const ui = () => ({
  pp: el('btnPP').textContent,
  name: el('clipName').textContent,
  pCur: el('pCur').textContent,
  pTot: el('pTot').textContent,
  status: el('recStatus').textContent,
  playBandShown: el('playCtrls').style.display !== 'none',
  liveBandShown: el('liveCtrls').style.display !== 'none',
});

// ---------- 导入一个真实 MIDI（demo/ 里的第一首）----------
{
  const dir = ROOT + 'demo';
  const mid = fs.readdirSync(dir).filter((f) => f.endsWith('.mid')).sort()[0];
  const buf = fs.readFileSync(dir + '/' + mid);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = H.fire('fileMidi', 'change', {
    target: { files: [{ name: mid, arrayBuffer: async () => ab }], value: '' },
  });
  ck('选 MIDI 文件：不抛异常', r.ok, r.error && r.error.message);
  // 等久一点：importMIDI 之后还会异步触发一次自动存档，本环境没有 IndexedDB 会失败并写状态栏。
  // 不等它落地，后面几条断言会被这条无关的状态文字盖掉（踩过一次）。
  await H.sleep(400);
  const u = ui();
  ck('导入 MIDI：切到播放器视图（新建/导出那条带出现）', u.playBandShown && !u.liveBandShown);
  ck('导入 MIDI：片段名带「· 钢琴块」后缀', /钢琴块/.test(u.name), u.name);
  ck('导入 MIDI：总时长已显示且不是 0:00', u.pTot !== '' && u.pTot !== '0:00', u.pTot);
  ck('导入 MIDI：主按钮是「▶ 播放」（导入即播已关，不自动播）', u.pp === '▶ 播放', '实际=' + JSON.stringify(u.pp));
  ck('导入 MIDI：当前时间归零（fmtBar 带十分位）', u.pCur === '0:00.0', u.pCur);
}

// ---------- 播放 ----------
{
  const r = H.click('btnPP');
  const u = ui();
  ck('播放：不抛异常', r.ok, r.error && r.error.message);
  ck('播放：按钮变「⏸ 暂停」', u.pp === '⏸ 暂停', u.pp);
  ck('播放：真的创建了 buffer source 并启动', H.bufferSources.length === 1);
  ck('播放：没有"播放失败"类提示', !/播放失败|无法播放/.test(u.status), u.status);
}

// ---------- 暂停：播放位置必须按音频时钟推进 ----------
{
  ctx().currentTime = 1.5;                 // 模拟播了 1.5 秒
  H.click('btnPP');
  const u = ui();
  ck('暂停：按钮变回「▶ 播放」', u.pp === '▶ 播放', u.pp);
  ck('暂停：当前时间推进到 1.5s（不是停在 0:00.0）', u.pCur !== '0:00.0', u.pCur);
  ck('暂停：源被停止（onended 被摘掉，避免误触发"播放结束"）',
    H.bufferSources[H.bufferSources.length - 1].onended === null);
}

// ---------- 拖动时间线 seek ----------
{
  const before = el('pCur').textContent;
  // ⚠️ 真实的拖动序列是 pointerdown → input… → change/pointerup：
  //    input 里寻址有 45ms 节流，change 里只在 seekDragging(由 pointerdown 置位) 时才生效。
  //    少了 pointerdown 或不等过节流窗口，第二次拖动会被静默吞掉（我第一版就踩了这个）。
  const drag = async (val) => {
    H.fire('pSeek', 'pointerdown');
    el('pSeek').value = String(val);
    H.fire('pSeek', 'input');
    H.fire('pSeek', 'change');
    await H.sleep(60);                     // 跨过 45ms 节流窗口
  };
  await drag(0);                           // 拖到起点
  ck('拖到起点：当前时间回到 0:00.0', el('pCur').textContent === '0:00.0', el('pCur').textContent);
  ck('拖到起点：与拖动前读数不同（确实生效了）', before !== el('pCur').textContent);

  await drag(1000);                        // 拖到末尾
  ck('拖到末尾：提示「已到末尾」而不是自动从头重播', /已到末尾/.test(el('recStatus').textContent),
    el('recStatus').textContent);
  ck('拖到末尾：按钮仍是「▶ 播放」（处于暂停态）', el('btnPP').textContent === '▶ 播放', el('btnPP').textContent);
}

// ---------- 重播 ----------
{
  H.click('btnReplay');
  ck('重播：从 0 开始并处于播放态', el('btnPP').textContent === '⏸ 暂停' && el('pCur').textContent === '0:00.0',
    el('btnPP').textContent + ' / ' + el('pCur').textContent);
}

// ---------- 播完停在末尾（onended 且非手动停止）----------
{
  const src = lastSrc();
  src.onended();
  await H.sleep(20);
  const u = ui();
  ck('播完：按钮回到「▶ 播放」', u.pp === '▶ 播放', u.pp);
  ck('播完：状态栏提示播放结束', /播放结束/.test(u.status), u.status);
  ck('播完：时间停在末尾（不是留在中途）', u.pCur === u.pTot, u.pCur + ' vs ' + u.pTot);
}

// ---------- 新建：回到录音机视图、清空片段 ----------
{
  H.click('btnNew');
  const u = ui();
  ck('新建：切回录音机视图', u.liveBandShown && !u.playBandShown);
  ck('新建：片段名清空', u.name === '', u.name);
  ck('新建：主按钮回到「● 开始录音」', el('btnRec').textContent === '● 开始录音', el('btnRec').textContent);
}

console.log(fails ? `\n[app-player] ${fails} 项失败` : '\n[app-player] 全部通过');
process.exit(fails ? 1 : 0);
