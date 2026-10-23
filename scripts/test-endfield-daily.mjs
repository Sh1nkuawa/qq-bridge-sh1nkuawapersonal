// 终末地档案（MAAEND/MXU）的离线回归：档案默认值、声明式补丁、多日志监听、计数式完成判据。
// 用法：node scripts/test-endfield-daily.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ENDFIELD,
  REPO_ROOT,
  countPatterns,
  countPatternsSince,
  countTaskEvents,
  defaultExpectedTaskCount,
  defaultPrepareMaa,
  findCompletion,
  formatLogTime,
  isGameRunning,
  mergeConfig,
  resolveWatchFiles,
  runJob,
  submittedTaskCount
} from './endfield-daily.mjs';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── 档案默认值 ───────────────────────────────────────────────────────────
const ef = mergeConfig(null, {}, REPO_ROOT, 'endfield');
assert('档案名与工具', ef.profile === 'endfield' && ef.maaPath.endsWith('MaaEnd.exe'), ef.maaPath);
assert('MAAEND 跟执行器一样提权跑（Win32-Front 本身要求权限；owner 实测降权出问题）', ef.maaDeElevated === false);
assert('PC 端模式：不等 ADB', ef.connectMode === 'pc');
assert('工具进程名是 MaaEnd', ef.toolProcessNames.join(',') === 'MaaEnd');
assert('兜底热键是 F10', ef.triggerHotkey.keys === '{F10}', JSON.stringify(ef.triggerHotkey));
assert('状态/锁/请求文件独立于方舟那份', ef.stateFile.endsWith(path.join('state', 'endfield-daily.json')) && ef.lockFile.endsWith('endfield-daily.lock') && ef.requestFile.endsWith('endfield-daily-request.json'));
assert('计划任务名独立', ef.taskName === 'qq-bridge-endfield-daily');
assert('30 分钟兜底', ef.timeoutSec === 1800);
assert('完成文案判据里有"任务已全部完成"', ef.completionPatterns.includes('任务已全部完成'), ef.completionPatterns.join('/'));
assert('成功计数认 Succeeded 与 Completed', ef.successPatterns.join(',') === 'Tasker\\.Task\\.Succeeded,Tasker\\.Task\\.Completed', ef.successPatterns.join(','));
assert('日志监听目录指向 MAAEND\\debug', ef.maaLogDirs.join(',') === 'G:\\MAAEND\\debug', ef.maaLogDirs.join(','));
// 2026-10-23 真机实测后的定案：
//   · 直启 Endfield.exe 会被"启动票据"校验拒绝（弹窗「游戏启动失败」）；
//   · Launcher.exe --game/--reason **不触发启动**（冷/热各试一次都只开界面）；
//   · 启动器 UI 不暴露 UIA（Qt/CefView，0 个后代元素）⇒ 只能**按坐标点「开始游戏」**。
// 所以首选候选是"点启动器"，Endfield.exe 只留作老版本兜底。
assert('启动候选：首选「点启动器开始游戏」（click 标记必须活过归一化）',
  ef.clientCandidates[0].exe.endsWith('Launcher.exe')
  && ef.clientCandidates[0].click === true
  && ef.clientCandidates[0].launcher === true,
  JSON.stringify(ef.clientCandidates));
assert('点击几何参数：期望 1640x943、点 (1397,816)（客户区坐标）',
  ef.launcherClick && ef.launcherClick.expect.width === 1640 && ef.launcherClick.expect.height === 943
  && ef.launcherClick.point.x === 1397 && ef.launcherClick.point.y === 816,
  JSON.stringify(ef.launcherClick));
assert('尺寸不符时先尝试把窗口调成期望尺寸（否则宁可放弃点击）',
  ef.launcherClick.resizeIfNeeded === true, String(ef.launcherClick.resizeIfNeeded));
assert('启动候选：Endfield.exe 仍在链上兜底（老版本/启动器缺失时）',
  ef.clientCandidates[1].exe.endsWith('Endfield Game\\Endfield.exe'),
  JSON.stringify(ef.clientCandidates.map((c) => c.exe)));
assert('标记了启动器进程名（用于识别"启动器本来开着"→单实例吞参数的场景）',
  ef.launcherProcessNames.includes('Games.exe') && ef.launcherProcessNames.includes('Launcher.exe'),
  JSON.stringify(ef.launcherProcessNames));
assert('closeLauncher 默认开启（收尾连启动器一起关，避免第二天又撞单实例兜底）',
  ef.closeLauncher === true, String(ef.closeLauncher));

// 方舟档案没被改坏（回归）
const ark = mergeConfig(null, {}, REPO_ROOT, 'arknights');
assert('方舟档案仍然：MAA.exe / MAA / AllTasksCompleted / asst.log',
  ark.profile === 'arknights' && ark.maaPath.endsWith('MAA.exe') && ark.toolProcessNames.join(',') === 'MAA'
  && ark.completionPatterns.join(',') === 'AllTasksCompleted' && ark.maaLogPath.endsWith('asst.log')
  && ark.stateFile.endsWith(path.join('state', 'arknights-daily.json')), `${ark.maaPath} ${ark.completionPatterns}`);

// ── 声明式补丁（prepareMaa）─────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-end-'));
const mxuFile = path.join(dir, 'mxu-MaaEnd.json');
fs.writeFileSync(mxuFile, JSON.stringify({ version: '1.0', settings: { autoRunOnLaunch: false, hotkeys: { startTasks: 'F10' } }, instances: [] }, null, 2), 'utf8');
const mxuCfg = mergeConfig({ maaConfigPath: mxuFile }, {}, REPO_ROOT, 'endfield');
const p1 = await defaultPrepareMaa(mxuCfg);
assert('补丁：把 autoRunOnLaunch 打开', p1.ok === true && p1.changed === true && p1.items.join(',').includes('autoRunOnLaunch'));
assert('补丁：写前备份 .bak-gamedaily', fs.existsSync(`${mxuFile}.bak-gamedaily`));
assert('补丁：真的落到文件里', JSON.parse(fs.readFileSync(mxuFile, 'utf8')).settings.autoRunOnLaunch === true);
const p2 = await defaultPrepareMaa(mxuCfg);
assert('补丁幂等（已经是 true 就不改）', p2.ok === true && p2.changed === false);

const maaFile = path.join(dir, 'gui.new.json');
fs.writeFileSync(maaFile, JSON.stringify({ Configurations: { Default: { Gui: { StartUpSettings: { RunDirectly: false }, RuntimeSettings: { StartGame: true } } } } }, null, 2), 'utf8');
const maaCfg = mergeConfig({ maaConfigPath: maaFile }, {}, REPO_ROOT, 'arknights');
const p3 = await defaultPrepareMaa(maaCfg);
const maaJson = JSON.parse(fs.readFileSync(maaFile, 'utf8'));
assert('方舟补丁：RunDirectly=true + StartGame=false',
  p3.ok === true && maaJson.Configurations.Default.Gui.StartUpSettings.RunDirectly === true && maaJson.Configurations.Default.Gui.RuntimeSettings.StartGame === false,
  p3.items.join(','));
const p4 = await defaultPrepareMaa(mergeConfig({ maaConfigPath: path.join(dir, 'nope.json') }, {}, REPO_ROOT, 'arknights'));
assert('配置文件不存在 → 返回失败而不是抛异常', p4.ok === false && String(p4.error).length > 0);

// ── 多日志监听 / 计数 / 判据 ────────────────────────────────────────────
fs.writeFileSync(path.join(dir, 'maafw.log'), 'x\n', 'utf8');
fs.writeFileSync(path.join(dir, '2026-09-29-3.log'), 'y\n', 'utf8');
const watch = resolveWatchFiles({ maaLogPaths: [path.join(dir, 'maafw.log')], maaLogDirs: [dir] });
assert('监听清单 = 固定路径 + 目录里所有 .log', watch.length === 2 && watch.some((f) => f.endsWith('2026-09-29-3.log')), watch.map((f) => path.basename(f)).join(','));

const mxuWithTasks = path.join(dir, 'mxu-tasks.json');
fs.writeFileSync(mxuWithTasks, JSON.stringify({ lastActiveInstanceId: 'b', instances: [{ id: 'a', tasks: [{ enabled: true }] }, { id: 'b', tasks: [{ enabled: true }, { enabled: true }, { enabled: false }, { enabled: true }] }] }), 'utf8');
const n = await defaultExpectedTaskCount({ expectedTaskCountFrom: true, maaConfigPath: mxuWithTasks });
assert('期望任务数 = 当前实例里启用的任务数（3）', n === 3, String(n));
assert('没开 expectedTaskCountFrom 就是 0', (await defaultExpectedTaskCount({ maaConfigPath: mxuWithTasks })) === 0);
assert('countPatterns 数出现次数', countPatterns('a Tasker.Task.Succeeded b Tasker.Task.Succeeded', ['Tasker\\.Task\\.Succeeded']) === 2);
const c1 = findCompletion('xx Tasker.Task.Succeeded yy', { completionPatterns: ['任务已全部完成'], failurePatterns: ['Tasker\\.Task\\.Failed'] });
assert('自定义判据：完成文案没出现就不算完成', c1.allTasksCompleted === false && c1.taskChainError === false);
const c2 = findCompletion('abc 任务已全部完成', { completionPatterns: ['任务已全部完成'], failurePatterns: ['Tasker\\.Task\\.Failed'] });
assert('自定义判据：完成文案命中', c2.allTasksCompleted === true);
const c3 = findCompletion('zz Tasker.Task.Failed zz', { completionPatterns: ['任务已全部完成'], failurePatterns: ['Tasker\\.Task\\.Failed'] });
assert('自定义判据：失败命中且带样本', c3.taskChainError === true && c3.errorSample.includes('Tasker.Task.Failed'), c3.errorSample);

// ── runJob 集成（计数式完成 / 降权启动 / 不碰 ADB / 关对进程）───────────
function mkCfg(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-end-run-'));
  const maaLog = path.join(d, 'maafw.log');
  fs.writeFileSync(maaLog, 'old\n');
  fs.writeFileSync(path.join(d, 'gui.log'), 'old\n');
  return {
    cfg: mergeConfig({
      maaPath: path.join(d, 'MaaEnd.exe'), maaConfigPath: mxuWithTasks, maaLogPath: maaLog,
      maaLogPaths: [maaLog], maaLogDirs: [d],
      logFile: path.join(d, 'run.log'), stateFile: path.join(d, 'state.json'),
      lockFile: path.join(d, 'lock'), requestFile: path.join(d, 'req.json'),
      timeoutSec: 600, pollSec: 1, toolExitQuietSec: 0, clientWaitSec: 1, adbWaitSec: 1, clientBootSec: 1, manualWaitSec: 1, windowWaitSec: 1,
      ...extra
    }, {}, REPO_ROOT, 'endfield'),
    dir: d, maaLog, guiLog: path.join(d, 'gui.log')
  };
}
const clock = (start = 1750000000000) => { let t = start; return { now: () => t, advance: (ms) => { t += Math.max(1, Number(ms) || 1); } }; };
const collector = () => { const lines = []; const fn = (l) => { lines.push(l); return l; }; fn.lines = lines; return fn; };
// 造一行**真实的 MaaFW 任务级事件**（带 task_id —— countTaskEvents 就是靠它去重的）
const taskEvent = (when, verdict, id, entry = 'VisitFriendsMain') =>
  `[${when}][INF][Px1][Tx2][Utils/EventDispatcher.hpp][L65][MaaNS::EventDispatcher::notify] !!!OnEventNotify!!! [handle=true] [msg=Tasker.Task.${verdict}] [details={"entry":"${entry}","task_id":${id}}]`;

// 场景 A：三个任务全成功（计数式）→ 成功收尾，且全程不碰 ADB、工具是降权启动、关的是 MaaEnd
{
  const { cfg, maaLog } = mkCfg();
  const clk = clock();
  const logs = collector();
  let adbCalls = 0;
  let tick = 0;
  let toolUp = false;
  const killed = [];
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => { adbCalls += 1; return { ok: false, devices: [], raw: '' }; },
    portOwner: async () => '',
    startClient: async () => ({ ok: true, pid: 11 }),
    startMaa: async (c) => { toolUp = true; assert('传给 startMaa 的是"跟执行器一样提权"配置', c.maaDeElevated === false); return { ok: true, pid: 22, deElevated: false }; },
    prepareMaa: async () => ({ ok: true, changed: true, items: ['autoRunOnLaunch=true'] }),
    listProcesses: async () => (toolUp ? ['MaaEnd', 'Endfield'] : ['Endfield']),
    killByName: async (names) => { killed.push(...names); return { killed: names, failed: [] }; },
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clk.now,
    sleep: async (ms) => {
      clk.advance(ms);
      // 工具起来之后，每轮成功一个任务（共 3 个）——只在 MAA 启动后写，避免被当成"旧日志"
      if (toolUp && tick < 3) { tick += 1; fs.appendFileSync(maaLog, `${taskEvent(formatLogTime(clk.now()), 'Succeeded', 200000000 + tick)}\n`); }
    }
  });
  assert('计数到 3 个任务成功就收尾', job.ok === true && job.completionBy === 'task-count' && job.successCount >= 3, `${job.reason} success=${job.successCount}/${job.expectedTaskCount}`);
  assert('期望任务数取自 MXU 配置（3）', job.expectedTaskCount === 3);
  assert('PC 端模式：全程没有调用过 ADB', adbCalls === 0);
  assert('记录了"管理员权限"', job.maaDeElevated === false && logs.lines.some((l) => l.includes('管理员权限')));
  assert('收尾关的是 MaaEnd + 终末地进程', killed.includes('MaaEnd.exe') && killed.includes('Endfield.exe'), killed.join(','));
}

// 场景 B：日志出现"任务已全部完成" → 文案判据也能收尾
{
  const { cfg, guiLog } = mkCfg();
  const clk = clock();
  let tick = 0;
  let toolUp = false;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startClient: async () => ({ ok: true, pid: 11 }),
    startMaa: async () => { toolUp = true; return { ok: true, pid: 22, deElevated: true }; },
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    listProcesses: async () => (toolUp ? ['MaaEnd', 'Endfield'] : ['Endfield']),
    killByName: async (names) => ({ killed: names, failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: collector(),
    now: clk.now,
    sleep: async (ms) => { clk.advance(ms); tick += 1; if (tick === 2) fs.appendFileSync(guiLog, '2026-09-29 22:25:06 [TaskQueueViewModel] 任务已全部完成！\n'); }
  });
  assert('GUI 日志出现"任务已全部完成" → 成功', job.ok === true && job.completionBy === 'marker', `${job.ok} ${job.reason}`);
  assert('被监听的日志里有 GUI 日志', job.watchedFiles.some((f) => f.includes('gui.log')), job.watchedFiles.join(','));
}

// 场景 C：某个任务失败 → 判失败并带样本
{
  const { cfg, maaLog } = mkCfg();
  const clk = clock();
  let tick = 0;
  let toolUp = false;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startClient: async () => ({ ok: true, pid: 11 }),
    startMaa: async () => { toolUp = true; return { ok: true, pid: 22, deElevated: true }; },
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    listProcesses: async () => (toolUp ? ['MaaEnd'] : ['Endfield']),
    killByName: async (names) => ({ killed: names, failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: collector(),
    now: clk.now,
    sleep: async (ms) => {
      clk.advance(ms);
      if (!toolUp) return;          // 只在工具起来之后写事件（否则会被当成"开始前就有的旧日志"，读不到）
      tick += 1;
      // 先成功 2 个，再让 DailyRewards 失败（本实例 3 个任务）→ 三个都有结果 → "部分完成"，但**不该中途退出**
      if (tick === 1) fs.appendFileSync(maaLog, `${taskEvent(formatLogTime(clk.now()), 'Succeeded', 200000011, 'DijiangRewards')}\n`);
      if (tick === 2) fs.appendFileSync(maaLog, `${taskEvent(formatLogTime(clk.now()), 'Succeeded', 200000012, 'CreditShoppingMain')}\n`);
      if (tick === 3) fs.appendFileSync(maaLog, `${taskEvent(formatLogTime(clk.now()), 'Failed', 200000013, 'DailyRewards')}\n`);
    }
  });
  assert('单个任务失败不再中途退出：剩下任务照跑，最后是"部分完成"', job.ok === false && job.partial === true && job.failedNames.includes('DailyRewards') && job.completionBy === 'task-count', `${job.reason} partial=${job.partial}`);
  assert('部分完成的计数正确（2 成功 / 1 失败）', job.successCount === 2 && job.failedCount === 1, `${job.successCount}/${job.failedCount}`);
}

// 场景 D：MaaEnd 已经在跑 → 直接拒绝
{
  const { cfg } = mkCfg();
  const clk = clock();
  let started = 0;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    listProcesses: async () => ['MaaEnd'],
    startMaa: async () => { started += 1; return { ok: true, pid: 1 }; },
    log: collector(),
    now: clk.now,
    sleep: async (ms) => clk.advance(ms)
  });
  assert('MaaEnd 已在跑 → 不重复启动', job.ok === false && started === 0 && job.reason.includes('MaaEnd'), job.reason);
}

// ── 误判回归（2026-09-29 22:47 事故）：反作弊常驻进程不能算"游戏在跑" ──────
assert('PlatformProcess 不算游戏在跑', isGameRunning(['PlatformProcess'], ef.clientProcesses) === false);
assert('Endfield 才算游戏在跑', isGameRunning(['Endfield'], ef.clientProcesses) === true);
assert('方舟同理（PlatformProcess 不算）', isGameRunning(['PlatformProcess'], ark.clientProcesses) === false && isGameRunning(['Arknights'], ark.clientProcesses) === true);

// 场景 E：进程匹配但**窗口一直不出来** → 按误判处理，改用候选链启动
{  const { cfg } = mkCfg();
  const clk = clock();
  const logs = collector();
  let clientStarts = 0;
  let toolUp = false;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => false,                     // 永远没有窗口 = 误判/残留进程
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    // 一开始就"有进程"（模拟被常驻辅助进程骗），但候补启动会真的把游戏拉起来
    listProcesses: async () => (clientStarts > 0 ? ['Endfield', 'MaaEnd'] : ['Endfield']),
    startClient: async () => { clientStarts += 1; return { ok: true, pid: 33 }; },
    startMaa: async () => { toolUp = true; return { ok: true, pid: 44, deElevated: true }; },
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    killByName: async (names) => ({ killed: names, failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clk.now,
    sleep: async (ms) => clk.advance(ms)
  });
  assert('窗口不出来 → 判定为误判并真的去启动游戏', clientStarts >= 1, `clientStarts=${clientStarts}`);
  assert('自愈后确实把 MAAEND 起来了', toolUp === true && logs.lines.some((l) => l.includes('改用候选链启动游戏')), logs.lines.filter((l) => l.includes('误判') || l.includes('候补')).join(' | '));
}

// 场景 G（2026-10-23 实测事故）：终末地更新后直启被启动器校验拒绝 —— 进程在，
// 但窗口是 245x178 的「游戏启动失败」弹窗。旧逻辑把弹窗当游戏窗口 ⇒ 判成功 ⇒ 起 MAA 白等 30 分钟。
{
  const { cfg } = mkCfg();
  const clk = clock();
  const logs = collector();
  const killed = [];
  let alive = true;                     // 模拟：进程一直在，直到被我们杀掉
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,      // 有"窗口"（弹窗也算窗口）
    windowInfo: async () => ({
      windows: [
        { title: 'Endfield', width: 1550, height: 902 },
        { title: '游戏启动失败', width: 245, height: 178 },
      ],
    }),
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    listProcesses: async () => (alive ? ['Endfield'] : []),
    startClient: async () => ({ ok: true, pid: 55 }),
    startMaa: async () => ({ ok: true, pid: 66, deElevated: true }),
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    killByName: async (names) => { killed.push(...names); if (names.some((n) => /Endfield/i.test(n))) alive = false; return { killed: names, failed: [] }; },
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clk.now,
    sleep: async (ms) => clk.advance(ms),
  });
  assert('「游戏启动失败」弹窗被判出来（日志明说）',
    logs.lines.some((l) => l.includes('启动失败弹窗')), logs.lines.filter((l) => l.includes('弹窗')).join(' | '));
  assert('那个"假成功"的游戏进程被关掉', killed.some((n) => /Endfield/i.test(n)), killed.join(','));
  assert('最终不判成功', job.ok === false, `${job.ok} ${job.reason}`);
}

// 场景 F：工具"瞬时看不到"（Get-Process 偶发失败）**不能**判退出 —— 2026-09-29 23:00 事故回归
{
  const { cfg, maaLog } = mkCfg();
  const clk = clock();
  const logs = collector();
  let tick = 0;
  let toolUp = false;
  let successes = 0;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startClient: async () => ({ ok: true, pid: 11 }),
    startMaa: async () => { toolUp = true; return { ok: true, pid: 22, deElevated: false }; },
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    // 第 2 次查询"看不到进程"（模拟偶发失败/空列表），其余时候都在 —— 旧代码就是在这里把 MAAEND 判死并掐了
    listProcesses: async () => {
      tick += 1;
      if (!toolUp) return ['Endfield'];
      return tick === 2 ? [] : ['MaaEnd', 'Endfield'];
    },
    killByName: async (names) => ({ killed: names, failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clk.now,
    sleep: async (ms) => {
      clk.advance(ms);
      if (toolUp && successes < 3) { successes += 1; fs.appendFileSync(maaLog, `${taskEvent(formatLogTime(clk.now()), 'Succeeded', 200000100 + successes)}\n`); }
    }
  });
  assert('瞬时看不到工具不判退出（要连续确认）', logs.lines.some((l) => l.includes('再确认，不急着判退出')), logs.lines.filter((l) => l.includes('没看到')).join(' | '));
  assert('因此没被误杀，任务照跑完并成功收尾', job.ok === true && job.completionBy === 'task-count', `${job.ok} ${job.reason} success=${job.successCount}/${job.expectedTaskCount}`);
}

// ── 提交任务数解析（本次实际 6 个 vs 配置算出 7 个的坑）──────────────────
assert('从 taskIds 读实际提交数', submittedTaskCount('[MAA] 任务已提交, taskIds: [200000001,200000002,200000003,200000004,200000005,200000006]').count === 6);
assert('退回"任务数: N"也能读', submittedTaskCount('[MAA] 启动任务, 实例: r8iho16 , 任务数: 6').count === 6);
assert('读不到就是 0', submittedTaskCount('随便一行').count === 0);

// 场景 G：配置算出 7 个，但日志显示实际只提交 6 个 → 按 6 个收尾（否则永远等不到完成）
{
  const { cfg, guiLog, maaLog } = mkCfg();
  const clk = clock();
  const logs = collector();
  let successes = 0;
  let toolUp = false;
  let announced = false;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startClient: async () => ({ ok: true, pid: 11 }),
    startMaa: async () => { toolUp = true; return { ok: true, pid: 22, deElevated: false }; },
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    listProcesses: async () => (toolUp ? ['MaaEnd', 'Endfield'] : ['Endfield']),
    killByName: async (names) => ({ killed: names, failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clk.now,
    sleep: async (ms) => {
      clk.advance(ms);
      if (!toolUp) return;
      if (!announced) { announced = true; fs.appendFileSync(guiLog, '2026-09-29 23:40:44 INFO  [MAA] 任务已提交, taskIds: [200000001,200000002,200000003,200000004,200000005,200000006]\n'); return; }
      if (successes < 6) { successes += 1; fs.appendFileSync(maaLog, `${taskEvent(formatLogTime(clk.now()), 'Succeeded', 200000200 + successes)}\n`); }
    }
  });
  assert('期望任务数被日志里的实际提交数覆盖为 6', job.expectedTaskCount === 6 && logs.lines.some((l) => l.includes('本次实际提交 6 个任务')), `${job.expectedTaskCount} ${logs.lines.filter((l) => l.includes('提交')).join(' | ')}`);
  assert('6 个成功即收尾（不用等 30 分钟兜底）', job.ok === true && job.completionBy === 'task-count' && job.successCount >= 6, `${job.ok} ${job.reason}`);
}

// ── 日志轮转 / 时间过滤（2026-09-29 23:53 实测：MAAEND 把 maafw.log rename 成 maafw.bak.*.log）──
assert('日志时间格式可直接比较', formatLogTime(new Date('2026-09-29T23:53:45').getTime()) === '2026-09-29 23:53:45', formatLogTime(new Date('2026-09-29T23:53:45').getTime()));
assert('只算本次运行之后的行', countPatternsSince('[2026-09-29 23:40:44][INF] Tasker.Task.Succeeded\n[2026-09-29 23:57:33][INF] Tasker.Task.Succeeded', ['Tasker\\.Task\\.Succeeded'], '2026-09-29 23:48:52') === 1);
assert('没有时间戳的行照样算（有些日志行不带时间）', countPatternsSince('[INF] Tasker.Task.Succeeded', ['Tasker\\.Task\\.Succeeded'], '2026-09-29 23:48:52') === 1);
const oldDone = findCompletion('[2026-09-29 23:40:44][INFO] 任务已全部完成', { completionPatterns: ['任务已全部完成'], failurePatterns: [] }, '2026-09-29 23:48:52');
assert('轮转旧日志里的"全部完成"不算（时间过滤）', oldDone.allTasksCompleted === false, JSON.stringify(oldDone));

// 场景 H：运行中 maafw.log 被轮转（同名路径但文件变小）→ 必须还能读到新内容
{
  const { cfg, maaLog } = mkCfg();
  const clk = clock();
  const logs = collector();
  let successes = 0;
  let toolUp = false;
  let rotated = false;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startClient: async () => ({ ok: true, pid: 11 }),
    startMaa: async () => { toolUp = true; return { ok: true, pid: 22, deElevated: false }; },
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    listProcesses: async () => (toolUp ? ['MaaEnd', 'Endfield'] : ['Endfield']),
    killByName: async (names) => ({ killed: names, failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clk.now,
    sleep: async (ms) => {
      clk.advance(ms);
      if (!toolUp) return;
      if (!rotated) {
        rotated = true;
        // 先把文件撑大，再"轮转"：旧内容改名成 .bak，同名新文件从小开始（正是 MAAEND 干的事）
        fs.appendFileSync(maaLog, Array.from({ length: 300 }, (_, i) => `[${formatLogTime(clk.now() - 60000)}][TRC] 旧内容 ${i}`).join('\n') + '\n');
        fs.renameSync(maaLog, `${maaLog}.bak`);
        fs.writeFileSync(maaLog, `[${formatLogTime(clk.now())}][INF] 新文件开始\n`, 'utf8');
        return;
      }
      if (successes < 3) {
        successes += 1;
        fs.appendFileSync(maaLog, `${taskEvent(formatLogTime(clk.now()), 'Succeeded', 200000300 + successes)}\n`);
      }
    }
  });
  assert('文件被轮转变小后仍能读到新内容并收尾', job.ok === true && job.completionBy === 'task-count', `${job.ok} ${job.reason} success=${job.successCount}`);
}

// ── 去重计数（同一事件被两个进程各记一次的真实坑）────────────────────────
{
  const dup = [
    taskEvent('2026-09-30 10:48:29', 'Succeeded', 200000001, 'VisitFriendsMain'),
    `[2026-09-30 10:48:29][TRC][Px9][Tx9][AgentClient.cpp][L2834][MaaNS::AgentNS::ClientNS::AgentClient::tasker_event_sink] [handle=true] [message=Tasker.Task.Succeeded] [details_json={"entry":"VisitFriendsMain","task_id":200000001}]`,
    `[2026-09-30 10:48:29][INF][Px9][Tx9][Utils/EventDispatcher.hpp][L65][MaaNS::EventDispatcher::notify] !!!OnEventNotify!!! [handle=true] [msg=Tasker.Task.Succeeded] [details={"entry":"VisitFriendsMain","task_id":200000001}]`,
    taskEvent('2026-09-30 10:51:09', 'Failed', 200000002, 'DijiangRewards'),
    taskEvent('2026-09-30 10:51:09', 'Failed', 200000002, 'DijiangRewards')
  ].join('\n');
  const ev = countTaskEvents(dup, '2026-09-30 10:43:58');
  assert('同一事件被记多份时按 task_id 去重（1 成功 / 1 失败）', ev.succeeded === 1 && ev.failed === 1, JSON.stringify({ s: ev.succeeded, f: ev.failed }));
  assert('去重后能拿到失败的任务名', ev.failedNames.join(',') === 'DijiangRewards', ev.failedNames.join(','));
  assert('早于本次运行的事件不算', countTaskEvents(dup, '2026-09-30 11:00:00').succeeded === 0);
}

// ── 框架级错误（工具真坏了）才立刻中止 ──────────────────────────────────
{
  const { cfg, maaLog } = mkCfg();
  const clk = clock();
  const logs = collector();
  let toolUp = false;
  let once = false;
  const job = await runJob(cfg, {}, {
    isElevated: async () => true,
    exists: () => true,
    windowReady: async () => true,

    windowInfo: async () => null,
    adbConnect: async () => ({ ok: true, devices: [], raw: '' }),
    portOwner: async () => '',
    startClient: async () => ({ ok: true, pid: 11 }),
    startMaa: async () => { toolUp = true; return { ok: true, pid: 22, deElevated: false }; },
    prepareMaa: async () => ({ ok: true, changed: false, items: [] }),
    listProcesses: async () => (toolUp ? ['MaaEnd', 'Endfield'] : ['Endfield']),
    killByName: async (names) => ({ killed: names, failed: [] }),
    statSize: (p) => fs.statSync(p).size,
    log: logs,
    now: clk.now,
    sleep: async (ms) => {
      clk.advance(ms);
      if (toolUp && !once) { once = true; fs.appendFileSync(maaLog, `[${formatLogTime(clk.now())}][ERR][AgentClient.cpp][L2815] server is not alive\n`); }
    }
  });
  assert('框架级错误（server is not alive）→ 立刻中止', job.ok === false && job.reason.includes('工具内部错误'), job.reason);
}

console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
