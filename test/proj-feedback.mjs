// test/proj-feedback.mjs —— 存档 / 导入路径的问题回归守卫（2026-09-22）
//
// 为什么单独一个文件：这一批修的全是"静默失败 / 文案与实现不符"，它们没有观感可看，
// 只能靠断言钉住。五条独立不变量：
//   ① parseProjectFile 遇到坏的内嵌音频，必须把原因带出来（不再静默降级成"无音频"）
//   ② 「存当前」按钮的可用性必须跟随当前工程（只在"打开面板那一刻"刷一次是不够的）
//   ③ 导入音频的状态文案必须跟实际一致（没勾「导入即播」就不能说"正在播放"）
//   ④ 录音/暂停/试听中被丢弃时，用户最终看到的状态栏必须带上这句提示
//   ⑤ 打开存档 / 导出失败必须在状态栏说出来（只有 .then、没有 .catch 就会静默）
//
// 副产物：这个文件顺带覆盖了 archives 接口的**成功路径**（填补 test 目录对 file-store 的守卫缺口）。
// 做法是在测试内替换 globalThis.fetch —— harness 默认让所有 fetch 直接失败（不真发包），
// 但存档链路也吃同一个 fetch，所以默认状态下"存档成功"这条分支在 node 里永远走不到。
//
// ⚠ 状态栏会被多次覆盖（导入 → 后台整段分析 → …），所以"某句提示出现过"不能靠读最终值断言，
//   本文件用 setStatus 的写入序列（写日志式间谍）来判断。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installStubs } from './_harness.mjs';
import { archiveFileName } from '../proj/mirror.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

let pass = 0, fail = 0;
const ck = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
};

const H = installStubs();
await import('../app.mjs');                       // 走真实接线
const projMod = await import('../proj/project.mjs');
const panel = await import('../app/proj-panel.mjs');
const el = (id) => H.byId(id);

console.log('[proj-feedback] 存档/导入路径守卫');

// ---------- 状态栏写入间谍：记录每一次 setStatus 的文本 ----------
const statusWrites = [];
{
  const st = el('recStatus');
  let cur = st.textContent;
  Object.defineProperty(st, 'textContent', {
    configurable: true,
    get: () => cur,
    set: (v) => { cur = v; statusWrites.push(String(v)); },
  });
}
const statusSaw = (re) => statusWrites.some((t) => re.test(t));
const statusReset = () => { statusWrites.length = 0; };

// ============================================================
// ① parseProjectFile：坏音频要把原因带出来（不再静默降级）
// ============================================================
console.log('\n-- ① 内嵌音频解析失败必须可追踪 --');
{
  const base = { magic: 'ydyi-project', version: 1, id: 'x1', name: '纯曲线' };

  const noAudio = projMod.parseProjectFile(JSON.stringify(base));
  ck('没有 audioDataUrl：audioError = null（"本来没音频"不算失败）',
    noAudio.audioError === null, String(noAudio.audioError));
  ck('没有 audioDataUrl：includeAudio = false', noAudio.includeAudio === false);

  const badB64 = projMod.parseProjectFile(JSON.stringify({ ...base, audioDataUrl: 'data:audio/wav;base64,!!!!' }));
  ck('坏 base64：工程仍能解析出来（不抛异常，曲线照旧可看）',
    !!badB64.proj && badB64.proj.name === '纯曲线');
  ck('坏 base64：includeAudio = false', badB64.includeAudio === false);
  ck('★坏 base64：audioError 带出原因（此前是空 catch，完全静默）',
    typeof badB64.audioError === 'string' && badB64.audioError.length > 0, String(badB64.audioError));

  const noPrefix = projMod.parseProjectFile(JSON.stringify({ ...base, audioDataUrl: 'nonsense' }));
  ck('★畸形 data URL（连 data: 前缀都没有）：同样带出 audioError',
    typeof noPrefix.audioError === 'string' && noPrefix.audioError.length > 0, String(noPrefix.audioError));
}

// ============================================================
// ② 「存当前」按钮跟随当前工程（app 侧 projSetCurrentUI 必须补刷）
// ============================================================
console.log('\n-- ② 「存当前」可用性跟随工程 --');
{
  ck('初始无工程 → 「存当前」置灰', el('ppSaveCur').disabled === true, String(el('ppSaveCur').disabled));

  // 走真实入口：导入一个内置 demo MIDI（parseSMF 是纯函数，node 里能确定跑完）
  const dir = ROOT + 'demo';
  const mid = fs.readdirSync(dir).filter((f) => f.endsWith('.mid')).sort()[0];
  const buf = fs.readFileSync(dir + '/' + mid);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  H.fire('fileMidi', 'change', { target: { files: [{ name: mid, arrayBuffer: async () => ab }], value: '' } });
  await H.sleep(400);                       // 等自动存档那条异步链落地

  ck('★导入 MIDI 后「存当前」变可用（此前面板没打开过就永远不会刷）',
    el('ppSaveCur').disabled === false, String(el('ppSaveCur').disabled));
  ck('切到了播放器视图（前置条件成立）', el('playCtrls').style.display !== 'none');
}

// ============================================================
// ③ 导入文案必须跟实际一致
// ============================================================
console.log('\n-- ③ 导入文案不说谎 --');
{
  el('autoPlayOnImport').checked = false;    // 取消「导入即播」
  statusReset();
  const r = H.fire('fileAudio', 'change', { target: { files: [H.fakeFile('不自动播.wav')], value: '' } });
  ck('导入音频：不抛异常', r.ok, r.error && r.error.message);
  await H.sleep(80);

  ck('★未勾「导入即播」：写入过的那条导入提示不再谎称"正在播放"',
    !statusSaw(/已导入[^]*正在播放/), JSON.stringify(statusWrites.slice(0, 4)));
  ck('未勾「导入即播」：改为"已就绪（点 ▶ 播放）"',
    statusSaw(/已就绪（点 ▶ 播放）/), JSON.stringify(statusWrites.slice(0, 4)));
}

// ============================================================
// ④ 录音被丢弃时，用户最终看到的状态栏要带上这句
// ============================================================
console.log('\n-- ④ 丢弃未保存录音要有可见提示 --');
{
  H.click('btnRec');
  await H.sleep(1200);                       // startRecording 内含 autoCalib（20×40ms）
  ck('录音已开始（前置条件成立）', el('recStatus').textContent.indexOf('正在播放') < 0);

  statusReset();
  H.fire('fileAudio', 'change', { target: { files: [H.fakeFile('新片段.wav')], value: '' } });
  await H.sleep(80);                         // decodeBuf → loadClip 是异步链

  ck('★录音中被丢弃：状态栏写入过「已丢弃上一段未保存的录音」',
    statusSaw(/已丢弃上一段未保存的录音/), JSON.stringify(statusWrites.slice(0, 6)));
  ck('提示是拼在"已导入…"那条里的（不是另外弹一句被覆盖）',
    statusSaw(/已导入[^]*已丢弃上一段未保存的录音/), JSON.stringify(statusWrites.slice(0, 6)));
  ck('日志同时留痕（原有行为保留）', H.logs.some((e) => /已丢弃未保存的录音会话/.test(JSON.stringify(e))));
}

// ============================================================
// ⑤ archives 接口的成功路径 + 打开失败要有反馈
//     （顺带补上 test 目录对 file-store 的守卫缺口）
// ============================================================
console.log('\n-- ⑤ 打开存档：成功路径 + 失败要有反馈 --');
{
  const ID = 'abc12345';
  const NAME = '测试存档';
  const FILE = archiveFileName(ID, NAME);
  ck('文件名由真实规则拼出（后缀能被 id 定位）', /_abc12345\.ydyi$/.test(FILE), FILE);

  const projText = JSON.stringify({
    magic: 'ydyi-project', version: 1, id: ID, name: NAME,
    createdAt: 1, duration: 1.5, source: projMod.SOURCE_IMPORT, kind: projMod.KIND_AUDIO,
    audioDataUrl: 'data:audio/wav;base64,AAAA',            // 合法 base64（内容无所谓，解码走桩）
    analysis: { sr: 48000, hopMs: 23, frames: [{ t: 0, voiced: true, freq: 440 }] },
  });

  const J = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => obj.__text });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/archives-meta')) {
      return J({ files: [{ id: ID, name: NAME, createdAt: 1, kind: projMod.KIND_AUDIO, source: projMod.SOURCE_IMPORT, duration: 1.5, hasAudio: true, noteCount: 0, size: projText.length }] });
    }
    if (u === '/api/archives') return J({ files: [{ file: FILE }] });
    if (u.startsWith('/api/archives/')) return { ok: true, status: 200, json: async () => ({}), text: async () => projText };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  panel.projTogglePanel(true);
  await H.sleep(40);
  const rows = (el('ppList').children || []).filter((c) => /pp-item/.test(c.className || ''));
  ck('列表能渲染出行（archives 成功路径在 node 里被跑通）', rows.length === 1, String(rows.length));
  const openBtn = rows.length ? (rows[0].children || []).find((c) => c.textContent === '打开') : null;
  ck('行里找得到「打开」按钮', !!openBtn);

  if (openBtn) {
    statusReset();
    try { openBtn.__listeners.click[0](); } catch (e) { ck('打开存档：不抛异常', false, e.message); }
    await H.sleep(80);
    ck('★打开成功：状态栏报「已打开」', statusSaw(/已打开「测试存档」/), JSON.stringify(statusWrites.slice(0, 4)));
    ck('打开成功：状态行给出了帧数（工程就绪）', /工程就绪/.test(el('projStatus').textContent), el('projStatus').textContent);
  }

  // —— 失败分支：服务不可用 ——
  globalThis.fetch = () => Promise.reject(new Error('no local bridge'));
  statusReset();
  if (openBtn) {
    try { openBtn.__listeners.click[0](); } catch (e) { /* 由断言判定 */ }
    await H.sleep(80);
    ck('★打开失败（服务不可用）：状态栏说出来，不再"点了没反应"',
      statusSaw(/^打开失败：/), JSON.stringify(statusWrites.slice(0, 4)));
    ck('失败时不留下"正在分析"之类的半截态', !statusSaw(/正在分析整段音高/), JSON.stringify(statusWrites.slice(0, 4)));
  }
}

// ============================================================
// ⑥ 导出失败要有反馈（projectToFile 会因 FileReader 出错而 reject）
// ============================================================
console.log('\n-- ⑥ 导出失败要有反馈 --');
{
  // 装一个"必定失败"的 FileReader：真实场景是音频读取出错（文件损坏/内存不足）
  globalThis.FileReader = class {
    readAsDataURL() { setTimeout(() => { if (this.onerror) this.onerror(); }, 0); }
  };
  statusReset();
  const r = H.click('ppExportY');
  ck('点「导出」：不抛异常（异常走 promise 的 catch）', r.ok, r.error && r.error.message);
  await H.sleep(60);
  ck('★导出失败：状态栏说出来（此前没有 .catch，点了没任何反应）',
    statusSaw(/^导出失败：/), JSON.stringify(statusWrites.slice(0, 4)));
}

console.log(`\n[proj-feedback] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
