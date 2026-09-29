#!/usr/bin/env node
// upgrade-dsh-017.mjs — 停 DSH → 升级全局 @deepseek-ai/dsh → 重跑 setup-dsh.mjs
// → 重启 DSH 与桥接 → 跑验证，全程写日志与结果文件。
//
// 为什么用 Node 写：停 DSH 会杀掉正在跑的 agent 会话，所以这个编排必须**脱离原进程树**
// 运行。实测本机用 WMI（Win32_Process.Create）创建进程时，`powershell.exe -File xxx.ps1`
// 会静默不执行（node.exe 则正常），所以编排器用 Node 写、由 WMI 启动。
//
// 用法：
//   node scripts/upgrade-dsh-017.mjs [--target 0.1.7-rc.2] [--grace 45] [--skip-backup]
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_EXE = process.execPath;
const NPM_CMD = 'D:\\nodejs16\\npm.cmd';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DSH_PKG = 'D:\\nodejs16\\node_global\\node_modules\\@deepseek-ai\\dsh';
const DSH_BIN = path.join(DSH_PKG, 'lib', 'bin.js');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const TARGET = argOf('target', '0.1.7-rc.2');
const GRACE = Number(argOf('grace', '45')) || 0;
const SKIP_BACKUP = argv.includes('--skip-backup');
const DRY_RUN = argv.includes('--dry-run');

if (!/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i.test(TARGET)) {
  console.error(`目标版本格式不合法：${TARGET}`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '-');
const LOG = path.join(ROOT, 'state', `dsh-upgrade-${stamp}.log`);
const RESULT = path.join(ROOT, 'state', `dsh-upgrade-${stamp}-RESULT.txt`);
const checks = [];

fs.mkdirSync(path.dirname(LOG), { recursive: true });
function W(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  fs.appendFileSync(LOG, line + '\n', 'utf8');
}
function check(name, ok, detail = '') {
  const row = `[${ok ? 'OK  ' : 'FAIL'}] ${name}${detail ? ' -- ' + detail : ''}`;
  checks.push(row);
  W(row);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 PowerShell 做进程查询/清理（Node 里没有等价能力）。spawnSync 直接传 -Command 字符串，
// 不经过 shell，避免引号地狱。
function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  if (r.stderr?.trim()) W(`ps stderr: ${r.stderr.trim().slice(0, 400)}`);
  return (r.stdout || '').trim();
}
function killWhere(where) {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ${where} } | ForEach-Object { Write-Output $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  return out.split(/\s+/).filter(Boolean);
}
function killCmdWhere(where) {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { ${where} } | ForEach-Object { Write-Output $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  return out.split(/\s+/).filter(Boolean);
}
function runStep(exe, args, label, opts = {}) {
  W(`RUN ${label}: ${exe} ${args.join(' ')}`);
  const r = spawnSync(exe, args, { cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.stdout) fs.appendFileSync(LOG, r.stdout, 'utf8');
  if (r.stderr) fs.appendFileSync(LOG, r.stderr, 'utf8');
  W(`${label} exit=${r.status}${r.error ? ' error=' + r.error.message : ''}`);
  return r;
}
async function portOpen(port, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(1500, () => done(false));
    });
    if (ok) return true;
    await sleep(2000);
  }
  return false;
}
function dshVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(DSH_PKG, 'package.json'), 'utf8')).version; } catch { return 'unknown'; }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
W(`=== DSH upgrade to ${TARGET} (stamp ${stamp}, grace ${GRACE}s, skipBackup=${SKIP_BACKUP}) ===`);
W(`DSH_HOME=${DSH_HOME} node=${NODE_EXE}`);
const beforeVersion = dshVersion();
W(`before: dsh=${beforeVersion} node=${process.version}`);

if (GRACE > 0) {
  W(`grace: waiting ${GRACE}s before touching DSH (let the current chat turn finish writing its reply)`);
  await sleep(GRACE * 1000);
}

// --dry-run：只验证「脚本能被脱离进程树地启动、能写日志」，不碰 DSH。
if (DRY_RUN) {
  check('dry-run reached launch point', true, `dsh=${beforeVersion}`);
  fs.writeFileSync(RESULT, [`DSH upgrade DRY RUN ${stamp}`, `log: ${LOG}`, '', ...checks].join('\n') + '\n', 'utf8');
  W('dry-run: exiting before touching DSH');
  process.exit(0);
}

// 1) 备份
if (!SKIP_BACKUP) {
  const bk = runStep('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'backup-before-upgrade.ps1')], 'backup');
  check('backup-before-upgrade.ps1', bk.status === 0, `exit=${bk.status}`);
} else {
  check('backup-before-upgrade.ps1', true, 'skipped');
}

// 2) 停桥接（守护窗口 + 进程）
const guards = killCmdWhere(`$_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*'`);
W(`stopped bridge guard PIDs: ${guards.join(',') || '(none)'}`);
const bridges = killWhere(`$_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*'`);
W(`stopped bridge PIDs: ${bridges.join(',') || '(none)'}`);
await sleep(3000);
const bridgeLeft = ps(`@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }).Count`);
check('bridge stopped', String(bridgeLeft).trim() === '0', `left=${String(bridgeLeft).trim()}`);

// 3) 停 DSH（及其 MCP 子进程）
const dshPids = killWhere(`$_.CommandLine -match 'bin\\.js' -and $_.CommandLine -match ' web' -and $_.CommandLine -match 'dsh'`);
W(`stopped DSH PIDs: ${dshPids.join(',') || '(none)'}`);
await sleep(5000);
const mcpPids = killWhere(`$_.CommandLine -like '*qq-bridge*src*mcp-*'`);
W(`stopped leftover MCP child PIDs: ${mcpPids.join(',') || '(none)'}`);
const free3080 = !(await portOpen(3080, 2));
check('DSH stopped (3080 free)', free3080);

// 4) 升级 DSH
const inst = runStep('cmd.exe', ['/c', `"${NPM_CMD}" install -g @deepseek-ai/dsh@${TARGET}`], 'npm-install');
const afterVersion = dshVersion();
W(`after: dsh=${afterVersion}`);
check(`dsh installed = ${TARGET}`, afterVersion === TARGET, `exit=${inst.status} version=${afterVersion}`);

// 5) 重装 DSH 侧（preset patch / MCP / 插件链接）。
//    只在版本真的换过去之后才跑：0.1.7 的 preset 机制在 0.1.5 上会加载失败，
//    升级失败时宁愿保持 0.1.5 的原样。
if (afterVersion === TARGET) {
  const setup = runStep(NODE_EXE, ['scripts/setup-dsh.mjs'], 'setup-dsh');
  check('setup-dsh.mjs', setup.status === 0, `exit=${setup.status}`);
} else {
  check('setup-dsh.mjs', false, 'skipped: dsh version mismatch');
}

// 6) 起 DSH（脱离本进程，DSH 需要独立存活）
W(`starting DSH: ${NODE_EXE} ${DSH_BIN} web --no-open`);
const dshChild = spawn(NODE_EXE, [DSH_BIN, 'web', '--no-open'], {
  cwd: 'D:\\dsh', detached: true, stdio: 'ignore', windowsHide: true,
  env: {
    ...process.env,
    DSH_HOME,
    // WMI 启动的进程拿到的是系统 PATH；把 node 目录钉进去，避免 DSH 内部 spawn npm/node 找不到。
    PATH: `D:\\nodejs16;D:\\nodejs16\\node_global;${process.env.PATH || ''}`,
  },
});
dshChild.unref();
const dshUp = await portOpen(3080, 180);
check('DSH listening on 3080', dshUp);

// 7) 跑 DSH 侧验证
if (dshUp) {
  const v1 = runStep(NODE_EXE, ['scripts/verify-agent-presets-017.mjs'], 'verify-presets');
  check('verify-agent-presets-017.mjs', v1.status === 0, `exit=${v1.status}`);
  const v2 = runStep(NODE_EXE, ['scripts/verify-dsh-015-adaptation.mjs'], 'verify-adaptation');
  check('verify-dsh-015-adaptation.mjs', v2.status === 0, `exit=${v2.status}`);
} else {
  check('verify-agent-presets-017.mjs', false, 'skipped: DSH not up');
}

// 8) 起桥接守护窗口（start.bat 自带崩溃重启循环）
W('starting bridge guard window (cmd /c start.bat)');
const guard = spawn('cmd.exe', ['/c', 'start.bat'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
guard.unref();
const bridgeUp = await portOpen(3100, 180);
check('bridge console listening on 3100', bridgeUp);

// 9) 结果文件
const failCount = checks.filter((c) => c.startsWith('[FAIL]')).length;
const header = [
  `DSH upgrade run ${stamp}`,
  `target=${TARGET}  before=${beforeVersion}  after=${afterVersion}`,
  `log: ${LOG}`,
  '',
];
fs.writeFileSync(RESULT, [...header, ...checks, '', `failures: ${failCount}`].join('\n') + '\n', 'utf8');
W(`=== DONE (failures: ${failCount}) -> ${RESULT} ===`);
