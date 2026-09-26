#!/usr/bin/env node
// tools/stop-server.mjs —— 停掉监听在本机端口上的服务进程（默认 8000）
// 用法：node tools/stop-server.mjs [port]
// 由 stop-ydyi.bat 调用；比 bat 的 findstr 管道可靠（能看到进程名、杀完复核）。
import { execSync } from 'node:child_process';

const PORT = Number(process.argv[2]) || 8000;

if (process.platform !== 'win32') {
  console.error('此脚本仅支持 Windows（ydyi 本机部署环境）。其他平台请手动结束进程。');
  process.exit(1);
}

function listeners(port) {
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  const pids = new Set();
  const re = /^\s*TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$/gm;
  let m;
  while ((m = re.exec(out)) !== null) {
    if (m[1].endsWith(':' + port)) pids.add(m[3]);
  }
  return [...pids];
}

function nameOf(pid) {
  try {
    const t = execSync('tasklist /FI "PID eq ' + pid + '"', { encoding: 'utf8' });
    for (const line of t.split('\n')) {
      const tok = line.trim().split(/\s+/);
      if (tok.length >= 2 && tok[1] === String(pid)) return tok[0];
    }
  } catch (e) { /* 查不到名字不致命 */ }
  return '(未知)';
}

let pids = listeners(PORT);
if (!pids.length) {
  console.log('端口 ' + PORT + ' 上没有服务在监听——已经停了，不用处理。');
  process.exit(0);
}

for (const pid of pids) {
  console.log('找到 PID ' + pid + ' (' + nameOf(pid) + ') 正在监听端口 ' + PORT + '，结束它…');
  try {
    execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' });
  } catch (e) {
    console.error('  ✗ 结束 PID ' + pid + ' 失败（可能需要管理员权限）。请到任务管理器→详细信息→按 PID 排序，手动结束它。');
  }
}

pids = listeners(PORT);
if (pids.length) {
  console.error('✗ 端口 ' + PORT + ' 仍被 PID ' + pids.join(', ') + ' 占用（结束失败）。请用任务管理器手动处理。');
  process.exit(1);
}
console.log('✓ 端口 ' + PORT + ' 已释放，服务已停止。');
