// ============================================================
// test/scope-guards.mjs —— 「控件作用域」回归守卫（2026-09-16 建立）
//
// 由来：一次全项目审计发现一批"只在特定模式才有用的选项/按钮，却在别的模式照样
// 出现、照样能改"的错配，逐个修完之后把不变量钉在这里，防止日后重构又漂回去：
//   ① 拒绝麦克风 → 引导蒙层不退 → 全站被 z-index:50 的遮罩锁死
//   ② 「原声」= 全局播放音量，却藏在钢琴块模板面板里
//   ③ 变声/导出 在 MIDI 工程（静音时间轴）上照样可用
//   ④ "AI转谱"按钮的显示条件按构建那一刻定死 → 与当前工程不一致
//      （2026-09-19 起按钮本体搬进主界面 #playCtrls，显隐机制不变）
//   ⑤ AI 转谱后曲线类模板拿不到工程帧（数据源被换掉）
//   ⑥ 回声泄漏到暂停/试听
//   ⑦ 播放视图里改灵敏/收音/自动不重算工程 + 假校准
//   ⑧「导入即播」在播放视图被隐藏却仍决定导入行为
//   ⑨「＋新建」不复位音域读数
//   ⑩ 纯净模式漏隐藏曲库浮层
//   ⑪ 三档音区按钮（未实现）能点能高亮却零效果
//
// 两类断言：
//   ① 行为守卫：用 _harness 桩真跑（拒绝麦克风、导入 MIDI 后的控件可用性）
//   ② 结构守卫：读源码/HTML 文本。node 里没有 Worker / 真 IDB，录音落库与离线分析
//      这条链跑不起来，只能钉"代码里必须存在那条守卫"。这类断言刻意写窄：只钉意图与
//      关键片段，不做整行精确匹配（否则每改一次注释就红）。
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

console.log('[scope-guards] 控件作用域不变量');

// ============================================================
// ① 行为守卫：麦克风被拒 → 引导蒙层必须收起（否则整站点不到任何东西）
// ============================================================
const H = installStubs();
// 在 import app.mjs 之前把 getUserMedia 换成"拒绝授权"（installStubs 的 navigator
// 是 configurable 的，可以整块换掉）
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => { throw new Error('NotAllowedError'); } } },
  configurable: true,
});
await import('../app.mjs');
const el = (id) => H.byId(id);

{
  ck('初始：引导蒙层是显示的（还没收起来）', !el('overlay').classList.contains('hidden'));
  const r = H.click('btnPermit');                 // 引导层上的"开始录音"
  ck('拒绝麦克风：点击不抛异常', r.ok, r.error && r.error.message);
  await H.sleep(50);
  ck('★拒绝麦克风：引导蒙层必须收起（蒙层 z-index:50 盖全屏，不退=导入/存档/日志全点不到）',
    el('overlay').classList.contains('hidden'));
  ck('拒绝麦克风：状态栏说明了原因且不再喧宾夺主',
    /无法开始录音/.test(el('recStatus').textContent), el('recStatus').textContent);
  ck('拒绝麦克风：没有卡在半录音态（主按钮回到「● 开始录音」）',
    el('btnRec').textContent === '● 开始录音', el('btnRec').textContent);
}

// ============================================================
// ② 行为守卫：MIDI 工程（静音时间轴）上，需要真实音频的控件必须关掉
//    入口走 MIDI 导入：parseSMF 是纯函数，node 里可确定跑完（同 test/app-player.mjs）
// ============================================================
{
  const dir = ROOT + 'demo';
  const mid = fs.readdirSync(dir).filter((f) => f.endsWith('.mid')).sort()[0];
  const buf = fs.readFileSync(dir + '/' + mid);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  H.fire('fileMidi', 'change', { target: { files: [{ name: mid, arrayBuffer: async () => ab }], value: '' } });
  await H.sleep(400);                              // 等自动存档那条异步链落地（会写状态栏）

  ck('导入 MIDI：已切到播放器视图', el('playCtrls').style.display !== 'none');
  ck('★MIDI 工程：「导出」置灰（静音时间轴没有声音可导出）',
    el('btnExport').disabled === true, 'disabled=' + String(el('btnExport').disabled));
  ck('★MIDI 工程：「变声」不出现（原先只看 appView，会把静音编码成 wav 送桥）',
    el('btnRvc').style.display === 'none', String(el('btnRvc').style.display));

  // 「AI转谱」2026-09-19 起在主界面 #playCtrls（与「存MIDI」同批搬出钢琴块面板）：
  // 显隐仍交给 syncAnimBarDeps 按工程补刷——MIDI 工程（静音时间轴）必须隐藏
  const aiBtn = el('btnAiTrans');
  ck('主界面建出了「AI转谱」按钮（显隐交给 syncAnimBarDeps，不再按构建时刻定死）', !!aiBtn);
  ck('★MIDI 工程：「AI转谱」隐藏', !!aiBtn && aiBtn.style.display === 'none',
    aiBtn && String(aiBtn.style.display));
  ck('★钢琴块面板里不再有「存MIDI/AI转谱」按钮（已搬主界面）',
    !(el('animBar').children || []).some((e) => /存MIDI|AI转谱/.test(e.textContent || '')));
  // 不设钢琴声开关勾选框：琴声恒开，静音走「琴声」音量
  ck('★钢琴块面板里不再有「钢琴声」勾选框',
    !(el('animBar').children || []).some((e) => /钢琴声/.test(e.textContent || '')));
  // 回声/落速只对"正在录音"有意义（echoFeed 注入守卫就是 recState==='rec'）：
  // 非录音态（此处 MIDI 导入后是播放视图）必须隐藏。
  // ⚠ 桩的 textContent 不聚合子文本节点 → 用 title 定位这个 label（其文字「回声」
  //   是 createTextNode 挂的，桩上读不到）。
  const echoLbl = (el('animBar').children || []).find((e) => /录音时吹一个音/.test(e.title || ''));
  ck('非录音态：钢琴块面板里建出了「回声」勾选', !!echoLbl);
  ck('★非录音态：「回声」勾选隐藏（录音中才出现）', !!echoLbl && echoLbl.style.display === 'none',
    echoLbl && String(echoLbl.style.display));
  ck('★钢琴块面板里不再有「原声」滑杆（它已搬成全局控件）',
    !(el('animBar').children || []).some((e) => /原声/.test(e.textContent || '')));

  // 倍速（2026-09-17）：MIDI 工程是静音时间轴，声音由琴声模块按音符合成（固定音高）
  // → 勾「变调」听感毫无变化，属于"能点却没效果"的控件，必须藏掉；而"倍速"本身
  // 对 MIDI 有意义（音符按播放时间轴触发，慢放照样有用）→ 保留。
  ck('★MIDI 工程：「变调」开关隐藏（合成琴声的音高不随倍速变，勾不勾一个样）',
    el('playTapeWrap').style.display === 'none', JSON.stringify(el('playTapeWrap').style.display));
  ck('MIDI 工程：「倍速」仍然可用（音符按播放时间轴触发，慢放/快放都有意义）',
    el('rateCluster').style.display !== 'none', JSON.stringify(el('rateCluster').style.display));

  // 「导入即播」必须对 MIDI 同样生效（只让导入音频读它的话，
  // 导入 MIDI/曲库点歌永远不自动播，勾选框在整条 MIDI 链路上形同虚设）。
  // 上面这次导入是默认勾选（index.html 播种了 checked）→ 应已自动播放
  // （状态栏会被异步的自动存档结果覆写，不断言文案）。
  ck('★导入即播（默认勾选）：导入 MIDI 后立即自动播放',
    el('btnPP').textContent === '⏸ 暂停', el('btnPP').textContent);
  // 取消勾选 → 只装载不播放
  el('autoPlayOnImport').checked = false;
  H.fire('fileMidi', 'change', { target: { files: [{ name: mid, arrayBuffer: async () => ab }], value: '' } });
  await H.sleep(400);
  ck('★取消「导入即播」：导入 MIDI 后停在播放视图不自动播',
    el('btnPP').textContent === '▶ 播放', el('btnPP').textContent);
}

// ============================================================
// ③ 结构守卫：读源码/HTML 文本（node 跑不动的那几条链）
// ============================================================
const html = fs.readFileSync(ROOT + 'index.html', 'utf8');
const app = fs.readFileSync(ROOT + 'app.mjs', 'utf8');
const audioSrc = fs.readFileSync(ROOT + 'app/audio.mjs', 'utf8');
const libSrc = fs.readFileSync(ROOT + 'app/library.mjs', 'utf8');
const playerSrc = fs.readFileSync(ROOT + 'app/player.mjs', 'utf8');
/** 取 from..to 之间的片段（to 不存在则到文件尾）——只用来做"某段里必须/不得出现 X" */
const seg = (s, from, to) => {
  const a = s.indexOf(from);
  if (a < 0) return '';
  const b = to ? s.indexOf(to, a) : -1;
  return s.slice(a, b > a ? b : undefined);
};

{
  // ⑧「导入即播」必须与「导入音频」同簇（它管的是导入行为，不该待在录音簇里）
  const live = seg(html, 'id="liveCtrls"', 'id="playCtrls"');
  const side = seg(html, 'class="side-cluster"', '</div>\n\n  <!-- 工程存档面板');
  ck('★「导入即播」已不在录音簇 #liveCtrls 里', !/autoPlayOnImport/.test(live));
  ck('★「导入即播」在 #side-cluster 里（与「导入音频」同簇）',
    /autoPlayOnImport/.test(side) && side.indexOf('autoPlayOnImport') < side.indexOf('id="btnImport"'));

  // ⑪ 未实现的三档音区按钮不许能点
  const modeSeg = seg(html, 'id="modeSwitch"', '</div>');
  const modeBtns = modeSeg.match(/<button[^>]*data-mode="[^"]+"[^>]*>/g) || [];
  ck('模式三档仍是用按钮占位（3 个）', modeBtns.length === 3, String(modeBtns.length));
  ck('★三档音区按钮全部 disabled（未实现的东西不给"能切却没效果"的假象）',
    modeBtns.length === 3 && modeBtns.every((b) => /\bdisabled\b/.test(b)), modeBtns.join(' | '));
  ck('三档都写了"尚未实现"的 title', (modeSeg.match(/尚未实现/g) || []).length >= 3);

  // ⑩ 纯净模式隐藏清单必须覆盖曲库浮层（它挂在 body 上，不在这组选择器里就漏画面）
  const pureSeg = seg(html, 'body.pure header', '}');
  ck('★纯净模式隐藏清单包含 .lib-panel（曲库浮层）', /\.lib-panel/.test(pureSeg), pureSeg.replace(/\s+/g, ' '));
  ck('★library.mjs 给曲库面板挂了 .lib-panel class',
    /libPanel\.className\s*=\s*'lib-panel'/.test(libSrc));
  ck('library.mjs 没有改成覆盖 id（测试桩靠 id="created:div" 认这个面板）',
    !/libPanel\.id\s*=/.test(libSrc));

  // ②「原声」是全局控件：构建函数存在、被启动序列调用，且钢琴块面板里不建它
  ck('★app.mjs 有 buildGlobalControls（原声搬成全局）', /function buildGlobalControls\(\)/.test(app));
  ck('★启动序列调用了 buildGlobalControls()', /^buildGlobalControls\(\);/m.test(app));
  ck('★启动路径不用 document.createTextNode（smoke/cap-record 的极简桩没有这个 API，会整链红）',
    !/document\.createTextNode\(/.test(seg(app, 'function buildGlobalControls()', 'function refreshAnimBar()')));
  ck('★钢琴块面板里已无「原声」滑杆的构建代码',
    !/setOrigPlayVol/.test(seg(app, 'function refreshAnimBar()', 'window.addEventListener(\'resize\'')));

  // ⑥ 回声注入必须限定"正在录音"
  ck('★回声注入带 recState===\'rec\' 守卫（否则暂停/试听时上一段在途块会重新下落并弹琴）',
    /echoOn && recState === 'rec' && echoNotes\.length/.test(app));

  // ⑤ 转谱后仍要给工程帧：midiNotes 与 analysis 两个数据源各自独立
  ck('★snapshot：MIDI/转谱与工程帧共用一段且互补（有音符表也照给 projFrames）',
    /useProj && curProject && \(curProject\.midiNotes \|\| curProject\.analysis\)/.test(app)
    && /projFrames = curProject\.analysis\.frames/.test(app));

  // ⑤b 打开存档时不因"有音符表"就强切钢琴块模板（那会顶掉用户的模板选择）
  ck('★打开存档：只有"没有音频的 MIDI 存档"才强切钢琴块',
    /kind === proj\.KIND_MIDI && !rec\.audioBlob/.test(app));

  // ⑨「＋新建」必须复位音域读数
  ck('★newSession 里调用了 resetStats()',
    /resetStats\(\)/.test(seg(app, 'function newSession()', '// 播放器引擎')), 'newSession 段内找不到');

  // ⑦ 门控参数变了要能重算工程 + 不出现假校准
  ck('★存在 reanalyzeIfProject（灵敏/收音变更后按新口径重算整段）',
    /function reanalyzeIfProject\(/.test(app) && /reanalyzeIfProject\('灵敏度'\)/.test(app));
  ck('★校准底噪用 micFeeding 判据（不是"analyserRms 存在"）',
    /if \(!micFeeding\)/.test(app));
  ck('★audio 域维护 micFeeding（routeNow 与 stopLiveFeeding 都要写）',
    /export let micFeeding = false/.test(audioSrc)
    && /micFeeding = target === 'mic'/.test(audioSrc)
    && /micFeeding = false;/.test(audioSrc));
  ck('★app.mjs 从 audio 域 import 了 micFeeding', /\bmicFeeding\b/.test(seg(app, "from './app/audio.mjs'", "from './app/anim")));

  // ③ 变声/导出的"真实音频"判据用 clip.silent 标记
  ck('★变声控件显隐含 !curClip.silent', /showRvc = appView === 'play' && !!curClip && !curClip\.silent/.test(app));
  ck('★silent 标记在造静音时间轴的两处都打上了',
    (app.match(/silent: true/g) || []).length >= 2, String((app.match(/silent: true/g) || []).length));

  // 顺带：播放键高亮跟随播放态（.btn-play.play 的 CSS 注释就是"进入播放态=冷强调实心"）
  ck('★播放键高亮类跟随 pl.playing', /classList\.toggle\('play', pl\.playing\)/.test(playerSrc));

  // ④ AI 转谱按钮显隐由工程变化驱动
  ck('★projSetCurrentUI 会补刷面板里依赖工程的控件', /syncAnimBarDeps\(\);/.test(app));

  // ⏩ 倍速（2026-09-17）
  // ⑫ 档位清单只有一份真相：index.html 的 <option> 必须与 player 域的 RATES 逐项一致
  //    （两边漂了会静默回退 1×，"选了 0.5× 却没变慢"这类问题极难查）
  {
    const rateSeg = seg(html, 'id="rateCluster"', '</div>');
    const htmlRates = [...rateSeg.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    const m = playerSrc.match(/export const RATES = \[([^\]]+)\]/);
    const srcRates = m ? m[1].split(',').map((s) => s.trim()) : [];
    ck('★倍速档位：index.html 的 <option> 与 player 域 RATES 逐项一致（唯一真相源）',
      srcRates.length > 0 && JSON.stringify(htmlRates) === JSON.stringify(srcRates),
      `html=${JSON.stringify(htmlRates)} src=${JSON.stringify(srcRates)}`);
    ck('倍速档位含 1×（默认档）与 0.25×/4×（要求的两端）',
      srcRates.includes('1') && srcRates.includes('0.25') && srcRates.includes('4'));
  }

  // ⑬ 播放头推进只允许有一处实现（倍速改动只碰它）。app.mjs 手里再抄一份的话
  //    "pos + (currentTime - baseCtxPos)"，两份口径迟早会漂 → 已收敛到 player 域 plPos()。
  ck('★app.mjs 不再自己算播放头（baseCtxPos 只许可在 player 域出现）', !/baseCtxPos/.test(app));
  ck('★播放头按倍速推进的唯一实现 = player 域的 plPos()（adv * playRate 一处）',
    (playerSrc.match(/adv \* playRate/g) || []).length === 1,
    String((playerSrc.match(/adv \* playRate/g) || []).length));
  ck('★nowPosSec 直接复用 plPos()（不重算）', /return plPos\(\);/.test(app));

  // ⑭ 「变调」开关的显隐必须跟"有没有真音频"走（silent = MIDI/无音频存档的静音时间轴）
  {
    const seg2 = seg(app, 'function syncRateUI()', '\n}');
    ck('★syncRateUI 里用 clip.silent 判据决定「变调」是否出现', /curClip\.silent/.test(seg2),
      seg2.replace(/\s+/g, ' ').slice(0, 120));
    ck('★倍速控件在录音中不出现（与走带条 recSeek 同一显隐口径）',
      /recState === 'paused' \|\| recState === 'listen'/.test(seg2));
  }

  // ⑮ 变速不变调必须真的走颗粒重排，而不是又落回 playbackRate 重采样
  ck('★player 域引用了 dsp/stretch.mjs 的 timeStretch', /import \{ timeStretch \}/.test(playerSrc));
  ck('★变速不变调档下播放速率恒为 1（时间轴靠 buffer 被拉长/压缩）',
    /src\.playbackRate\.value = tapeLike \? playRate : 1;/.test(playerSrc));
}

// ============================================================
// ④ 结构守卫：分片分析的"整段绝对时间"口径（2026-09-18 修）
//    node 里没有 Web Worker（`typeof Worker === 'undefined'` → 走单线程路径），
//    所以分片这条链在本测试环境里**跑不到**，只能钉代码里必须存在的东西：
//    主线程必须把本片起点偏移交给 worker，worker 侧必须把它加回窗时间。
// ============================================================
{
  const poolSrc = fs.readFileSync(ROOT + 'dsp/analyze-pool.mjs', 'utf8');
  const analyzeSrc = fs.readFileSync(ROOT + 'dsp/analyze.mjs', 'utf8');
  ck('★分片 postMessage 带上了本片在整段里的起点（否则内核帧表按错时间段查）',
    /tOffsetSec:\s*sl\.s\s*\/\s*sr/.test(poolSrc),
    (poolSrc.match(/postMessage\(\{[^}]*\}[^)]*\)/) || [''])[0]);
  ck('★analyze 把偏移加回窗时间再喂 setWindowTime（绝对时间口径）',
    /t \/ 1000 \+ \(cfg\.tOffsetSec \|\| 0\)/.test(analyzeSrc));
  ck('★单线程路径（未分片）不传偏移也不会偏——缺省为 0',
    /cfg\.tOffsetSec \|\| 0/.test(analyzeSrc));

  // 录屏音频桥接：琴声与麦克风**都是惰性创建**的，必须每帧兜一次。
  // （2026-09-15 修了琴声、2026-09-18 才补上麦克风：先点录制动画、后点开始录音时，
  //   开始时 getMicSrc() 还是 null → 那次录制永远没人声。）
  const capSrc = fs.readFileSync(ROOT + 'app/capture.mjs', 'utf8');
  ck('★capTick 每帧补挂琴声与麦克风（否则"先录屏后录音"的视频没有人声）',
    /capEnsurePianoTap\(\);[\s\S]{0,240}capEnsureMicTap\(\);/.test(capSrc));
  ck('★麦克风补挂也是幂等的（已有 capMicGain 就不再接第二条）',
    /if \(!capDest \|\| !audioCtx \|\| capMicGain\) return;/.test(capSrc));
}

console.log(fails ? `\n[scope-guards] ${fails} 项失败` : '\n[scope-guards] 全部通过');
process.exit(fails ? 1 : 0);
