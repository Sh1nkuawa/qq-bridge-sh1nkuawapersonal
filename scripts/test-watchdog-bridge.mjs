// watchdog-bridge（外部看门狗）纯函数 + 假探针回归测试：不联网、不杀进程、不启动桥接。
// 用法：node scripts/test-watchdog-bridge.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS,
  decideAction,
  httpProbe,
  isPidAlive,
  makeLogger,
  parseArgs,
  readLockPid,
  runWatchdog,
  startGuard,
  tailLines
} from './watchdog-bridge.mjs';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── parseArgs ────────────────────────────────────────────────────────────
const d = parseArgs([], {});
assert('默认间隔 30s / 超时 8s / 连续 3 次', d.intervalMs === 30000 && d.timeoutMs === 8000 && d.failures === 3);
const o = parseArgs(['--interval', '15000', '--timeout', '4000', '--failures', '4', '--once', '--no-kill'], {});
assert('参数覆盖', o.intervalMs === 15000 && o.timeoutMs === 4000 && o.failures === 4 && o.once === true && o.noKill === true);
const o2 = parseArgs(['--root', 'D:\\tmp\\x'], {});
assert('相对路径按 root 解析成绝对路径', path.isAbsolute(o2.log) && o2.log.startsWith(path.resolve('D:\\tmp\\x')), o2.log);
assert('默认值里探针指向桥接控制台', DEFAULTS.url.includes('127.0.0.1:3100/api/status'));
const o3 = parseArgs(['--no-scan', '--guard-cmd', 'my-guard.cmd'], {});
assert('--no-scan / --guard-cmd 生效', o3.scan === false && o3.guardCmd === 'my-guard.cmd');

// ── startGuard：真的要能拉起守护命令（演练时用 --guard-cmd 指向标记脚本）──
{
  const gt = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-watchdog-guard-'));
  const marker = path.join(gt, 'guarded.txt');
  const cmd = path.join(gt, 'marker.cmd');
  fs.writeFileSync(cmd, `@echo off\r\necho ran > "${marker}"\r\n`, 'utf8');
  const r = startGuard(gt, 'marker.cmd');
  assert('startGuard 返回 PID', r.ok === true && Number.isFinite(r.pid), JSON.stringify(r));
  const t0 = Date.now();
  while (!fs.existsSync(marker) && Date.now() - t0 < 5000) await new Promise((r2) => setTimeout(r2, 100));
  assert('守护命令确实被执行了（标记文件出现）', fs.existsSync(marker));
  assert('守护命令不存在时明确失败', startGuard(gt, 'nope.cmd').ok === false);
  try { fs.rmSync(gt, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── tailLines ────────────────────────────────────────────────────────────
assert('tailLines 取末尾 n 行且忽略空行', JSON.stringify(tailLines('a\n\nb\nc\n', 2)) === JSON.stringify(['b', 'c']));
assert('tailLines 对空输入安全', tailLines(null, 3).length === 0);

// ── readLockPid / isPidAlive ─────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-watchdog-'));
const lock = path.join(tmp, 'bridge.lock');
fs.writeFileSync(lock, '4321\n', 'utf8');
assert('读锁文件 PID', readLockPid(lock) === 4321);
fs.writeFileSync(lock, 'not-a-pid', 'utf8');
assert('锁文件内容不是数字 → null', readLockPid(lock) === null);
fs.rmSync(lock);
assert('锁文件不存在 → null', readLockPid(lock) === null);
assert('自己一定活着', isPidAlive(process.pid) === true);
assert('不存在的 PID 判为死', isPidAlive(999999) === false);
assert('非法 PID 判为死', isPidAlive(0) === false && isPidAlive(NaN) === false);

// ── decideAction ─────────────────────────────────────────────────────────
const D = (x) => decideAction(x);
assert('探针正常 → healthy', D({ probeOk: true, failures: 9 }) === 'healthy');
assert('失败但没到阈值 → observe', D({ probeOk: false, failures: 2, threshold: 3 }) === 'observe');
assert('到阈值 → restart', D({ probeOk: false, failures: 3, threshold: 3 }) === 'restart');
assert('刚动过手 → cooldown', D({ probeOk: false, failures: 3, threshold: 3, sinceLastActionMs: 1000, cooldownMs: 180000 }) === 'cooldown');
assert('冷却结束 → 又能动手', D({ probeOk: false, failures: 3, threshold: 3, sinceLastActionMs: 200000, cooldownMs: 180000 }) === 'restart');

// ── httpProbe：只要拿到响应就算活着（401 不能误杀）──────────────────────
const okFetch = async () => ({ ok: true, status: 200 });
const p1 = await httpProbe({ url: 'http://x/api/status', token: 'tok', fetchImpl: okFetch });
assert('200 → 活着', p1.ok === true && p1.status === 200);
const p2 = await httpProbe({ url: 'http://x/api/status', token: 'tok', fetchImpl: async () => ({ ok: false, status: 401 }) });
assert('401 → 仍算活着（令牌不匹配不是假死）', p2.ok === true && p2.status === 401);
const p3 = await httpProbe({ url: 'http://x/api/status', fetchImpl: async () => { throw new Error('fetch failed'); } });
assert('连接失败 → 判死（fetch failed）', p3.ok === false && p3.error === 'fetch failed');
let seenUrl = '';
await httpProbe({ url: 'http://x/api/status', token: 'abc', fetchImpl: async (u) => { seenUrl = u; return { ok: true, status: 200 }; } });
assert('token 会带上（query + 头）', seenUrl.includes('token=abc'), seenUrl);
const hang = await httpProbe({
  url: 'http://x', timeoutMs: 120,
  fetchImpl: (u, init) => new Promise((_, reject) => {
    if (!init?.signal) return;                        // 没有 signal 就真挂住 → 用例会超时失败，正好暴露问题
    if (init.signal.aborted) return reject(new Error('aborted'));
    init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
  })
});
assert('卡住的探针在超时内失败（不会把看门狗挂住）', hang.ok === false, `err=${hang.error} ms=${hang.ms}`);

// ── makeLogger 落盘 ─────────────────────────────────────────────────────
const logFile = path.join(tmp, 'watchdog.log');
const log = makeLogger(logFile);
log('测试一行');
log('第二行');
const logged = fs.readFileSync(logFile, 'utf8');
assert('日志落盘且带时间戳/前缀', logged.includes('[watchdog] 测试一行') && logged.includes('第二行') && /\d{4}-\d{2}-\d{2} /.test(logged));

// ── runWatchdog 集成（全注入，不联网不杀进程）──────────────────────────
function fakeOptions(extra = {}) {
  return {
    url: 'http://stub/api/status',
    tokenFile: path.join(tmp, 'console-token'),
    lockFile: path.join(tmp, 'bridge2.lock'),
    log: path.join(tmp, 'watchdog2.log'),
    selfLock: path.join(tmp, 'watchdog2.lock'),
    pauseFile: path.join(tmp, 'watchdog2.pause'),
    root: tmp,
    intervalMs: 1,
    timeoutMs: 50,
    failures: 3,
    cooldownMs: 1000,
    graceMs: 0,
    recoverWaitMs: 1,
    once: false,
    noKill: false,
    ...extra
  };
}
function collector() {
  const lines = [];
  const fn = (l) => { lines.push(l); return l; };
  fn.lines = lines;
  return fn;
}
// 虚拟时钟：让 sleep 真的推进时间，否则冷却/截止时间这些判断在测试里永远不前进（会空转）
function virtualClock(start = 1750000000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += Math.max(1, Number(ms) || 1); } };
}

// 场景 1：桥接没了（探针一直失败、没有活着的进程）→ 判定假死 → 拉守护命令 → 恢复
{
  const opts = fakeOptions({ recoverWaitMs: 2000 });
  fs.writeFileSync(opts.lockFile, '4242', 'utf8');
  const logs = collector();
  const clock = virtualClock();
  let guardLaunched = 0;
  let ticks = 0;
  const result = await runWatchdog(opts, {
    logger: logs,
    isAlive: () => false,                                  // 没有任何真实进程参与
    listBridges: async () => [],
    snapshot: async () => null,
    launchGuard: () => { guardLaunched += 1; return { ok: true, pid: 777 }; },
    sleepImpl: async (ms) => { clock.advance(ms); ticks += 1; if (ticks > 200) throw new Error('测试防跑飞'); },
    probe: async () => ({ ok: guardLaunched > 0, status: 200, ms: 5, error: guardLaunched > 0 ? '' : 'fetch failed' }),
    now: clock.now
  }).catch((e) => ({ exit: 'throw', error: e.message }));
  assert('桥接没了 → 会拉守护命令', guardLaunched === 1, JSON.stringify(result));
  assert('恢复后有「已恢复」日志', logs.lines.some((l) => l.includes('已恢复')), logs.lines.slice(-2).join(' / '));
  assert('留证日志包含判定假死', logs.lines.some((l) => l.includes('判定假死')));
  assert('会写 incident 证据文件', fs.readdirSync(path.join(tmp, 'state')).some((f) => f.startsWith('watchdog-incident-')),
    (() => { try { return fs.readdirSync(path.join(tmp, 'state')).join(','); } catch { return '(无 state 目录)'; } })());
}

// 场景 2：探针正常 → 只记一行健康日志，不动手
{
  const opts = fakeOptions();
  const logs = collector();
  const clock = virtualClock();
  let guardLaunched = 0;
  let ticks = 0;
  await runWatchdog(opts, {
    logger: logs,
    isAlive: () => true,
    listBridges: async () => [],
    launchGuard: () => { guardLaunched += 1; return { ok: true }; },
    sleepImpl: async (ms) => { clock.advance(ms); ticks += 1; if (ticks > 3) throw new Error('stop'); },
    probe: async () => ({ ok: true, status: 200, ms: 3, error: '' }),
    now: clock.now
  }).catch(() => {});
  assert('健康时不拉守护命令', guardLaunched === 0);
  assert('健康时写健康日志', logs.lines.some((l) => l.includes('探针正常')));
}

// 场景 3：暂停文件存在 → 判定假死也不动手
{
  const opts = fakeOptions();
  fs.writeFileSync(opts.pauseFile, '', 'utf8');
  const logs = collector();
  const clock = virtualClock();
  let guardLaunched = 0;
  let ticks = 0;
  await runWatchdog(opts, {
    logger: logs,
    isAlive: () => true,
    listBridges: async () => [],
    launchGuard: () => { guardLaunched += 1; return { ok: true }; },
    snapshot: async () => 'cpu=1s',
    sleepImpl: async (ms) => { clock.advance(ms); ticks += 1; if (ticks > 10) throw new Error('stop'); },
    probe: async () => ({ ok: false, status: null, ms: 10, error: 'fetch failed' }),
    now: clock.now
  }).catch(() => {});
  assert('暂停时不拉守护命令', guardLaunched === 0);
  assert('暂停时会说明原因', logs.lines.some((l) => l.includes('已暂停')));
  fs.rmSync(opts.pauseFile, { force: true });
}

// 场景 4：--once 只探一次，绝不动手（且不受单实例锁影响）
{
  const opts = fakeOptions({ once: true });
  fs.writeFileSync(opts.selfLock, '1', 'utf8');   // 假装已有看门狗在跑
  const logs = collector();
  let guardLaunched = 0;
  const r = await runWatchdog(opts, {
    logger: logs,
    isAlive: () => true,
    listBridges: async () => [],
    launchGuard: () => { guardLaunched += 1; return { ok: true }; },
    probe: async () => ({ ok: false, status: null, ms: 10, error: 'fetch failed' })
  });
  assert('--once 失败即返回、不动手、也不受单实例锁影响', r.exit === 'once' && r.healthy === false && guardLaunched === 0, JSON.stringify(r));
}

// 场景 4b：--once 探到健康
{
  const opts = fakeOptions({ once: true });
  const logs = collector();
  const r = await runWatchdog(opts, {
    logger: logs,
    isAlive: () => true,
    probe: async () => ({ ok: true, status: 200, ms: 4, error: '' })
  });
  assert('--once 健康时返回 healthy', r.exit === 'once' && r.healthy === true, JSON.stringify(r));
  fs.rmSync(opts.selfLock, { force: true });
}

// 场景 5：已有看门狗在跑 → 本实例退出（单实例保护）
{
  const opts = fakeOptions();
  fs.writeFileSync(opts.selfLock, '1', 'utf8');   // PID 1 当作「别的看门狗」
  const logs = collector();
  const r = await runWatchdog(opts, { logger: logs, isAlive: () => true, probe: async () => ({ ok: true, status: 200, ms: 1, error: '' }) });
  assert('单实例保护：已有看门狗就退出', r.exit === 'already-running', JSON.stringify(r));
  fs.rmSync(opts.selfLock, { force: true });
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
