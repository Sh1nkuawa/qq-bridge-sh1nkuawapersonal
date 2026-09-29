#!/usr/bin/env node
// 关闭 DSH（并把它的 MCP 子进程一起收干净），留给用户自己重新启动。
//
// 为什么用 Node + 脱离进程树运行：停 DSH 会杀掉正在跑的 agent 会话（也就是发起这条命令的
// 那个进程），所以「等待 → 停 DSH」必须由**脱离子树**的进程来做。实测本机 WMI 创建的
// `powershell.exe -File xxx.ps1` 会静默不执行（node.exe 正常），所以这个脚本用 Node 写。
//
// 用法：node scripts/close-dsh.mjs [--grace 10]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'state', 'restart-dsh.log');
const argv = process.argv.slice(2);
const gi = argv.indexOf('--grace');
const GRACE = gi >= 0 && argv[gi + 1] ? Math.max(0, Number(argv[gi + 1]) || 0) : 10;

function W(msg) {
  const line = `${new Date().toISOString()} close-dsh: ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch { /* 日志失败不影响主流程 */ }
}

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').trim();
}

W(`scheduled, waiting ${GRACE}s before stopping DSH (let the current chat turn finish)...`);
await new Promise((r) => setTimeout(r, GRACE * 1000));

// 1) DSH 本体（dsh/lib/bin.js … web）
const dshPids = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin\\.js' -and $_.CommandLine -match ' web' -and $_.CommandLine -match 'dsh' } | ForEach-Object { Write-Output $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
  .split(/\s+/).filter(Boolean);
W(dshPids.length ? `stopped DSH PID ${dshPids.join(',')}` : 'no running DSH web process found (already closed?)');

await new Promise((r) => setTimeout(r, 5000));

// 2) DSH 拉起的 MCP 子进程（它们不会自己退出，留着会占着端口/文件）
const mcpPids = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*qq-bridge*src*mcp-*' } | ForEach-Object { Write-Output $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`)
  .split(/\s+/).filter(Boolean);
W(mcpPids.length ? `stopped leftover MCP child PID ${mcpPids.join(',')}` : 'no leftover MCP child');

await new Promise((r) => setTimeout(r, 3000));

// 3) 现状摘要（桥接是独立进程，会继续跑并等 DSH 回来）
const dshLeft = ps(`@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin\\.js' }).Count`);
const bridge = ps(`(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp*' } | Select-Object -First 1).ProcessId`);
let port3080 = '?';
try {
  const res = await fetch('http://127.0.0.1:3080/', { signal: AbortSignal.timeout(3000) });
  port3080 = `HTTP ${res.status}`;
} catch { port3080 = '不可达'; }
W(`done. DSH 残留进程=${String(dshLeft).trim()} ; 3080=${port3080} ; 桥接 PID=${bridge || '(未运行)'}`);
W('请自行启动 DSH（例如：dsh web --no-open）；桥接会自动重连，不需要重启它。');
