// ============================================================
// test/exporters.mjs —— 曲线/音符导出守卫（node 直跑，无浏览器）
// 背景：2026-09-15 新增 proj/exporters.mjs（曲线 CSV 出口）。
// 这里钉住四条不能破的线：
//   ① 表头逐字符固定（下游脚本按列名取数，改名=静默错列）
//   ② 频率->音名/半音/音分三列算得对（A4=440 → midi 69.00 / A4 / 0.0）
//   ③ 【关键】极小值不得输出指数写法 —— String(1e-7)==='1e-7' 会让 Excel/pandas
//      把整列当文本。全部数值走 toFixed。
//   ④ 缺失值一律空串，不写 0（0 是合法测量值，混淆=数据错）
// ============================================================
import { framesToCsv, notesToCsv, stampName, FRAME_HEAD, NOTE_HEAD } from '../proj/exporters.mjs';

let fails = 0;
const ck = (name, cond) => { if (cond) console.log('  ok  ' + name); else { fails++; console.error('  FAIL ' + name); } };

console.log('[exporters] 导出守卫');

const lines = (s) => s.replace(/^\ufeff/, '').split('\r\n').filter((x, i, a) => !(i === a.length - 1 && x === ''));

// ① 表头
ck('帧表头逐字符固定', FRAME_HEAD === 't_ms,freq_hz,midi,note,cents,voiced,prom,purity,rms,str');
ck('音符表头逐字符固定', NOTE_HEAD === 't0_ms,t1_ms,dur_ms,midi,note,vel');
ck('空输入也输出表头（文件永远可被解析）',
  lines(framesToCsv([])).length === 1 && lines(notesToCsv([])).length === 1);
ck('非数组输入不抛（undefined/null 都当空）',
  lines(framesToCsv(undefined)).length === 1 && lines(notesToCsv(null)).length === 1);

// ② 频率 -> 音名/半音/音分
//    列序：0 t_ms | 1 freq_hz | 2 midi | 3 note | 4 cents | 5 voiced | 6 prom | 7 purity | 8 rms | 9 str
{
  const csv = framesToCsv([{ t: 100, freq: 440, voiced: true, prom: 12.5, purity: 0.5, rms: 0.25, str: 0.125 }]);
  const row = lines(csv)[1].split(',');
  ck('A4=440 → midi 69.00', row[2] === '69.00');
  ck('A4=440 → 音名 A4', row[3] === 'A4');
  ck('A4=440 → cents 0.0', row[4] === '0.0');
  ck('t 取整（100ms）', row[0] === '100');
  ck('freq 两位小数', row[1] === '440.00');
  ck('voiced=1', row[5] === '1');
  ck('prom 两位小数', row[6] === '12.50');
  ck('purity 三位小数', row[7] === '0.500');
  ck('rms 六位小数（定点，不省尾零）', row[8] === '0.250000');
  ck('str 三位小数', row[9] === '0.125');
}
{
  const one = (freq) => lines(framesToCsv([{ t: 0, freq, voiced: true }]))[1].split(',');
  ck('C5=523.2511 → C5', one(523.2511306)[3] === 'C5' && one(523.2511306)[2] === '72.00');
  ck('A3=220 → A3（八度号 = floor(m/12)-1）', one(220)[3] === 'A3' && one(220)[2] === '57.00');
  ck('C4=261.6256 → C4', one(261.6255653)[3] === 'C4');
  // 半音之间：真值 = 1200*log2(f/f最近半音)
  // 这三条同时是【防回退】——core.mjs 的 freqToNote().cents 用错比值基准会给出
  // 4.9 / 6.2 / 3.9 这种偏小值，一旦有人把导出改回复用它，这里立刻红。
  ck('445Hz → A4 且 cents=+19.6', Math.abs(parseFloat(one(445)[4]) - 19.56) < 0.05);
  ck('111Hz → A2 且 cents=+15.7', Math.abs(parseFloat(one(111)[4]) - 15.67) < 0.05);
  ck('2000Hz → B6 且 cents=+21.3', Math.abs(parseFloat(one(2000)[4]) - 21.31) < 0.05);
  // 音分恒在 [-50, 50]，半音交界处不得出现 ±100
  let ok = true;
  for (let f = 60; f < 3000; f *= 1.003) {
    const c = parseFloat(one(f)[4]);
    if (!(c >= -50 && c <= 50) || !Number.isFinite(c)) { ok = false; break; }
  }
  ck('60~3000Hz 扫频 cents 恒在 [-50,50]', ok);
}

// ③ 极小值不得出现指数写法
{
  const cases = [
    { t: 0, freq: 0, voiced: false, prom: 0, purity: 0, rms: 1e-7, str: 1e-9 },
    { t: 0, freq: 440, voiced: true, prom: 1e-5, purity: 1e-8, rms: 2.5e-9, str: 1e-12 },
  ];
  const body = lines(framesToCsv(cases)).slice(1).join('\n');
  ck('极小值无指数写法(e/E)', !/[eE][-+]?\d/.test(body));
  const tiny = lines(framesToCsv([cases[0]]))[1].split(',');
  ck('rms 1e-7 → "0.000000"（定点，非 1e-7）', tiny[8] === '0.000000');
}

// ④ 缺失值 = 空串，不是 0
{
  const none = lines(framesToCsv([{ t: 0, freq: 0, voiced: false }]))[1].split(',');
  ck('无频率：freq/midi/note/cents 四列全空', none[1] === '' && none[2] === '' && none[3] === '' && none[4] === '');
  ck('无频率：voiced 仍明确写 0', none[5] === '0');
  ck('字段缺失(NaN/undefined)：prom 等为空串', none[6] === '' && none[9] === '');
  const partial = lines(framesToCsv([{ t: 10, freq: 440, voiced: true, rms: 0.25 }]))[1].split(',');
  ck('rms=0.25 是真值不是缺失 → "0.250000"', partial[8] === '0.250000');
}

// ⑤ 桥接帧：voiced=false 但带频率 → 频率/音名列照给，voiced 列单独说 0
{
  const br = lines(framesToCsv([{ t: 500, freq: 330, voiced: false, rms: 0.01 }]))[1].split(',');
  ck('桥接帧保留频率与音名（曲线连续）', br[1] === '330.00' && br[3] === 'E4' && br[5] === '0');
}

// ⑥ 音符表
{
  const csv = notesToCsv([{ t0: 1000, t1: 1500, midi: 60, vel: 0.8 }, { t0: 2000, t1: 2060, midi: 61.7, vel: 1 }]);
  const r = lines(csv);
  ck('音符行数正确', r.length === 3);
  ck('dur_ms 由 t1-t0 得出', r[1].split(',')[2] === '500');
  ck('midi 取整 + 音名 C4', r[1].split(',')[3] === '60' && r[1].split(',')[4] === 'C4');
  ck('midi 61.7 四舍五入到 62 → D4', r[2].split(',')[3] === '62' && r[2].split(',')[4] === 'D4');
  // 恶劣输入：缺 t1 / 缺 midi
  const bad = lines(notesToCsv([{ midi: 60 }, { t0: 0, t1: 1 }]));
  ck('缺 t0/t1 的行不崩且留空', bad[1].split(',')[0] === '' && bad[1].split(',')[2] === '');
  ck('缺 midi 的行被丢弃（无法定位音高）', bad.length === 2);
}

// ⑦ 换行与 BOM
ck('行尾统一 CRLF', framesToCsv([{ t: 0, freq: 440, voiced: true }]).includes('\r\n'));
ck('导出函数不自带 BOM（由调用方拼，便于 node 端比对）', !framesToCsv([]).startsWith('\ufeff'));

// ⑧ 文件名时间戳：Windows 安全（无 : / . 空格）
{
  const s = stampName(new Date(2026, 8, 15, 8, 7, 5));
  ck('stampName 形状 2026-09-15_08-07-05', s === '2026-09-15_08-07-05');
  ck('stampName 无 Windows 非法字符', !/[:/ .]/.test(s));
  ck('stampName 月日时分秒补零', stampName(new Date(2026, 0, 2, 3, 4, 5)) === '2026-01-02_03-04-05');
}

if (fails) { console.error(`[exporters] ${fails} 项失败`); process.exit(1); }
console.log('[exporters] 全部通过');
