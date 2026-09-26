// 轨迹级离群抑制验证（dsp/detect.mjs trackFreq）：
//   1) 单窗高音爆点(3600Hz) → 应被吸收，输出保持 ~440Hz；
//   2) 单窗低音爆点(45Hz)   → 应被吸收，输出保持 ~440Hz；
//   3) 真下行/上行滑音(440→880) → 两帧同向确认后应能跟上。
import { createDetector } from '../dsp/detect.mjs';

const SR = 44100, N = 4096;
function makeDetector() {
  const det = createDetector({ sampleRate: SR, fmin: 40, fmax: 8000, windowSize: N, voicing: 85, sens: 70 });
  det.setEnergy({ mode: 'auto', envRms: 0.002 });
  return det;
}
function tone(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR); return x; }
function frames(x) { const w = []; for (let p = 0; p + N <= x.length; p += N) w.push(x.subarray(p, p + N)); return w; }
function detRun(det, wins, cb) { const out = []; for (let i = 0; i < wins.length; i++) out.push(det.processWindow(wins[i])); return out; }

let bad = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}  ${detail || ''}`); if (!ok) bad++; };

console.log('轨迹级离群抑制\n');

// 场景1：单窗高音爆点 —— 第 10 窗替换为 3600Hz 强正弦
{
  const base = tone(440, 2.5);
  const flagX = new Float32Array(N); for (let i = 0; i < N; i++) flagX[i] = Math.sin(2 * Math.PI * 3600 * i / SR);
  const wins = frames(base); wins[10] = flagX;
  const det = makeDetector();
  const res = detRun(det, wins);
  const before = res[9].freq, at = res[10].freq, after = res[11].freq;
  check('高音爆点窗保持~440', Math.abs(at - before) < 100 && Math.abs(at - 440) < 100, `前${before.toFixed(0)} 爆点${at.toFixed(0)} 后${after.toFixed(0)}`);
}

// 场景2：单窗低音爆点 —— 第 12 窗替换为 45Hz 强正弦
{
  const base = tone(440, 2.5);
  const flagX = new Float32Array(N); for (let i = 0; i < N; i++) flagX[i] = Math.sin(2 * Math.PI * 45 * i / SR);
  const wins = frames(base); wins[12] = flagX;
  const det = makeDetector();
  const res = detRun(det, wins);
  const before = res[11].freq, at = res[12].freq, after = res[13].freq;
  check('低音爆点窗保持~440', Math.abs(at - before) < 100 && Math.abs(at - 440) < 100, `前${before.toFixed(0)} 爆点${at.toFixed(0)} 后${after.toFixed(0)}`);
}

// 场景3：上行滑音 440→880 → 应两帧确认后跟上(不能一直被打平)
{
  const a = tone(440, 0.55), b = tone(880, 0.55);
  const x = new Float32Array(a.length + b.length); x.set(a, 0); x.set(b, a.length);
  const det = makeDetector();
  const res = detRun(det, frames(x));
  const tail = res.slice(-4).map(r => r.freq).filter(Number.isFinite);
  const ok = tail.some(f => Math.abs(f - 880) < 150);
  check('滑音 440→880 能跟上', ok, `末几帧=${tail.map(f => f.toFixed(0)).join(',')}`);
}

// 场景4：多窗连续假高音(3窗 3600) 也应压住为主(除非 3 窗同向确认,此处检查至少前 2 窗被吸收)
{
  const base = tone(440, 3.0);
  const flagX = new Float32Array(N); for (let i = 0; i < N; i++) flagX[i] = Math.sin(2 * Math.PI * 3600 * i / SR);
  const wins = frames(base); wins[8] = flagX; wins[9] = flagX; wins[10] = flagX;
  const det = makeDetector();
  const res = detRun(det, wins);
  const vals = [res[8].freq, res[9].freq].filter(Number.isFinite);
  check('连续假高音前2窗被吸收', vals.every(f => Math.abs(f - 440) < 150), `窗8=${res[8].freq.toFixed(0)} 窗9=${res[9].freq.toFixed(0)}`);
}

// 场景5：越出物理音域的高频毛刺(9000Hz，>C8) → 硬钳丢弃，曲线保持 440
{
  const base = tone(440, 2.5);
  const flagX = new Float32Array(N); for (let i = 0; i < N; i++) flagX[i] = Math.sin(2 * Math.PI * 9000 * i / SR);
  const wins = frames(base); wins[9] = flagX;
  const det = makeDetector();
  const res = detRun(det, wins);
  const at = res[9].freq;
  check('越界高频毛刺被钳掉(保持~440)', !Number.isFinite(at) || Math.abs(at - 440) < 150, `爆点窗freq=${Number.isFinite(at) ? at.toFixed(0) : 'NaN'}`);
}

if (bad) { console.log(`\n失败 ${bad} 项`); process.exit(1); }
console.log('\n完成。离群抑制与滑音跟进符合预期。');