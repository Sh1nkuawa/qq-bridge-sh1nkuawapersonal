#!/usr/bin/env node
// qq-bridge 外部看门狗 —— 探活、留证、必要时把卡死的桥接拉回来。
//
// 为什么必须住在**进程外面**：2026-09-29 两次事故（见 INSTALL_NOTES 16.3）——
//   ① 桥接进程还活着，但事件循环卡死 7 分钟（19:16–19:23）：HTTP 与 WS 一起哑掉，
//      群里那条 @ 从没进过桥接，所以「没人回」。进程内的定时器会跟着一起卡死，救不了自己。
//   ② 桥接崩溃后没人重启（守护窗口本身也可能不在）。
//   `start.bat` 的守护循环只能救「进程退出」，救不了「进程卡住」；只有进程外的心跳能救卡住。
//
// 它做什么（默认每 30s 一次）：
//   探 GET /api/status（带 state/console-token）
//     ├─ 有响应（哪怕 401/500）→ 认为「活着」：事件循环还能跑。401 只告警不杀（避免令牌不匹配误杀）
//     └─ 超时/连接失败 → 失败计数 +1；连续 N 次（默认 3）→ 判定假死：
//          ① 先把证据落盘：探针错误、进程 CPU/内存/线程数、bridge.log 末尾几行 + 一份 incident JSON
//          ② 杀掉卡死的桥接进程（以及其它匹配 src\bridge.js 的残留实例）
//          ③ 等它自己回来（start.bat 守护窗口会在 5s 内重启）；30s 还没回来就自己拉 start.bat
//
// 日志一律落盘：`state/watchdog.log`（出事的证据也在里面）+ `state/watchdog-incident-*.json`。
//
// 用法：
//   node scripts/watchdog-bridge.mjs                  # 常驻（默认探针 30s；一般由 watchdog.cmd 拉起）
//   node scripts/watchdog-bridge.mjs --once           # 只探一次并打印结论（排查用，不杀不启动）
//   node scripts/watchdog-bridge.mjs --no-kill        # 常驻但只告警不杀（观察模式）
// 参数：--interval --timeout --failures --cooldown --grace --recover-wait
//       --url --token-file --lock-file --log --root --once --no-kill
//
// ⚠️ 部署要求：**必须从独立窗口 / 桌面启动器 / 计划任务启动**，不要在 DSH 会话里跑
//    （那会把看门狗挂到 DSH 的进程树上，DSH 一关它就被一起收走 —— 16.3 的教训）。
//    `qq-bridge\watchdog.cmd` 就是给桌面启动器 `D:\dsh\tools\start-bot.bat` 调用的。
//
// 不想让它动手时：建一个空文件 `state\watchdog.pause`（它只会记日志，不再杀/拉）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULTS = {
  url: 'http://127.0.0.1:3100/api/status',
  tokenFile: 'state/console-token',
  lockFile: 'state/bridge.lock',
  log: 'state/watchdog.log',
  selfLock: 'state/watchdog.lock',
  pauseFile: 'state/watchdog.pause',
  root: REPO_ROOT,
  intervalMs: 30000,      // 探针间隔
  timeoutMs: 8000,        // 单次探针超时（卡死时这里会真的等满）
  failures: 3,            // 连续失败几次判定假死（3 × 30s ≈ 90s 容忍）
  cooldownMs: 180000,     // 动手之后多久内不再动手（防抖）
  graceMs: 60000,         // 启动后的宽限期：桥接可能正在起来，这段时间只观察
  recoverWaitMs: 30000,   // 杀完之后等它自己回来（守护窗口 5s 重启）的时长
  once: false,
  noKill: false,
  scan: true,          // 是否顺手清掉其它匹配 src\bridge.js 的残留实例（--no-scan 只动锁里那个 PID）
  guardCmd: 'start.bat' // 需要自己拉起时执行的守护命令（可换成别的，便于演练/隔离测试）
};

/** 解析命令行 + 环境变量（env 便于测试）。 */
export function parseArgs(argv = [], env = process.env) {
  const out = { ...DEFAULTS };
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : d);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : undefined);
    if (a === '--once') out.once = true;
    else if (a === '--no-kill') out.noKill = true;
    else if (a === '--no-scan') out.scan = false;
    else if (a === '--guard-cmd') out.guardCmd = String(next() ?? out.guardCmd);
    else if (a === '--url') out.url = String(next() ?? out.url);
    else if (a === '--root') out.root = path.resolve(String(next() ?? out.root));
    else if (a === '--token-file') out.tokenFile = String(next() ?? out.tokenFile);
    else if (a === '--lock-file') out.lockFile = String(next() ?? out.lockFile);
    else if (a === '--log') out.log = String(next() ?? out.log);
    else if (a === '--interval') out.intervalMs = num(next(), out.intervalMs);
    else if (a === '--timeout') out.timeoutMs = num(next(), out.timeoutMs);
    else if (a === '--failures') out.failures = num(next(), out.failures);
    else if (a === '--cooldown') out.cooldownMs = num(next(), out.cooldownMs);
    else if (a === '--grace') out.graceMs = num(next(), out.graceMs);
    else if (a === '--recover-wait') out.recoverWaitMs = num(next(), out.recoverWaitMs);
  }
  // 相对路径一律相对仓库根，避免「从别的目录启动」时日志/锁跑到别处
  for (const key of ['tokenFile', 'lockFile', 'log', 'selfLock', 'pauseFile']) {
    if (!path.isAbsolute(out[key])) out[key] = path.join(out.root, out[key]);
  }
  if (env.QQ_BRIDGE_WATCHDOG_URL) out.url = String(env.QQ_BRIDGE_WATCHDOG_URL);
  if (env.QQ_BRIDGE_WATCHDOG_INTERVAL) out.intervalMs = num(env.QQ_BRIDGE_WATCHDOG_INTERVAL, out.intervalMs);
  return out;
}

/** 取文本末尾 n 行（用于把 bridge.log 尾巴塞进证据里）。 */
export function tailLines(text, n = 5) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(-Math.max(0, n));
}

/** 读锁文件里的 PID（老桥接也可能写了非数字内容 → 视为没有）。 */
export function readLockPid(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** 进程是否还活着（Windows 上 process.kill(pid, 0) 同样有效：不存在抛 ESRCH）。 */
export function isPidAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 单次探针。
 *
 * 语义（很重要）：**只要拿到 HTTP 响应就算「活着」**，非 2xx 不算失败 ——
 * 卡死的事件循环连响应都给不出来，而 401/500 说明进程还在正常服务。
 * 这样即使 console-token 不匹配，也不会把健康的桥接误杀。
 */
export async function httpProbe({ url, token = '', timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  if (typeof fetchImpl !== 'function') return { ok: false, status: null, ms: 0, error: '运行环境没有 fetch' };
  let target = url;
  try {
    const u = new URL(url);
    if (token) u.searchParams.set('token', token);
    target = u.toString();
  } catch { /* URL 不合法就原样试 */ }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  // ⚠️ 这个定时器**不能 unref**：探针期间事件循环里可能没有别的 handle，
  // unref 掉它会让进程直接退出（实测表现为「unsettled top-level await」）。
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch { /* 已 abort */ } }, timeoutMs) : null;
  try {
    const res = await fetchImpl(target, {
      headers: token ? { 'x-console-token': token } : {},
      signal: controller ? controller.signal : undefined
    });
    return { ok: true, status: res?.status ?? 0, ms: Date.now() - started, error: '' };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - started, error: error?.message ?? String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 决策（纯函数，便于单测）。
 * @returns {'healthy'|'observe'|'cooldown'|'restart'}
 */
export function decideAction({ probeOk, failures = 0, threshold = 3, sinceLastActionMs = Number.POSITIVE_INFINITY, cooldownMs = 180000 } = {}) {
  if (probeOk) return 'healthy';
  if (failures < threshold) return 'observe';
  if (sinceLastActionMs < cooldownMs) return 'cooldown';
  return 'restart';
}

/** 追加一行到看门狗日志（同时打到自己的控制台）。写日志失败也绝不抛。 */
export function makeLogger(logFile) {
  const write = (line) => {
    const stamped = `${new Date().toLocaleString('sv-SE')} [watchdog] ${line}`;
    try { console.log(stamped); } catch { /* 控制台没了也无所谓 */ }
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${stamped}\n`, 'utf8');
    } catch { /* 日志写不进去时不能让看门狗挂掉 */ }
    return stamped;
  };
  return write;
}

/** 取进程的 CPU/内存/线程数（只在出事时调用一次；best-effort，失败返回 null）。 */
function processSnapshot(pid) {
  return new Promise((resolve) => {
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if($p){"cpu=$([math]::Round($p.CPU,1))s;ws=$([math]::Round($p.WorkingSet64/1MB,1))MB;threads=$($p.Threads.Count)"}`
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ps.stdout.on('data', (d) => { out += d.toString(); });
      ps.on('error', () => resolve(null));
      ps.on('close', () => resolve(out.trim() || null));
      setTimeout(() => { try { ps.kill(); } catch { /* 已退出 */ } resolve(null); }, 8000).unref?.();
    } catch {
      resolve(null);
    }
  });
}

/** 列出所有「像桥接」的 node 进程（只在动手时查一次）。 */
function listBridgeProcesses() {
  return new Promise((resolve) => {
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -match \'bridge\\.js\' -and $_.CommandLine -notmatch \'runner\\.js\' -and $_.CommandLine -notmatch \'mcp-\' } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }'
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ps.stdout.on('data', (d) => { out += d.toString(); });
      ps.on('error', () => resolve([]));
      ps.on('close', () => {
        const rows = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
          const [pid, ...rest] = l.split('|');
          return { pid: Number(pid), cmd: rest.join('|') };
        }).filter((r) => Number.isFinite(r.pid) && r.pid > 0);
        resolve(rows);
      });
      setTimeout(() => { try { ps.kill(); } catch { /* 已退出 */ } resolve([]); }, 8000).unref?.();
    } catch {
      resolve([]);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 拉守护窗口（默认 start.bat，自带崩溃重启循环）。detached：它有自己的窗口，也不随看门狗退出而死。 */
export function startGuard(root, guardCmd = 'start.bat') {
  const target = path.isAbsolute(guardCmd) ? guardCmd : path.join(root, guardCmd);
  if (!fs.existsSync(target)) return { ok: false, error: `找不到守护命令 ${target}` };
  try {
    // 用 cmd /c 跑：既支持 start.bat（内含崩溃重启循环），也支持任意 .cmd（演练/隔离测试用）
    const child = spawn('cmd.exe', ['/c', target], { cwd: root, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 主循环（可注入依赖，方便测试）。 */
export async function runWatchdog(options = DEFAULTS, deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    logger = makeLogger(options.log),
    probe = httpProbe,
    isAlive = isPidAlive,
    snapshot = processSnapshot,
    listBridges = listBridgeProcesses,
    launchGuard = startGuard,
    sleepImpl = sleep,
    now = () => Date.now()
  } = deps;

  const readToken = () => { try { return fs.readFileSync(options.tokenFile, 'utf8').trim(); } catch { return ''; } };
  const readSelf = () => { try { return fs.readFileSync(options.selfLock, 'utf8').trim(); } catch { return ''; } };

  // 单实例：另一个看门狗还活着就退出（避免两个看门狗同时动手）。
  // --once 只是「探一次给我看」，不排队也不动手，所以不参与单实例锁。
  const selfPid = options.once ? null : Number(readSelf());
  if (selfPid && selfPid !== process.pid && isAlive(selfPid)) {
    logger(`已有看门狗在运行（PID ${selfPid}），本实例退出`);
    return { exit: 'already-running' };
  }
  if (!options.once) {
    try {
      fs.mkdirSync(path.dirname(options.selfLock), { recursive: true });
      fs.writeFileSync(options.selfLock, String(process.pid), 'utf8');
    } catch { /* 写不了就算了，不阻塞 */ }
  }
  const release = () => { try { if (!options.once && readSelf() === String(process.pid)) fs.rmSync(options.selfLock, { force: true }); } catch { /* ignore */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { logger('收到 SIGINT，退出'); release(); process.exit(0); });
  process.on('SIGTERM', () => { logger('收到 SIGTERM，退出'); release(); process.exit(0); });

  const startedAt = now();
  logger(`启动：探针 ${options.url}，每 ${Math.round(options.intervalMs / 1000)}s 一次，`
    + `连续 ${options.failures} 次失败判定假死，宽限 ${Math.round(options.graceMs / 1000)}s，冷却 ${Math.round(options.cooldownMs / 1000)}s`
    + `${options.noKill ? '（--no-kill 只告警不动手）' : ''}${options.once ? '（--once 只探一次）' : ''}`);

  let failures = 0;
  let lastActionAt = 0;
  let lastHealthyLogAt = 0;
  let firstFailureAt = 0;
  let lastTokenWarnAt = 0;

  for (;;) {
    const token = readToken();
    const paused = fs.existsSync(options.pauseFile);
    const res = await probe({ url: options.url, token, timeoutMs: options.timeoutMs, fetchImpl });
    const lockPid = readLockPid(options.lockFile);
    const lockAlive = lockPid ? isAlive(lockPid) : false;

    if (res.ok) {
      if (failures > 0) {
        logger(`✅ 已恢复：探针 http ${res.status}，${res.ms}ms（此前连续失败 ${failures} 次，`
          + `中断约 ${Math.round((now() - firstFailureAt) / 1000)}s）；bridge PID ${lockPid ?? '?'}`);
      } else if (options.once || now() - lastHealthyLogAt > 30 * 60000) {
        logger(`探针正常：http ${res.status}，${res.ms}ms，bridge PID ${lockPid ?? '(无锁)'}${lockAlive ? '' : ' ⚠️ 锁里的进程不存在'}`);
      }
      if (res.status === 401 || res.status === 403) {
        if (now() - lastTokenWarnAt > 600000) {
          lastTokenWarnAt = now();
          logger(`⚠️ 探针返回 http ${res.status}：进程活着但令牌不对 —— 检查 ${options.tokenFile} 与控制台令牌是否一致（不会因此判定假死）`);
        }
      }
      failures = 0;
      firstFailureAt = 0;
      lastHealthyLogAt = now();
      if (options.once) return { exit: 'once', healthy: true, pid: lockPid };
      await sleepImpl(options.intervalMs);
      continue;
    }

    failures += 1;
    if (!firstFailureAt) firstFailureAt = now();
    logger(`⚠️ 探针失败 ${failures}/${options.failures}：${res.error || '无响应'}（用时 ${res.ms}ms；`
      + `bridge PID ${lockPid ?? '无锁'} ${lockAlive ? '仍存在' : '不存在'}${paused ? '；已暂停' : ''}）`);

    const action = decideAction({
      probeOk: false,
      failures,
      threshold: options.failures,
      sinceLastActionMs: lastActionAt ? now() - lastActionAt : Number.POSITIVE_INFINITY,
      cooldownMs: options.cooldownMs
    });

    if (options.once) return { exit: 'once', healthy: false, failures, error: res.error };

    if (action === 'cooldown') {
      logger(`⏳ 刚动过手，冷却中（${Math.round((options.cooldownMs - (now() - lastActionAt)) / 1000)}s 后才会再动手）`);
      await sleepImpl(options.intervalMs);
      continue;
    }
    if (action !== 'restart') {
      await sleepImpl(options.intervalMs);
      continue;
    }
    // 启动宽限期：看门狗刚起来时，桥接可能正在启动（或正在被守护窗口重启），只观察不动手
    if (now() - startedAt < options.graceMs) {
      logger(`（启动宽限期内，先只观察：还剩 ${Math.round((options.graceMs - (now() - startedAt)) / 1000)}s）`);
      await sleepImpl(options.intervalMs);
      continue;
    }
    if (paused) {
      logger(`🛑 已暂停（存在 ${options.pauseFile}）：只留证据，不杀不拉。删掉该文件即恢复自动处理`);
      await sleepImpl(options.intervalMs);
      continue;
    }
    if (options.noKill) {
      logger('🛑 --no-kill：只告警不动手（要看它会不会动手，去掉这个参数）');
      lastActionAt = now();
      await sleepImpl(options.intervalMs);
      continue;
    }

    // ── 判定假死：先留证据，再动手 ────────────────────────────────────────────
    const incident = {
      at: new Date().toISOString(),
      probe: { url: options.url, failures, lastError: res.error, lastMs: res.ms },
      lockPid, lockAlive,
      outageMs: firstFailureAt ? now() - firstFailureAt : null,
      process: lockAlive ? await snapshot(lockPid) : null,
      bridgeLogTail: (() => {
        try { return tailLines(fs.readFileSync(path.join(options.root, 'state', 'bridge.log'), 'utf8'), 8); } catch { return []; }
      })(),
      action: { killed: [], guardStarted: null, recovered: null }
    };
    logger(`❌ 判定假死（连续 ${failures} 次失败，中断约 ${Math.round((incident.outageMs ?? 0) / 1000)}s）：开始留证`);
    if (incident.process) logger(`   进程快照：PID ${lockPid} ${incident.process}`);
    for (const line of incident.bridgeLogTail) logger(`   bridge.log | ${line}`);

    // 杀掉卡死的实例（含残留的重复实例）
    const targets = new Set();
    if (lockAlive) targets.add(lockPid);
    if (options.scan !== false) {
      for (const row of await listBridges()) targets.add(row.pid);
    }
    for (const pid of targets) {
      const alive = isAlive(pid);
      try {
        if (alive) process.kill(pid);
        incident.action.killed.push({ pid, wasAlive: alive, ok: true });
        logger(`🔪 已终止 PID ${pid}${alive ? '' : '（本来就没了）'}`);
      } catch (error) {
        incident.action.killed.push({ pid, wasAlive: alive, ok: false, error: error?.message ?? String(error) });
        logger(`⚠️ 终止 PID ${pid} 失败：${error?.message ?? error}`);
      }
    }
    lastActionAt = now();

    // 等它自己回来（start.bat 守护窗口 5s 内重启）
    let recovered = null;
    const deadline = now() + options.recoverWaitMs;
    while (now() < deadline) {
      await sleepImpl(2000);
      const again = await probe({ url: options.url, token: readToken(), timeoutMs: options.timeoutMs, fetchImpl });
      if (again.ok) { recovered = { by: 'guard', status: again.status, ms: again.ms, pid: readLockPid(options.lockFile) }; break; }
    }
    if (!recovered) {
      const started = launchGuard(options.root, options.guardCmd);
      incident.action.guardStarted = started;
      logger(started.ok ? `🚀 30s 内没自己回来，已拉起守护命令 ${options.guardCmd}（PID ${started.pid}）` : `⚠️ 拉起守护命令失败：${started.error}`);
      const deadline2 = now() + options.recoverWaitMs;
      while (now() < deadline2) {
        await sleepImpl(2000);
        const again = await probe({ url: options.url, token: readToken(), timeoutMs: options.timeoutMs, fetchImpl });
        if (again.ok) { recovered = { by: 'watchdog', status: again.status, ms: again.ms, pid: readLockPid(options.lockFile) }; break; }
      }
    }
    incident.action.recovered = recovered;
    if (recovered) logger(`✅ 已恢复（${recovered.by === 'guard' ? '守护窗口重启' : '看门狗拉起'}）：http ${recovered.status}，${recovered.ms}ms，bridge PID ${recovered.pid ?? '?'}`);
    else logger('❌ 仍未恢复：请手动看 state/bridge.log 与上面的证据');

    try {
      const file = path.join(options.root, 'state', `watchdog-incident-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(incident, null, 2)}\n`, 'utf8');
      logger(`🧾 事故记录：${path.relative(options.root, file)}`);
    } catch (error) {
      logger(`⚠️ 写 incident 文件失败：${error?.message ?? error}`);
    }

    failures = 0;
    firstFailureAt = 0;
    await sleepImpl(options.intervalMs);
  }
}

// 直接执行时跑常驻循环
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  runWatchdog(options).catch((error) => {
    makeLogger(options.log)(`💥 看门狗异常退出：${error?.stack ?? error}`);
    process.exit(1);
  });
}
