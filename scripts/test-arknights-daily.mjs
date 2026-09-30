// arknights-daily 执行器的离线回归：不联网、不起 MAA、不杀进程（全部注入假实现）。
// 用法：node scripts/test-arknights-daily.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ARKNIGHTS,
  decidePreflight,
  findCompletion,
  formatJobReport,
  mergeConfig,
  parseAdbDevices,
  parseArgs,
  runJob,
  tailLines
} from './arknights-daily.mjs';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── parseArgs / mergeConfig ──────────────────────────────────────────────
const a = parseArgs(['--dry-run', '--timeout', '900', '--no-close-client', '--trigger', 'hotkey']);
assert('parseArgs 解析', a.dryRun && a.timeoutSec === 900 && a.closeClient === false && a.trigger === 'hotkey');
const cfg0 = mergeConfig(null, {});
assert('默认路径是这台机器的实际路径', cfg0.maaPath.includes('MAA.exe') && cfg0.adbAddress === '127.0.0.1:16384');
assert('默认跑完即停 + 30 分钟兜底', cfg0.timeoutSec === 1800 && cfg0.closeClient === true && cfg0.closeMaa === true);
const cfg1 = mergeConfig({ timeoutSec: 60, trigger: 'weird', stateFile: 'state/x.json' }, { timeoutSec: 30 });
assert('命令行覆盖配置 + 非法 trigger 回退 auto', cfg1.timeoutSec === 30 && cfg1.trigger === 'auto');
assert('相对 stateFile 转成仓库内绝对路径', path.isAbsolute(cfg1.stateFile) && cfg1.stateFile.endsWith(path.join('state', 'x.json')));

// ── parseAdbDevices ──────────────────────────────────────────────────────
const dev = parseAdbDevices('List of devices attached\r\n127.0.0.1:16384\tdevice\r\nemulator-5554\toffline\r\n\r\n');
assert('解析 adb devices', dev.length === 2 && dev[0].serial === '127.0.0.1:16384' && dev[0].state === 'device' && dev[1].state === 'offline');
assert('空输入安全', parseAdbDevices('').length === 0);

// ── findCompletion（判据取自真实 asst.log 格式）──────────────────────────
const done = '[2026-09-28 15:03:15.967][INF][Px17648][Tx54760] Assistant::append_callback | AllTasksCompleted {"finished_tasks":[1,2,3,4,5],"taskchain":"Mall","taskid":5,"uuid":"0000000000080D18"}';
const c1 = findCompletion(done);
assert('识别 AllTasksCompleted + finished_tasks', c1.allTasksCompleted === true && c1.finishedTasks.join(',') === '1,2,3,4,5');
const c2 = findCompletion('Assistant::append_callback | TaskChainError {"taskchain":"Fight","taskid":1}');
assert('识别 TaskChainError', c2.allTasksCompleted === false && c2.taskChainError === true && c2.errorSample.includes('Fight'));
assert('什么都没有时全 false', (() => { const c = findCompletion('随便一行'); return !c.allTasksCompleted && !c.taskChainError; })());
assert('识别卡死超时', findCompletion('ERR | StallTimeout triggered').stallTimeout === true);

// ── decidePreflight ─────────────────────────────────────────────────────
const p1 = decidePreflight({ elevated: true, maaExists: true, adbDeviceOnline: true });
assert('一切正常 → 放行', p1.ok === true && p1.blockers.length === 0);
const p2 = decidePreflight({ elevated: false, maaExists: true, adbDeviceOnline: true });
assert('没提权 → 拦住并说清原因', p2.ok === false && p2.blockers.join('').includes('管理员'));
const p3 = decidePreflight({ elevated: true, maaExists: false, adbDeviceOnline: false, adbError: 'cannot connect' });
assert('MAA 不存在 → 拦住；ADB 未连只算警告', p3.ok === false && p3.blockers.join('').includes('MAA.exe') && p3.warnings.join('').includes('ADB'));
const p4 = decidePreflight({ elevated: true, maaExists: true, adbDeviceOnline: true, portOwner: 'MuMuPlayer' });
assert('端口被 MuMu 占 → 警告（可能连错目标）', p4.ok === true && p4.warnings.join('').includes('MuMu'));

// ── formatJobReport ─────────────────────────────────────────────────────
const rep1 = formatJobReport({ ok: true, startedAt: 0, finishedAt: 600000, reason: 'MAA 报告 AllTasksCompleted', finishedTasks: [1, 2], closedClient: true });
assert('成功报告含耗时/任务/关客户端', rep1.includes('跑完了') && rep1.includes('10 分') && rep1.includes('1/2') && rep1.includes('已关闭'), rep1);
const rep2 = formatJobReport({ ok: false, startedAt: 0, finishedAt: 65000, reason: 'MAA 已退出，但日志里没看到 AllTasksCompleted', logTail: ['line1'] });
assert('失败报告含原因与日志尾巴', rep2.includes('没跑成') && rep2.includes('AllTasksCompleted') && rep2.includes('line1'), rep2);

assert('tailLines 取末尾 n 行', tailLines('a\nb\nc\nd', 2).join(',') === 'c,d');

// ── runJob 集成（全注入）───────────────────────────────────────────────
function tmpCfg(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ark-'));
  const logFile = path.join(dir, 'ark.log');
  const maaLog = path.join(dir, 'asst.log');
  fs.writeFileSync(maaLog, 'old line\n');
  return {
    cfg: {
      ...DEFAULT_ARKNIGHTS, ...extra,
      maaPath: path.join(dir, 'MAA.exe'), maaLogPath: maaLog, maaConfigPath: path.join(dir, 'gui.new.json'),
      logFile, stateFile: path.join(dir, 'state.json'), lockFile: path.join(dir, 'lock'), requestFile: path.join(dir, 'req.json'),
      timeoutSec: 30, pollSec: 1, toolExitQuietSec: 0,   // 虚拟时钟下别为"退出判定"真等 60s
    },
    dir, maaLog
  };
}
const collector = () => { const lines = []; const fn = (l) => { lines.push(l); return l; }; fn.lines = lines; return fn; };
// 虚拟时钟：让 sleep 真的推进时间，否则「等客户端 30s / 等 ADB / 超时兜底」在测试里会真空转
function virtualClock(start = 1750000000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += Math.max(1, Number(ms) || 1); } };
}

// 场景 1：跑完即停（日志里出现 AllTasksCompleted）
{
  const { cfg, maaLog } = tmpCfg({ trigger: 'hotkey' });
  const logs = collector();
  const clock = virtualClock();
  let ticks = 0;
  let maaUp = false;                     // MAA 只在 startMaa 之后才算"在跑"（起之前若已在跑会被守卫拦下）
  let adbCalls = 0;                      // PC 端模式下 ADB 相关的调用应当为 0（2026-09-29 的误报回归）
  let windowChecks = 0;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    windowReady: async () => { windowChecks += 1; return true; },
    maaConnectMode: async () => 'pc',
    exists: () => true,
    adbConnect: async () => { adbCalls += 1; return { ok: true, devices: [{ serial: cfg.adbAddress, state: 'device' }], raw: '' }; },
    portOwner: async () => '',
    startMaa: async () => { maaUp = true; return { ok: true, pid: 1234 }; },
    sendHotkey: async () => ({ ok: true }),
    prepareMaa: async () => ({ ok: true, changed: false }),
    startClient: async () => ({ ok: true, pid: 4321 }),
    listProcesses: async () => (maaUp ? ['Arknights', 'MAA'] : ['Arknights']),   // 游戏已在跑 → 跳过候选链
    killByName: async () => ({ killed: ['MAA.exe', 'Arknights.exe'], failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
      ticks += 1;
      if (ticks === 2) fs.appendFileSync(maaLog, 'Assistant::append_callback | AllTasksCompleted {"finished_tasks":[1,2,3]}\n');
    }
  });
  assert('跑到 AllTasksCompleted 就停', job.ok === true && job.reason.includes('AllTasksCompleted') && job.finishedTasks.join(',') === '1,2,3', JSON.stringify({ ok: job.ok, r: job.reason }));
  assert('收尾关了 MAA 与客户端', job.closedMaa === true && job.closedClient === true && job.clientKilled.includes('Arknights.exe'));
  assert('用了热键触发路径', logs.lines.some((l) => l.includes('已发送 Link Start 热键')));
  // 2026-09-29 22:0x 的两条教训（owner 实测）：
  assert('检测到游戏进程时要**明确打一行**（不能只在失败时说话）', logs.lines.some((l) => l.includes('官方 PC 端已在运行（匹配进程：')), logs.lines.filter((l) => l.includes('游戏')).join(' | '));
  assert('PC 端模式不碰 ADB（不调用、不警告、不等待）', adbCalls === 0 && job.connectMode === 'pc' && logs.lines.some((l) => l.includes('PC 端模式（Win32 截图/点击）：不等 ADB')) && !logs.lines.some((l) => l.includes('ADB 还是没连上')), `adbCalls=${adbCalls} connectMode=${job.connectMode}`);
  assert('起 MAA 之前确认过游戏窗口', windowChecks >= 1);
}

// 场景 2：MAA 中途退出且没有完成标记 → 失败（不空等到超时）
{
  const { cfg } = tmpCfg({ trigger: 'auto' });
  const clock = virtualClock();
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    windowReady: async () => true,
    maaConnectMode: async () => 'adb',
    exists: () => true,
    adbConnect: async () => ({ ok: false, devices: [], raw: '', error: 'cannot connect' }),
    portOwner: async () => '',
    startMaa: async () => ({ ok: true, pid: 55 }),
    listProcesses: async () => ['explorer'],           // 没有 MAA 了
    prepareMaa: async () => ({ ok: true, changed: true }),
    startClient: async () => ({ ok: true, pid: 4321 }),
    killByName: async () => ({ killed: [], failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: collector(),
    sleep: async (ms) => { clock.advance(ms); },       // 虚拟时钟：ADB 等待循环不会真耗 90 秒
    now: clock.now
  });
  assert('MAA 早退 → 判失败并说明原因', job.ok === false && job.reason.includes('没看到完成标记'), job.reason);
  assert('ADB 未连只是警告，不阻断（交给 MAA）', job.elevated === true);
}

// 场景 2b：**顺序必须是「先起客户端 → 等 30 秒 → 再起 MAA」**（owner 实测 MAA 拉不起客户端）
{
  const { cfg, dir } = tmpCfg({ trigger: 'auto', clientWaitSec: 30, adbWaitSec: 10 });
  const order = [];
  const logs = collector();
  const clock = virtualClock();
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    windowReady: async () => true,
    maaConnectMode: async () => 'pc',
    exists: () => true,
    adbConnect: async () => { order.push('adb'); return { ok: true, devices: [{ serial: cfg.adbAddress, state: 'device' }], raw: '' }; },
    portOwner: async () => '',
    startClient: async () => { order.push('client'); return { ok: true, pid: 777 }; },
    startMaa: async () => { order.push('maa'); return { ok: true, pid: 888 }; },
    prepareMaa: async () => { order.push('prepareMaa'); return { ok: true, changed: true }; },
    // 候选一（游戏本体）就把游戏拉起来了 → 后面不该再试候选二
    listProcesses: async () => (order.includes('maa') ? ['Arknights', 'MAA'] : (order.includes('client') ? ['Arknights'] : ['explorer'])),
    killByName: async () => ({ killed: ['MAA.exe'], failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    sleep: async (ms) => { order.push(`sleep:${ms}`); clock.advance(ms); },
    now: clock.now
  });
  const ci = order.indexOf('client');
  const mi = order.indexOf('maa');
  assert('先起客户端、后起 MAA', ci >= 0 && mi > ci, order.join(' → '));
  assert('起客户端后至少等了 clientWaitSec（30s）', order.includes('sleep:30000'), order.join(' → '));
  assert('起 MAA 之前先调好了 MAA 设置', order.indexOf('prepareMaa') < mi, order.join(' → '));
  assert('这次没跑到完成 → 超时兜底（但顺序是对的）', job.ok === false, job.reason);
  assert('候选一成功就不再试候选二', order.filter((x) => x === 'client').length === 1, order.join(' → ').slice(0, 160));
  assert('候选一成功时要打「✅ 检测到游戏进程」', logs.lines.some((l) => l.includes('✅ 检测到游戏进程')), logs.lines.filter((l) => l.includes('游戏')).join(' | '));
  assert('收尾关了 MAA', job.closedMaa === true);
}

// 场景 2c：客户端已在运行 → 不重复启动，直接等 ADB
{
  const { cfg } = tmpCfg({ trigger: 'auto' });
  const clock = virtualClock();
  let clientStarts = 0;
  const procs = ['Arknights'];            // 客户端已在跑；MAA 要等 startMaa 之后才出现在列表里
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    windowReady: async () => true,
    maaConnectMode: async () => 'pc',
    exists: () => true,
    adbConnect: async () => ({ ok: true, devices: [{ serial: cfg.adbAddress, state: 'device' }], raw: '' }),
    portOwner: async () => '',
    startClient: async () => { clientStarts += 1; return { ok: true, pid: 1 }; },
    startMaa: async () => { procs.push('MAA'); return { ok: true, pid: 2 }; },
    prepareMaa: async () => ({ ok: true, changed: false }),
    listProcesses: async () => procs.slice(),
    killByName: async () => ({ killed: [], failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: collector(),
    sleep: async (ms) => { clock.advance(ms); },
    now: clock.now
  });
  assert('客户端已在运行 → 不再重复拉启动器', clientStarts === 0 && job.startedClient === true, JSON.stringify({ clientStarts, startedClient: job.startedClient }));
}

// 场景 2d：MAA 已经在跑 → 直接拒绝（避免两个 MAA 抢客户端 / 覆盖刚写的设置）
{
  const { cfg } = tmpCfg({ trigger: 'auto' });
  const clock = virtualClock();
  let started = 0;
  let clientStarts = 0;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    windowReady: async () => true,
    maaConnectMode: async () => 'pc',
    exists: () => true,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    listProcesses: async () => ['MAA'],
    startClient: async () => { clientStarts += 1; return { ok: true, pid: 1 }; },
    startMaa: async () => { started += 1; return { ok: true, pid: 2 }; },
    prepareMaa: async () => ({ ok: true, changed: false }),
    log: collector(),
    sleep: async (ms) => { clock.advance(ms); },
    now: clock.now
  });
  assert('MAA 已在运行 → 不启动新的 MAA、也不拉客户端', job.ok === false && started === 0 && clientStarts === 0 && job.reason.includes('MAA 已经在运行'), job.reason);
}

// 场景 3：没提权 → 直接拦住，连 MAA 都不启动
{
  const { cfg } = tmpCfg();
  let started = 0;
  const job = await runJob(cfg, {}, {
    isElevated: async () => false,
    windowReady: async () => true,
    maaConnectMode: async () => 'pc',
    exists: () => true,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startMaa: async () => { started += 1; return { ok: true, pid: 1 }; },
    log: collector(),
    sleep: async () => {}
  });
  assert('没提权 → 拦住且不启动 MAA', job.ok === false && started === 0 && job.reason.includes('管理员'), job.reason);
}

// 场景 4：--dry-run 只预检
{
  const { cfg } = tmpCfg();
  let started = 0;
  const job = await runJob(cfg, { dryRun: true }, {
    isElevated: async () => true,
    windowReady: async () => true,
    maaConnectMode: async () => 'pc',
    exists: () => true,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startMaa: async () => { started += 1; return { ok: true, pid: 1 }; },
    log: collector(),
    sleep: async () => {}
  });
  assert('dry-run：预检通过且不启动 MAA', job.ok === true && job.dryRun === true && started === 0 && job.reason.includes('dry-run'));
}

// 场景 5：超时兜底
{
  const { cfg } = tmpCfg({ timeoutSec: 2, toolExitQuietSec: 0 });
  const clock = { t: 1750000000000 };
  let maaUp = false;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    windowReady: async () => true,
    maaConnectMode: async () => 'pc',
    exists: () => true,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startMaa: async () => { maaUp = true; return { ok: true, pid: 9 }; },
    prepareMaa: async () => ({ ok: true, changed: false }),
    startClient: async () => ({ ok: true, pid: 4321 }),
    listProcesses: async () => (maaUp ? ['MAA'] : ['explorer']),
    killByName: async () => ({ killed: ['MAA.exe'], failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },     // 虚拟时钟：快速走到超时
    log: collector()
  });
  assert('超时兜底：等满就收手', job.ok === false && job.reason.includes('超时兜底'), job.reason);
}

console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
