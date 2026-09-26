// 门控端到端仿真：直接驱动 dsp/detect.mjs 的 createDetector
// （与 app.mjs 实时路径、离线整段分析同一份实现），喂真实口哨波形 vs 拍桌撞击，
// 验证：口哨能发声、撞击判为静音、且不发飙到 B8。
//
// 注：本文件不复制 gateThresh 与置信状态机（那会变成项目里的第三份门控代码），
// 改门控口径时它不会跟着变，反而失去对照意义。现在改由生产实现驱动：
// 测试跑的就是线上跑的那套，口径漂移立刻暴露。
import { createDetector } from '../dsp/detect.mjs';

const SR = 44100, N = 4096;

const SENS = 70;             // 与 app.mjs 默认灵敏度一致
const envBase = 0.002;       // 校准出的低底噪

// 每个场景都用一个全新检测器(状态机/平滑窗互不污染)
function makeDetector() {
  const det = createDetector({
    sampleRate: SR, fmin: 40, fmax: 8000, windowSize: N, voicing: 85, sens: SENS,
  });
  det.setEnergy({ mode: 'auto', envRms: envBase });
  return det;
}

// 把长信号切成多个 N 长分析窗
function windows(x) { const w = []; for (let p = 0; p + N <= x.length; p += N) w.push(x.subarray(p, p + N)); return w; }

function run(name, x) {
  const det = makeDetector();
  const wins = windows(x);
  let voiceFrames = 0, maxHz = 0, minHz = Infinity;
  const report = [];
  for (let i = 0; i < wins.length; i++) {
    const r = det.processWindow(wins[i]);
    if (r.voiced) { voiceFrames++; if (r.fA > maxHz) maxHz = r.fA; if (r.fA < minHz) minHz = r.fA; }
    if (i < 3 || i === wins.length - 1) {
      report.push(`窗${i}:${r.voiced ? '✓发声' : '·静音'}(str${r.str.toFixed(2)},${r.fA ? r.fA.toFixed(0) + 'Hz' : '--'})`);
    }
  }
  const ratio = voiceFrames / wins.length;
  console.log(`${name}: 发声帧${voiceFrames}/${wins.length}(${(ratio * 100).toFixed(0)}%) | A频段${isFinite(minHz) ? minHz.toFixed(0) : '--'}–${maxHz.toFixed(0)}Hz | 前几窗: ${report.join(' ')}`);
  return ratio;
}

// --- 生成测试波形 ---
function tone(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR); return x; }
function toneNoisy(f, sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let sd = 7; const rng = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f * i / SR) + 0.08 * rng(); return x; }
function impulse(sec) { const n = Math.floor(SR * sec), x = new Float32Array(n); let sd = 99; const rng = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32 * 2 - 1; for (let i = 0; i < n; i++) x[i] = rng() * Math.exp(-i / (SR * 0.012)); return x; }

const probe = makeDetector();
const g = probe.gate;
console.log(`灵敏度 ${SENS} → 门控 {strMax=${g.strMax.toFixed(2)}, purityMin=${g.purityMin.toFixed(2)}, confOn=${g.confOn}, confStep=${g.confStep}, dropFrames=${g.dropFrames}, smoothK=${g.smoothK}}\n`);

console.log('— 场景1: 吹口哨长音 C5(523Hz)+轻微气声 —— 应稳定发声');
run('口哨C5(带气声)', toneNoisy(523.25, 2.0));

console.log('— 场景2: 吹口哨长音 B6(1975Hz) 纯 —— 应发声');
run('口哨B6', tone(1975.5, 1.5));

console.log('— 场景3: 拍一下桌子(宽带撞击~0.5s) —— 应判静音，绝不飙到 B8');
run('拍桌撞击', impulse(0.5));

console.log('\n仿真完成。口哨应高比例发声；撞击应 0 发声。');
