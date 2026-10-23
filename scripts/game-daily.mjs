#!/usr/bin/env node
// 明日方舟日活执行器 —— **必须以管理员身份运行**（MAA 与官方 PC 端都带提权/ACE，中等完整性进程
// 既不能给它们发输入，也不能结束它们；见 INSTALL_NOTES 16.5）。
//
// 干什么（固定流程、不接受来自 QQ 的任何参数）：
//   ① 前置检查：是否提权 / MAA 在不在 / ADB 能不能连上 127.0.0.1:16384 / 16384 是不是被 MuMu 占了
//   ② （可选）把 MAA 的「直接运行」打开，这样启动 MAA 就会自动开始任务；否则给它发 Link Start 热键
//   ③ 启动 MAA（官方 PC 端由 MAA 自己按 ClientType=Official + StartGame 拉起，脚本不碰 MuMu）
//   ④ 盯 G:\MAA\debug\asst.log 的新增内容，等到 AllTasksCompleted（成功）或 TaskChainError（失败）
//      —— 跑完即停；最多等 timeoutSec（默认 30 分钟，MAA 自己的 25 分钟卡死超时也在兜底）
//   ⑤ 收尾：关 MAA；按需关官方客户端（Arknights.exe / PlatformProcess.exe）
//   ⑥ 写 state/arknights-daily.json（给桥接回报用）+ 追加 state/arknights-daily.log
//
// 用法：
//   node scripts/arknights-daily.mjs                 # 完整流程（计划任务里就是这么调的）
//   node scripts/arknights-daily.mjs --dry-run       # 只做前置检查，不启 MAA（先在管理员窗口里跑这个）
//   node scripts/arknights-daily.mjs --prepare-maa   # 只把 MAA 的「直接运行」打开（MAA 必须已关闭）
//   node scripts/arknights-daily.mjs --timeout 1200 --no-close-client --trigger hotkey
// 参数：--timeout --poll --trigger auto|hotkey --no-close-client --no-close-maa --dry-run --once? --prepare-maa
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_ARKNIGHTS = {
  enabled: false,
  maaPath: 'G:\\MAA\\MAA.exe',
  maaConfigPath: 'G:\\MAA\\config\\gui.new.json',
  maaLogPath: 'G:\\MAA\\debug\\asst.log',
  adbPath: 'G:\\MuMuPlayer\\nx_device\\12.0\\shell\\adb.exe',
  adbAddress: '127.0.0.1:16384',
  // 官方 PC 端的启动：桌面「明日方舟」图标只拉起**鹰角启动器**（还要再点一下才开始游戏），
  // 所以这里按顺序试若干候选命令，并以「游戏进程（Arknights.exe/PlatformProcess.exe）出现」为准：
  //   ① 直接起游戏本体（最可能一步到位）
  //   ② 兜底：起启动器（至少把界面打开，owner 点一下就能进游戏 → 我们继续等进程出现）
  startClient: true,
  clientCandidates: [
    { exe: 'G:\\Hypergryph Launcher\\games\\Arknights Game\\Arknights.exe', args: [] },
    { exe: 'G:\\Hypergryph Launcher\\Launcher.exe', args: ['--game=Arknights', '--reason=4'] }
  ],
  // 判定"游戏在不在"只看游戏本体：PlatformProcess.exe 是反作弊平台的**常驻辅助进程**
  // （游戏没开它也可能在，2026-09-29 22:47 就是被它骗了"已在运行"）→ 不能算进来
  clientProcesses: ['Arknights.exe'],
  clientBootSec: 45,      // 每个候选起来后，等游戏进程出现的上限
  windowWaitSec: 60,      // 进程出现后，等游戏窗口出现的上限（Win32 截图需要窗口）
  clientWaitSec: 30,      // 游戏进程出现后，至少再等这么久才起 MAA（owner 要求"等半分钟"）
  manualWaitSec: 300,     // 候选都没拉起游戏时：把启动器留给 owner 点一下，再等这么久
  // owner 实测：MAA **拉不起**官方 PC 端 → StartGame 由执行器关掉；ADB 就绪才是"可以起 MAA"的信号。
  adbWaitSec: 90,
  connectMode: 'auto',    // auto=读 MAA 的 ConnectSettings.Config（PC→Win32 不等 ADB）；也可强制 pc/adb
  maaStartGame: false,
  // ↓ 以下是与"档案"无关的通用字段（终末地档案同样使用）
  profile: 'arknights',
  maaDeElevated: false,
  toolProcessNames: ['MAA'],     // 监控/关闭用的工具进程名（终末地是 MaaEnd）
  toolMissConfirmations: 3,      // 连续几次看不到工具进程才算"真退出"（防 Get-Process 偶发空列表）
  toolExitQuietSec: 60,          // 还要日志安静这么久才算（日志还在动 = 工具活着）
  triggerHotkey: { keys: '^+%l', activate: 'MAA' },   // 兜底触发：MAA 的 Link Start 全局热键
  completionPatterns: ['AllTasksCompleted'],           // 跑完的判据（asst.log 里 MAA 自己的回调）
  failurePatterns: ['TaskChainError'],
  fatalPatterns: ['server is not alive'],   // 框架级错误（工具真的坏了）才立刻中止；单个任务失败不算
  successPatterns: [],           // 逐任务成功计数用（终末地用 Tasker.Task.Succeeded）
  maaLogDirs: [],                // 额外监听的日志目录（终末地 GUI 日志按日期滚动）
  // 「启动即跑」怎么开：声明式补丁（终末地是 mxu-MaaEnd.json 的 settings.autoRunOnLaunch）
  autoRunPatches: [
    { path: ['Configurations', 'Default', 'Gui', 'StartUpSettings', 'RunDirectly'], value: true, label: 'RunDirectly=true' },
    { path: ['Configurations', 'Default', 'Gui', 'RuntimeSettings', 'StartGame'], value: false, label: 'StartGame=false' }
  ],
  timeoutSec: 1800,
  pollSec: 5,
  closeClient: true,
  closeMaa: true,
  trigger: 'auto',
  taskName: 'qq-bridge-arknights-daily',
  stateFile: 'state/arknights-daily.json',
  logFile: 'state/arknights-daily.log',
  lockFile: 'state/arknights-daily.lock',
  requestFile: 'state/arknights-daily-request.json'
};

/**
 * 终末地（MAAEND / MXU）档案。与方舟的差别：
 *   · 工具是 MaaEnd.exe（MaaFramework + MXU 界面），配置在 config/mxu-MaaEnd.json
 *   · 「启动即跑」靠 settings.autoRunOnLaunch=true（方舟是 RunDirectly）；兜底热键是 F10
 *   · 官方 PC 端（Endfield.exe）同样要管理员，但 **MAAEND 自己不需要** → 执行器提权起游戏，
 *     再用 explorer.exe 把 MAAEND 以普通权限启动（与 owner 手动跑的形态一致）
 *   · 没有 ADB（controller=Win32-Front，class_regex=UnityWndClass / window_regex=Endfield）→ connectMode:'pc'
 *   · 完成判据：MaaFW 每个任务成功发 Tasker.Task.Succeeded，MXU 实例里有 N 个启用任务 →
 *     数到 N 次成功（或日志出现"全部完成"类文案）就算跑完；30 分钟兜底
 */
export const DEFAULT_ENDFIELD = {
  ...DEFAULT_ARKNIGHTS,
  profile: 'endfield',
  maaPath: 'G:\\MAAEND\\MaaEnd.exe',
  maaConfigPath: 'G:\\MAAEND\\config\\mxu-MaaEnd.json',
  maaLogPath: 'G:\\MAAEND\\debug\\maafw.log',
  maaLogPaths: ['G:\\MAAEND\\debug\\maafw.log'],
  maaLogDirs: ['G:\\MAAEND\\debug'],
  // owner 反馈 + MXU 的 interface.json：Win32-Front 控制器本身标了 permission_required: true
  // → MAAEND 也提权跑（执行器已经是管理员，直接继承即可），省掉 UIPI/信任那一堆麻烦
  maaDeElevated: false,
  toolProcessNames: ['MaaEnd'],
  expectedTaskCountFrom: true,   // 参与任务数从 mxu-MaaEnd.json 的当前实例里数出来
  connectMode: 'pc',
  triggerHotkey: { keys: '{F10}', activate: 'MaaEnd' },
  completionPatterns: ['任务已全部完成', '全部任务完成', '所有任务已完成', '任务全部完成', '运行完成', '实例已完成'],
  failurePatterns: ['\\[msg=Tasker\\.Task\\.Failed\\]', '任务失败'],   // 只数"任务级失败"这一个事件（见 countTaskEvents 的说明）
  // MaaFW v2 的任务级事件；实测日志里 Node.* 是"节点/动作级"，任务级是 Tasker.Task.*
  successPatterns: ['Tasker\\.Task\\.Succeeded', 'Tasker\\.Task\\.Completed'],
  autoRunPatches: [
    { path: ['settings', 'autoRunOnLaunch'], value: true, label: 'autoRunOnLaunch=true' }
  ],
  clientCandidates: [
    // 首选：**点启动器上的「开始游戏」**（游戏侧校验启动票据，只有启动器拉起才算数；
    // 而 Launcher.exe 的 --game/--reason 参数实测不触发启动，见 INSTALL_NOTES 16.33）
    { exe: 'G:\\Hypergryph Launcher\\Launcher.exe', args: [], launcher: true, click: true },
    // 兜底：老版本能直启（当前版本会被拒，waitGameWindow 会识别「游戏启动失败」弹窗并快速失败）
    { exe: 'G:\\Hypergryph Launcher\\games\\Endfield Game\\Endfield.exe', args: [] }
  ],
  // 启动器进程名：用来判断"启动器是不是本来就已经开着"（单实例会吞掉新参数），
  // 以及失败后把它关掉重试。
  launcherProcessNames: ['Games.exe', 'Launcher.exe'],
  // 「点开始游戏」的几何参数：坐标以**启动器窗口客户区左上角**为原点。
  // 尺寸与期望不符时（启动器记住的窗口大小可能不同）先把窗口调成期望尺寸再点，
  // 这样按钮位置才和 owner 量的一致；调不动就放弃点击（宁可退回"等人点"，也不乱点）。
  launcherClick: {
    enabled: true,
    expect: { width: 1640, height: 943, tolerancePct: 8 },
    point: { x: 1397, y: 816 },
    resizeIfNeeded: true,
    settleMs: 1200,        // 置前/缩放后等界面稳住
    windowWaitMs: 15000,   // 等启动器窗口出现
  },
  clientProcesses: ['Endfield.exe'],
  taskName: 'qq-bridge-endfield-daily',
  stateFile: 'state/endfield-daily.json',
  logFile: 'state/endfield-daily.log',
  lockFile: 'state/endfield-daily.lock',
  requestFile: 'state/endfield-daily-request.json'
};

/** 档案名 → 默认配置。 */
export const PROFILES = { arknights: DEFAULT_ARKNIGHTS, endfield: DEFAULT_ENDFIELD };

/** 参数解析（纯函数）。 */
export function parseArgs(argv = []) {
  const out = { dryRun: false, prepareMaa: false, timeoutSec: null, pollSec: null, trigger: null, closeClient: null, closeMaa: null, profile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : undefined);
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--prepare-maa') out.prepareMaa = true;
    else if (a === '--no-close-client') out.closeClient = false;
    else if (a === '--no-close-maa') out.closeMaa = false;
    else if (a === '--timeout') out.timeoutSec = Number(next()) || null;
    else if (a === '--poll') out.pollSec = Number(next()) || null;
    else if (a === '--trigger') out.trigger = String(next() ?? '').trim() || null;
    else if (a === '--profile') out.profile = String(next() ?? '').trim() || null;
  }
  return out;
}

/** 合并 config.json 里的 socialV2.arknights 与命令行覆盖（纯函数）。 */
export function mergeConfig(raw, args = {}, repoRoot = REPO_ROOT, profileName = null) {
  const profile = String(profileName ?? (raw && typeof raw === 'object' && raw.profile) ?? args.profile ?? 'arknights');
  const base = PROFILES[profile] ?? DEFAULT_ARKNIGHTS;
  const src = { ...base, profile, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const key of ['timeoutSec', 'pollSec', 'clientBootSec', 'windowWaitSec', 'clientWaitSec', 'manualWaitSec', 'adbWaitSec']) {
    const n = Number(src[key]);
    src[key] = Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_ARKNIGHTS[key];
  }
  src.closeClient = src.closeClient !== false;
  // 走启动器拉起游戏时，收尾是否连启动器一起关（默认关：否则第二天会撞上单实例吞参数）
  src.closeLauncher = src.closeLauncher !== false;
  src.closeMaa = src.closeMaa !== false;
  src.startClient = src.startClient !== false;
  src.maaStartGame = src.maaStartGame === true;
  src.trigger = src.trigger === 'hotkey' ? 'hotkey' : 'auto';
  src.clientProcesses = Array.isArray(src.clientProcesses) && src.clientProcesses.length ? src.clientProcesses.map(String) : base.clientProcesses;
  src.maaLogPaths = (Array.isArray(src.maaLogPaths) && src.maaLogPaths.length ? src.maaLogPaths : [src.maaLogPath]).filter(Boolean).map(String);
  src.maaLogDirs = (Array.isArray(src.maaLogDirs) ? src.maaLogDirs : []).map(String);
  src.completionPatterns = (Array.isArray(src.completionPatterns) && src.completionPatterns.length ? src.completionPatterns : base.completionPatterns).map(String);
  src.failurePatterns = (Array.isArray(src.failurePatterns) ? src.failurePatterns : base.failurePatterns).map(String);
  src.successPatterns = (Array.isArray(src.successPatterns) ? src.successPatterns : base.successPatterns).map(String);
  src.autoRunPatches = (Array.isArray(src.autoRunPatches) ? src.autoRunPatches : base.autoRunPatches).map((p) => ({ ...p, path: (p.path ?? []).map(String) }));
  src.toolProcessNames = (Array.isArray(src.toolProcessNames) && src.toolProcessNames.length ? src.toolProcessNames : base.toolProcessNames).map(String);
  // 候选链：优先用 clientCandidates；只写了旧的 clientExe/clientArgs 时当唯一候选（向后兼容）
  const rawCandidates = Array.isArray(src.clientCandidates) && src.clientCandidates.length
    ? src.clientCandidates
    : (src.clientExe ? [{ exe: src.clientExe, args: src.clientArgs ?? [] }] : []);
  src.clientCandidates = (rawCandidates.length ? rawCandidates : DEFAULT_ARKNIGHTS.clientCandidates)
    .map((c) => ({
      exe: String(c?.exe ?? ''),
      args: Array.isArray(c?.args) ? c.args.map(String) : [],
      // 这个候选是"启动器"而不是游戏本体：需要处理单实例吞参数、失败后关掉重试
      launcher: c?.launcher === true || /Launcher\.exe$/i.test(String(c?.exe ?? '')),
      // 「点启动器上的开始游戏」候选：**必须原样保留这个标记**，否则归一化会把它当成
      // 普通的"启动 exe"，那种候选永远拉不起游戏（2026-10-23 踩过：click 被归一化吃掉）
      click: c?.click === true
    }))
    .filter((c) => c.exe !== '');
  src.launcherProcessNames = (Array.isArray(src.launcherProcessNames) && src.launcherProcessNames.length
    ? src.launcherProcessNames
    : (src.clientCandidates.some((c) => c.launcher) ? ['Games.exe', 'Launcher.exe'] : [])).map(String);
  for (const key of ['stateFile', 'logFile', 'lockFile', 'requestFile']) {
    if (!path.isAbsolute(src[key])) src[key] = path.join(repoRoot, src[key]);
  }
  if (args.timeoutSec) src.timeoutSec = args.timeoutSec;
  if (args.pollSec) src.pollSec = args.pollSec;
  if (args.trigger) src.trigger = args.trigger === 'hotkey' ? 'hotkey' : 'auto';
  if (args.closeClient === false) src.closeClient = false;
  if (args.closeMaa === false) src.closeMaa = false;
  return src;
}

/** 游戏是否已经在跑（按进程名判断；纯函数）。 */
export function isGameRunning(processNames, clientProcesses) {
  const want = (clientProcesses ?? []).map((n) => String(n).replace(/\.exe$/i, '').toLowerCase());
  return (processNames ?? []).some((p) => want.includes(String(p).replace(/\.exe$/i, '').toLowerCase()));
}

/** `adb devices` 输出 → [{serial, state}]（纯函数）。 */
export function parseAdbDevices(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^List of devices/i.test(line) || line.startsWith('*')) continue;
    const [serial, state] = line.split(/\s+/);
    if (serial && state) out.push({ serial, state });
  }
  return out;
}

/**
 * 从 asst.log 的**新增片段**里找结论（纯函数）。
 * 判据来自 MAA 自己的回调日志（实测格式）：
 *   Assistant::append_callback | AllTasksCompleted {"finished_tasks":[1,2,...]}
 *   Assistant::append_callback | TaskChainError {"taskchain":"Fight",...}
 */
export function findCompletion(text, patterns = {}, since = '') {
  // since 非空时，先把早于本次运行的行丢掉（轮转过来的旧日志里可能有上一次的"全部完成"）
  const s = since
    ? String(text ?? '').split(/\r?\n/).filter((line) => {
      const m = line.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
      return !m || `${m[1]} ${m[2]}` >= since;
    }).join('\n')
    : String(text ?? '');
  const donePats = Array.isArray(patterns.completionPatterns) && patterns.completionPatterns.length ? patterns.completionPatterns : ['AllTasksCompleted'];
  const failPats = Array.isArray(patterns.failurePatterns) && patterns.failurePatterns.length ? patterns.failurePatterns : ['TaskChainError'];
  const countOf = (pats) => pats.reduce((sum, p) => sum + (s.match(new RegExp(p, 'g')) ?? []).length, 0);
  const allCount = countOf(donePats);
  const finished = (() => {
    const m = [...s.matchAll(/"finished_tasks"\s*:\s*\[([^\]]*)\]/g)].pop();
    return m ? m[1].split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)) : [];
  })();
  const errCount = countOf(failPats);
  const stall = /StallTimeout|stall timeout|卡死/i.test(s);
  const errLine = s.split(/\r?\n/).find((l) => failPats.some((p) => new RegExp(p).test(l))) ?? '';
  return {
    allTasksCompleted: allCount > 0,
    finishedTasks: finished,
    taskChainError: errCount > 0,
    errorSample: errLine.slice(0, 200),
    stallTimeout: stall
  };
}

/**
 * 前置检查的判定（纯函数，便于离线测试）。
 * `adbRequired=false` 表示这次走 Win32（官方 PC 端）——ADB 通不通跟能不能跑**无关**，
 * 不要拿它吓人（2026-09-29 22:0x 实测：PC 端 MAA 用 Win32Controller 截图/点击，16384 全程没人听）。
 */
export function decidePreflight({ elevated, maaExists, adbDeviceOnline, adbError, portOwner, adbRequired = true }) {
  const blockers = [];
  const warnings = [];
  if (!elevated) blockers.push('当前进程没有管理员权限（MAA/官方客户端都提权，必须先提权再跑）');
  if (!maaExists) blockers.push('找不到 MAA.exe');
  if (adbRequired && !adbDeviceOnline) warnings.push(`ADB 还没连上设备${adbError ? `（${adbError}）` : ''} —— 交给 MAA 自己连/拉起客户端`);
  if (adbRequired && portOwner && /MuMuPlayer|MuMuNxMain/i.test(String(portOwner))) {
    warnings.push(`端口被 MuMu 播放器占着（${portOwner}）：MAA 可能连到模拟器而不是官方 PC 端，建议先确认目标`);
  }
  return { ok: blockers.length === 0, blockers, warnings };
}

/**
 * 给 QQ 看的结论：实现放在 src/arknights-command.js（桥接回报时用的是同一份），这里只做转发，
 * 保持 scripts/ 与 src/ 两边的措辞永不漂移。
 */
export { formatArknightsReport as formatJobReport } from '../src/arknights-command.js';

export function tailLines(text, n = 8) {
  return String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').slice(-Math.max(1, n));
}

export function makeLogger(logFile, tag = 'gamedaily') {
  const write = (line) => {
    const stamped = `${new Date().toLocaleString('sv-SE')} [${tag}] ${line}`;
    try { console.log(stamped); } catch { /* 控制台没了也无所谓 */ }
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${stamped}\n`, 'utf8');
    } catch { /* 日志写不进去不该让流程挂掉 */ }
    return stamped;
  };
  return write;
}

// ── 有副作用的默认实现（测试里全部可注入替换）─────────────────────────────
function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error?.message ?? '' });
      });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: error?.message ?? String(error) });
    }
  });
}

/** 是否提权：`net session` 只有管理员能跑通（比查 ACL 快且不依赖 PowerShell 语言模式）。 */
export async function defaultIsElevated() {
  const r = await run('net.exe', ['session'], { timeoutMs: 8000 });
  return r.ok;
}

export async function defaultAdbConnect(cfg) {
  const connect = await run(cfg.adbPath, ['connect', cfg.adbAddress], { timeoutMs: 15000 });
  const devices = await run(cfg.adbPath, ['devices'], { timeoutMs: 15000 });
  const list = parseAdbDevices(devices.stdout);
  const target = list.find((d) => d.serial === cfg.adbAddress);
  return {
    ok: !!target && target.state === 'device',
    devices: list,
    raw: `${connect.stdout}${connect.stderr}${devices.stdout}`.trim().slice(0, 400),
    error: connect.ok ? (devices.ok ? '' : devices.error) : (connect.error || connect.stderr.trim())
  };
}

/** 谁在监听 ADB 端口（用来发现「实际连的是模拟器」这种坑）。 */
export async function defaultPortOwner(address) {
  const port = String(address).split(':').pop();
  const r = await run('powershell.exe', ['-NoProfile', '-Command',
    `$c=Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){(Get-Process -Id $c.OwningProcess).ProcessName}`], { timeoutMs: 12000 });
  return r.stdout.trim();
}

export async function defaultStartMaa(cfg) {
  try {
    // maaDeElevated=true（MAAEND 这种"不需要管理员"的工具）：经 explorer.exe 代启动 →
    // 以普通权限（中完整性）跑起来，和 owner 自己双击的形态一致；否则直接启动（继承提权）。
    const explorer = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
    const [exe, args] = cfg.maaDeElevated ? [explorer, [cfg.maaPath]] : [cfg.maaPath, []];
    const child = spawn(exe, args, { detached: cfg.maaDeElevated === true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, pid: child.pid, deElevated: !!cfg.maaDeElevated, launcher: exe };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 需要监听的日志文件清单：固定路径 + 目录里所有 .log（终末地 GUI 日志按日期滚动）。 */
export function resolveWatchFiles(cfg) {
  const out = [...(cfg.maaLogPaths ?? [cfg.maaLogPath])].filter(Boolean);
  for (const dir of cfg.maaLogDirs ?? []) {
    try {
      for (const f of fs.readdirSync(dir)) if (/\.log$/i.test(f)) out.push(path.join(dir, f));
    } catch { /* 目录不在就先跳过 */ }
  }
  return [...new Set(out)];
}

/** 这次要跑多少个任务（终末地：MXU 当前实例里启用的任务数；方舟不用这个判据）。 */
export async function defaultExpectedTaskCount(cfg) {
  if (!cfg.expectedTaskCountFrom) return 0;
  try {
    const json = JSON.parse(fs.readFileSync(cfg.maaConfigPath, 'utf8').replace(/^\uFEFF/, ''));
    const list = Array.isArray(json?.instances) ? json.instances : [];
    const inst = list.find((i) => i.id === json.lastActiveInstanceId) ?? list[0];
    const n = Array.isArray(inst?.tasks) ? inst.tasks.filter((t) => t.enabled !== false).length : 0;
    return n;
  } catch {
    return 0;
  }
}

/**
 * 从日志里读「本次实际提交了几个任务」（纯函数）。
 * MAAEND 会打两种行：
 *   [MAA] 启动任务, 实例: r8iho16 , 任务数: 6
 *   [MAA] 任务已提交, taskIds: [200000001,200000002,...]
 * 优先用 taskIds 数组的长度（最权威），拿不到再退回"任务数: N"。
 * 为什么要读它：配置里按"启用的任务条目数"数出来是 7，而 MAAEND 实际可能合并/少提交（实测提交 6）——
 * 数错就会永远等不到"完成"，最后要等 30 分钟兜底（2026-09-29 深夜那次就是这样）。
 */
export function submittedTaskCount(text) {
  const s = String(text ?? '');
  // 两种写法都要认：MaaEnd 的 GUI 日志用 taskIds（驼峰），MaaFW 内核用 task_ids
  const ids = [...s.matchAll(/task_?ids?\s*[:：]\s*\[([^\]]*)\]/gi)].pop();
  if (ids) {
    const n = ids[1].split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).length;
    if (n > 0) return { count: n, by: 'task-ids' };
  }
  const num = [...s.matchAll(/任务数\s*[:：]\s*(\d+)/g)].pop();
  if (num) {
    const n = Number(num[1]);
    if (n > 0) return { count: n, by: 'task-count-line' };
  }
  return { count: 0, by: '' };
}

/** 把时间戳格式化成日志里的样子（本地时间 'YYYY-MM-DD HH:MM:SS'，可直接做字符串比较）。 */
export function formatLogTime(ms = Date.now()) {
  return new Date(ms).toLocaleString('sv-SE').replace('T', ' ');
}

/**
 * 数一段日志里出现了几次给定模式，但**只算本次运行之后的行**（纯函数）。
 *
 * 为什么必须按时间过滤：MAAEND 会把 maafw.log 轮转成 maafw.bak.*.log（2026-09-29 23:53 实测），
 * 我们去读这些"轮转过来的旧文件"时会看到**上一次运行**的 Tasker.Task.Succeeded —— 不过滤就会虚报完成。
 */
export function countPatternsSince(text, patterns = [], since = '') {
  const pats = patterns.map((p) => new RegExp(p));
  let n = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line) continue;
    if (!pats.some((re) => re.test(line))) continue;
    if (since) {
      const m = line.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
      if (m && `${m[1]} ${m[2]}` < since) continue;
    }
    n += 1;
  }
  return n;
}

/**
 * 数「任务级」的成功/失败（纯函数，按 task_id 去重）。
 *
 * 为什么要专门做这个：同一个事件在 maafw.log 里会被记 **多份** —— MaaEnd.exe 的
 * EventDispatcher 记一次，agent 进程（go-service/cpp-algo）的 AgentClient 再记 1~2 次，
 * 甚至同一个进程里还会出现 `[msg=…]` 与 `[message=…]` 两种写法。
 * 直接按字符串数会**虚高 2~3 倍**，于是任务还没跑完就被判"全成功"。
 * 这里改成认 `[msg=Tasker.Task.Succeeded|Failed]` 里的 `"task_id":N`，用 verdict+id 去重 → 一个任务只算一次。
 */
export function countTaskEvents(text, since = '') {
  const seen = new Set();
  const entries = { succeeded: [], failed: [] };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('msg=Tasker.Task.')) continue;
    const m = line.match(/\[msg=(Tasker\.Task\.(?:Succeeded|Failed))\][^\n]*?"task_id":(\d+)/);
    if (!m) continue;
    if (since) {
      const ts = line.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
      if (ts && `${ts[1]} ${ts[2]}` < since) continue;
    }
    const verdict = m[1] === 'Tasker.Task.Succeeded' ? 'succeeded' : 'failed';
    const key = `${verdict}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = (line.match(/"entry":"([^"]+)"/) ?? [])[1] ?? '';
    entries[verdict].push({ id: Number(m[2]), entry });
  }
  return {
    succeeded: entries.succeeded.length,
    failed: entries.failed.length,
    entries,
    failedNames: entries.failed.map((x) => x.entry).filter(Boolean),
    succeededNames: entries.succeeded.map((x) => x.entry).filter(Boolean)
  };
}

/** 数一段日志里出现了几次给定模式（纯函数）。 */
export function countPatterns(text, patterns = []) {
  return patterns.reduce((sum, p) => sum + (String(text ?? '').match(new RegExp(p, 'g')) ?? []).length, 0);
}

/** MAA 的 Link Start 是全局热键（配置里是 Ctrl+Shift+Alt+L）：只有提权进程发的键才有效。 */
export async function defaultSendHotkey(cfg = {}) {
  const keys = cfg.triggerHotkey?.keys ?? '^+%l';
  const activate = cfg.triggerHotkey?.activate ? String(cfg.triggerHotkey.activate) : '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    activate ? `try { $p = Get-Process -Name '${activate}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $null = (New-Object -ComObject WScript.Shell).AppActivate($p.Id) ; Start-Sleep -Milliseconds 600 } } catch { }` : '',
    `[System.Windows.Forms.SendKeys]::SendWait('${keys}')`
  ].filter(Boolean).join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-Command', script], { timeoutMs: 15000 });
  return { ok: r.ok, error: r.error };
}

export async function defaultListProcesses() {
  const r = await run('powershell.exe', ['-NoProfile', '-Command',
    'Get-Process | Select-Object -ExpandProperty ProcessName'], { timeoutMs: 15000 });
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 游戏窗口是否已经出现（Win32 模式靠窗口截图，进程在 ≠ 窗口在；纯查询）。 */
export async function defaultWindowReady(processNames = ['Arknights']) {
  const names = processNames.map((n) => `'${String(n).replace(/\.exe$/i, '')}'`).join(',');
  const r = await run('powershell.exe', ['-NoProfile', '-Command',
    `$p = Get-Process -Name ${names} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { 'yes' } else { 'no' }`],
  { timeoutMs: 15000 });
  return r.stdout.trim() === 'yes';
}

/**
 * 游戏进程的**所有**可见窗口的「长相」：标题 + 尺寸（只读）。
 *
 * 为什么要"所有"：终末地直启被拒时，进程里除了主窗口还有一个 `245x178` 的「游戏启动失败」
 * 弹窗（2026-10-23 实测）。只看第一个/最大的窗口会漏掉它，把失败当成功。
 *
 * 实现用 EnumWindows 而不是 `Get-Process … MainWindowHandle`：后者在**跨完整性级别**时会返回 0
 * （提权跑的游戏 vs 普通权限的调用方），EnumWindows + GetWindowRect 两边都能用。
 */
export async function defaultWindowInfo(processNames = ['Arknights']) {
  const names = processNames.map((n) => String(n).replace(/\.exe$/i, ''));
  const script = [
    // 必须强制 UTF-8 输出：PowerShell 默认按控制台代码页(GBK)输出，中文窗口标题到 Node 这边会变成乱码，
    // 于是「游戏启动失败」这种判据永远匹配不上（2026-10-23 实测踩到，标题解码成 "??Ϸ????ʧ??"）。
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type @"',
    'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;',
    'public class QbWin {',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
    '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    `  static readonly HashSet<string> Want = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ${names.map((n) => `"${n}"`).join(', ')} };`,
    '  public static List<string> FindAll() {',
    '    var found = new List<string>();',
    '    EnumWindows((h, l) => {',
    '      if (!IsWindowVisible(h)) return true;',
    '      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);',
    '      if (sb.Length == 0) return true;',
    '      int pid; GetWindowThreadProcessId(h, out pid);',
    '      string pname = "";',
    '      try { pname = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { return true; }',
    '      if (!Want.Contains(pname)) return true;',
    '      RECT r; GetWindowRect(h, out r);',
    '      found.Add(sb.ToString() + "\\t" + (r.Right - r.Left) + "\\t" + (r.Bottom - r.Top));',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return found;',
    '  }',
    '}',
    '"@',
    '$all = [QbWin]::FindAll();',
    'if ($all.Count -gt 0) { $all | ForEach-Object { Write-Output $_ } }',
  ].join('\n');
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 25000 });
  const lines = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const windows = lines.map((line) => {
    const [title, w, h] = line.split('\t');
    const width = Number(w);
    const height = Number(h);
    return { title: String(title ?? ''), width: Number.isFinite(width) ? width : NaN, height: Number.isFinite(height) ? height : NaN };
  });
  if (!windows.length) return null;
  return { windows };
}

/** 窗口集合里最大的那个（判"有没有真游戏窗口"用）。 */
export function largestWindow(info) {
  const list = Array.isArray(info?.windows) ? info.windows : [];
  if (!list.length) return null;
  return list.reduce((a, b) => ((b.width * b.height) > (a.width * a.height) ? b : a));
}

/**
 * 这组窗口里有没有"游戏启动失败"弹窗（而不是游戏本体）？（纯函数，便于单测）
 *
 * 为什么必须判：2026-10-23 终末地更新后，直接跑 `Endfield.exe` 会被启动器校验拒绝
 * （游戏侧校验 `U8Data\config\Launcher.meta` 票据），弹出一个 245x178 的「游戏启动失败」小窗。
 * 旧逻辑只看「进程在 + 有窗口」，于是把失败弹窗当成"游戏起来了" —— 接着起 MAA、
 * 白等到 30 分钟兜底才收尾（2026-10-23 19:21 实测踩到）。
 *
 * 判据：
 *   1) 任意窗口标题含「启动失败/无法启动/failed to launch/error」→ 失败弹窗（强信号）；
 *   2) 或者所有窗口都小得离谱（最大那个 < 400x300）→ 根本没有真游戏窗口。
 */
export function isBrokenGameWindow(info) {
  const list = Array.isArray(info?.windows) ? info.windows : [];
  if (!list.length) return false;
  for (const w of list) {
    if (/启动失败|启动不了|无法启动|启动异常|failed to launch|launch fail(ed)?|error/i.test(String(w.title ?? ''))) return true;
  }
  const big = largestWindow(info);
  if (big && Number.isFinite(big.width) && Number.isFinite(big.height) && big.width > 0 && big.height > 0) {
    if (big.width < 400 || big.height < 300) return true;
  }
  return false;
}

/**
 * 点击几何判据（纯函数，便于单测）：窗口尺寸是否与期望相符。
 *
 * 为什么必须先核对尺寸再点：坐标是 owner 量出来的「点在哪」。启动器记住的窗口大小可能不同
 * （2026-10-23 实测就出现过 1312x754），尺寸不对时同一个像素点会落到**别的按钮**上
 * （更新/公告/购买…）。宁可放弃点击退回"等人点"，也不乱点。
 */
export function checkLauncherGeometry(info, expect = {}) {
  // 允许传整份配置（{expect:{…}}）或直接传期望对象（{width,height,tolerancePct}）
  const e = expect?.expect ?? expect ?? {};
  const tolerancePct = Number(e.tolerancePct ?? 8);
  const wantW = Number(e.width);
  const wantH = Number(e.height);
  const win = largestWindow(info);
  if (!win) return { ok: false, reason: '没找到启动器窗口' };
  const w = Number(win.width);
  const h = Number(win.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return { ok: false, reason: `读不到窗口尺寸`, window: win };
  const tol = Math.max(1, tolerancePct) / 100;
  const dw = Math.abs(w - wantW) / wantW;
  const dh = Math.abs(h - wantH) / wantH;
  if (dw <= tol && dh <= tol) return { ok: true, window: win, expected: { width: wantW, height: wantH } };
  return {
    ok: false,
    window: win,
    reason: `窗口尺寸 ${w}x${h} 与期望 ${wantW}x${wantH} 相差超过 ${tolerancePct}%（±${Math.round(dw * 100)}% / ±${Math.round(dh * 100)}%）`,
  };
}

/**
 * 在启动器上点「开始游戏」：置前 →（必要时调整窗口尺寸）→ 按客户区坐标点击。
 *
 * 坐标以**客户区左上角**为原点；点击前会把窗口激活并做尺寸校验（见 checkLauncherGeometry）。
 * 只做"点一下"，是否真的把游戏拉起来由调用方用 waitForGame 判定。
 */
export async function defaultClickLauncherWindow(cfg = {}, opts = {}) {
  const names = (cfg.launcherProcessNames ?? ['Games.exe', 'Launcher.exe']).map((n) => String(n).replace(/\.exe$/i, ''));
  const click = cfg.launcherClick ?? {};
  const point = click.point ?? { x: 1397, y: 816 };
  const expect = click.expect ?? { width: 1640, height: 943, tolerancePct: 8 };
  const resize = click.resizeIfNeeded !== false;
  const settleMs = Number(click.settleMs ?? 1200);

  const script = [
    // 强制 UTF-8：中文窗口标题/日志别乱码（踩过）
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type @"',
    'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;',
    'public class QbClick {',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
    '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);',
    '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);',
    '  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);',
    '  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);',
    '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  public struct POINT { public int X; public int Y; }',
    `  static readonly HashSet<string> Want = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ${names.map((n) => `"${n}"`).join(', ')} };`,
    '  public static IntPtr Find() {',
    '    IntPtr res = IntPtr.Zero;',
    '    EnumWindows((h, l) => {',
    '      if (!IsWindowVisible(h)) return true;',
    '      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);',
    '      if (sb.Length == 0) return true;',
    '      int pid; GetWindowThreadProcessId(h, out pid);',
    '      string pname = "";',
    '      try { pname = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { return true; }',
    '      if (!Want.Contains(pname)) return true;',
    '      res = h; return false;',
    '    }, IntPtr.Zero);',
    '    return res;',
    '  }',
    '  public static string Info(IntPtr h) {',
    '    RECT r; GetWindowRect(h, out r);',
    '    RECT c; GetClientRect(h, out c);',
    '    var sb = new StringBuilder(256); GetWindowText(h, sb, 256);',
    '    return sb.ToString() + "\\t" + (r.Right - r.Left) + "\\t" + (r.Bottom - r.Top)',
    '      + "\\t" + (c.Right - c.Left) + "\\t" + (c.Bottom - c.Top) + "\\t" + (IsIconic(h) ? "1" : "0");',
    '  }',
    '  public static void Activate(IntPtr h) { if (IsIconic(h)) ShowWindow(h, 9); ShowWindow(h, 5); SetForegroundWindow(h); }',
    '  // 真正把窗口抬到最前：SetForegroundWindow 常被系统静默拒绝（后台进程抢前台受限），',
    '  // 实测 2026-10-23：MaEnd 的"发现新版本"对话框压在启动器上面，点击落到了 MaaEnd 上。',
    '  // 做法：先 HWND_TOPMOST 再 HWND_NOTOPMOST —— 抬到最前但不长期霸占置顶。',
    '  public static void Raise(IntPtr h) {',
    '    SetWindowPos(h, new IntPtr(-1) /*HWND_TOPMOST*/, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040 /*NOSIZE|NOMOVE|SHOWWINDOW*/);',
    '    SetWindowPos(h, new IntPtr(-2) /*HWND_NOTOPMOST*/, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
    '  }',
    '  // 点击期间**保持置顶**：普通对话框（比如 MaaEnd 的更新弹窗）就压不住了。',
    '  // 实测坑：WindowFromPoint 在跨完整性级别时不可靠（截图里明明被盖住，它却报 SELF），',
    '  // 所以不靠它判断，改用"置顶 + 点完就取消"这种确定性手段。',
    '  public static void SetTopmost(IntPtr h) {',
    '    SetWindowPos(h, new IntPtr(-1) /*HWND_TOPMOST*/, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
    '  }',
    '  public static void ClearTopmost(IntPtr h) {',
    '    SetWindowPos(h, new IntPtr(-2) /*HWND_NOTOPMOST*/, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);',
    '  }',
    '  // 屏幕坐标处**最上面**那个窗口是不是目标窗口（含其子窗口）？不是就说明被别的窗口挡住了。',
    '  public static string Occluder(IntPtr h, int screenX, int screenY) {',
    '    var p = new POINT { X = screenX, Y = screenY };',
    '    IntPtr under = WindowFromPoint(p);',
    '    if (under == IntPtr.Zero) return "NONE";',
    '    IntPtr root = GetAncestor(under, 2 /*GA_ROOT*/);',
    '    if (root == h) return "SELF";',
    '    var sb = new StringBuilder(256); GetWindowText(root, sb, 256);',
    '    int pid; GetWindowThreadProcessId(root, out pid);',
    '    string n = "";',
    '    try { n = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { }',
    '    return "OTHER " + n + ":" + sb.ToString();',
    '  }',
    '  public static void Resize(IntPtr h, int w, int ht) {',
    '    RECT r; GetWindowRect(h, out r);',
    '    SetWindowPos(h, IntPtr.Zero, r.Left, r.Top, w, ht, 0x0004 /*SWP_NOZORDER*/);',
    '  }',
    '  // 把挡在点击点上的窗口最小化（不是关掉，随时能还原），让点击能落到启动器上。',
    '  public static string MinimizeOccluder(IntPtr h, int screenX, int screenY) {',
    '    var p = new POINT { X = screenX, Y = screenY };',
    '    IntPtr under = WindowFromPoint(p);',
    '    if (under == IntPtr.Zero) return "NONE";',
    '    IntPtr root = GetAncestor(under, 2);',
    '    if (root == h) return "SELF";',
    '    var sb = new StringBuilder(256); GetWindowText(root, sb, 256);',
    '    ShowWindow(root, 6 /*SW_MINIMIZE*/);',
    '    return "MINIMIZED " + sb.ToString();',
    '  }',
    '  public static string ClickClient(IntPtr h, int x, int y) {',
    '    RECT c; GetClientRect(h, out c);',
    '    int cw = c.Right - c.Left, ch = c.Bottom - c.Top;',
    '    if (x < 0 || y < 0 || x >= cw || y >= ch) return "OUT_OF_CLIENT " + x + "," + y + " client=" + cw + "x" + ch;',
    '    var p = new POINT { X = x, Y = y };',
    '    if (!ClientToScreen(h, ref p)) return "CLIENT_TO_SCREEN_FAILED";',
    '    SetCursorPos(p.X, p.Y);',
    '    mouse_event(0x0002 /*LEFTDOWN*/, 0, 0, 0, IntPtr.Zero);',
    '    mouse_event(0x0004 /*LEFTUP*/, 0, 0, 0, IntPtr.Zero);',
    '    return "CLICKED " + p.X + "," + p.Y + " (client " + x + "," + y + " of " + cw + "x" + ch + ")";',
    '  }',
    '  public static string ProbeClient(IntPtr h, int x, int y) {',
    '    RECT c; GetClientRect(h, out c);',
    '    int cw = c.Right - c.Left, ch = c.Bottom - c.Top;',
    '    var p = new POINT { X = x, Y = y };',
    '    if (!ClientToScreen(h, ref p)) return "CLIENT_TO_SCREEN_FAILED";',
    '    return "DRYRUN client=" + x + "," + y + " of " + cw + "x" + ch + " -> screen " + p.X + "," + p.Y;',
    '  }',
    '}',
    '"@',
    '$h = [QbClick]::Find();',
    'if ($h -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 0 }',
    'Write-Output ("BEFORE`t" + [QbClick]::Info($h))',
    `$wantW = ${Number(expect.width)}; $wantH = ${Number(expect.height)};`,
    `$pointX = ${Number(point.x)}; $pointY = ${Number(point.y)};`,
    `$resize = ${resize ? '$true' : '$false'};`,
    '$r = New-Object Object;',
    'if ($resize) { [QbClick]::Resize($h, $wantW, $wantH); Start-Sleep -Milliseconds 400 }',
    '[QbClick]::Activate($h);',
    // 点击期间保持置顶：普通对话框压不住（WindowFromPoint 跨权限不可信，实测报 SELF）
    '[QbClick]::SetTopmost($h);',
    `Start-Sleep -Milliseconds ${settleMs};`,
    'Write-Output ("AFTER`t" + [QbClick]::Info($h))',
    '$probe = [QbClick]::ProbeClient($h, $pointX, $pointY);',
    'Write-Output ("PROBE`t" + $probe)',
    '$xy = (($probe -split "-> screen ")[1]);',
    'if ($xy) { $pt = $xy.Split(","); Write-Output ("OCCLUDER`t" + [QbClick]::Occluder($h, [int]$pt[0], [int]$pt[1])) }',
    // dryRun：只算坐标、不真的点（用来核对"点会落在哪个位置"，避免盲点）
    (opts.dryRun
      ? 'Write-Output ("DRYRUN`t" + $probe)'
      : 'Write-Output ("CLICK`t" + [QbClick]::ClickClient($h, $pointX, $pointY))'),
    // 点完立刻取消置顶，别长期霸占
    '[QbClick]::ClearTopmost($h);',
  ].join('\n');

  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 60000 });
  const out = String(r.stdout ?? '');
  const lineOf = (tag) => out.split(/\r?\n/).find((l) => l.startsWith(tag)) ?? '';
  if (out.includes('NO_WINDOW')) return { ok: false, error: '没找到启动器窗口（先把启动器拉起来再点）' };
  const parse = (line) => {
    const p = line.split('\t');
    if (p.length < 6) return null;
    return { title: p[1], width: Number(p[2]), height: Number(p[3]), clientWidth: Number(p[4]), clientHeight: Number(p[5]), minimized: p[6] === '1' };
  };
  const after = parse(lineOf('AFTER')) ?? parse(lineOf('BEFORE'));
  const clickLine = lineOf('CLICK') || lineOf('DRYRUN');
  if (!after) return { ok: false, error: `读不到启动器窗口信息（输出：${out.slice(0, 200)}）` };
  // 点击前先看"那个屏幕点上最上面的是谁"：被别的窗口挡住就不点（点了也是点到别人身上）
  const occluder = lineOf('OCCLUDER').replace(/^OCCLUDER\s*/, '');
  if (opts.dryRun) {
    // 干跑：只回报坐标与遮挡情况，不点击、也不当失败
    return { ok: true, dryRun: true, window: after, detail: clickLine, occluder, occluded: occluder && occluder !== 'SELF' && occluder !== 'NONE' };
  }
  if (occluder && occluder !== 'SELF' && occluder !== 'NONE') {
    return { ok: false, error: `点击点被别的窗口挡住（${occluder}）：先把它挪开或关掉再试`, window: after, occluder };
  }
  // 尺寸核对用客户区：坐标就是相对客户区的
  const geo = checkLauncherGeometry({ windows: [{ title: after.title, width: after.clientWidth, height: after.clientHeight }] }, expect);
  if (!geo.ok) {
    return { ok: false, error: `尺寸不符，未点击：${geo.reason}（客户区 ${after.clientWidth}x${after.clientHeight}）`, window: after };
  }
  if (!clickLine.includes('CLICKED')) return { ok: false, error: `点击失败：${clickLine || '(无输出)'}`, window: after };
  return { ok: true, window: after, detail: clickLine.replace(/^CLICK\s*/, ''), occluder };
}


/**
 * MAA 这次用哪种方式连游戏（决定要不要等 ADB）：
 *   ConnectSettings.Config == "PC" → Win32 截图/点击（官方 PC 端），**不需要 ADB**
 *   其它 → 按 ADB 处理（模拟器那种）
 */
export async function defaultMaaConnectMode(cfg) {
  try {
    const json = JSON.parse(fs.readFileSync(cfg.maaConfigPath, 'utf8').replace(/^\uFEFF/, ''));
    const conf = json?.Configurations?.Default?.Gui?.ConnectSettings?.Config;
    return /^pc$/i.test(String(conf ?? '')) ? 'pc' : 'adb';
  } catch {
    return 'unknown';
  }
}

export async function defaultKillByName(names) {
  const killed = []; const failed = [];
  for (const name of names) {
    const r = await run('taskkill.exe', ['/IM', name, '/T', '/F'], { timeoutMs: 15000 });
    (r.ok ? killed : failed).push(name);
  }
  return { killed, failed };
}

/**
 * 启动一个候选命令（游戏本体或鹰角启动器）。候选由配置给，args 也由配置给。
 */
export async function defaultStartClient(candidate) {
  try {
    const exe = typeof candidate === 'string' ? candidate : candidate?.exe;
    const args = typeof candidate === 'string' ? [] : (Array.isArray(candidate?.args) ? candidate.args : []);
    if (!exe) return { ok: false, error: '候选命令没有 exe' };
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 把 MAA 的两个设置调对（改前备份一次 .bak-arknights）：
 *   RunDirectly = true   → 启动 MAA 就自动开始任务队列（省掉模拟点击）
 *   StartGame   = false  → 客户端由执行器先拉起，不让 MAA 再试（它试也失败）
 */
export async function defaultPrepareMaa(cfg) {
  const patches = Array.isArray(cfg.autoRunPatches) ? cfg.autoRunPatches : [];
  if (!patches.length) return { ok: true, changed: false, items: [] };
  const docs = new Map();
  const changed = [];
  try {
    for (const patch of patches) {
      const file = patch.file ? String(patch.file) : cfg.maaConfigPath;
      if (!docs.has(file)) {
        const original = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        docs.set(file, { json: JSON.parse(original), dirty: false });
      }
      const doc = docs.get(file);
      const keys = patch.path ?? [];
      let node = doc.json;
      for (const key of keys.slice(0, -1)) node = node?.[key];
      const leaf = keys[keys.length - 1];
      if (!node || leaf === undefined) return { ok: false, error: `${file} 里找不到 ${keys.join('.')}` };
      if (node[leaf] !== patch.value) {
        node[leaf] = patch.value;
        doc.dirty = true;
        changed.push(patch.label ?? `${keys.join('.')}=${patch.value}`);
      }
    }
    for (const [file, doc] of docs) {
      if (!doc.dirty) continue;
      fs.copyFileSync(file, `${file}.bak-gamedaily`);
      fs.writeFileSync(file, JSON.stringify(doc.json, null, 2), 'utf8');
    }
    return { ok: true, changed: changed.length > 0, items: changed };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 主流程（依赖全部可注入，便于离线测试）。 */
export async function runJob(cfg, args = {}, deps = {}) {
  const {
    isElevated = defaultIsElevated,
    adbConnect = defaultAdbConnect,
    portOwner = defaultPortOwner,
    startMaa = defaultStartMaa,
    startClient = defaultStartClient,
    prepareMaa = defaultPrepareMaa,
    sendHotkey = defaultSendHotkey,
    listProcesses = defaultListProcesses,
    windowReady = defaultWindowReady,
    windowInfo = defaultWindowInfo,
    clickLauncher = defaultClickLauncherWindow,
    maaConnectMode = defaultMaaConnectMode,
    logFiles = resolveWatchFiles,
    expectedTaskCount = defaultExpectedTaskCount,
    killByName = defaultKillByName,
    readText = (p) => fs.readFileSync(p, 'utf8'),
    statSize = (p) => fs.statSync(p).size,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    log = makeLogger(cfg.logFile, cfg.profile),
    exists = (p) => fs.existsSync(p)
  } = deps;

  const job = {
    startedAt: now(), finishedAt: null, ok: false, reason: '', dryRun: !!args.dryRun,
    elevated: null, maaPid: null, adb: null, portOwner: '', trigger: cfg.trigger,
    startedClient: false, clientLaunchedBy: null, clientAttempts: [], gameRunning: false, logSince: '',
    profile: cfg.profile, toolProcessNames: cfg.toolProcessNames, expectedTaskCount: 0, successCount: 0, failedCount: 0, failedTasks: [], failedNames: [], watchedFiles: [], completionBy: null, toolMissStreak: 0,
    finishedTasks: [], closedMaa: false, closedClient: false, clientKilled: [], logTail: [], timeoutSec: cfg.timeoutSec
  };
  const finish = (ok, reason) => {
    job.ok = !!ok;
    job.reason = reason;
    job.finishedAt = now();
    return job;
  };

  log(`开始：timeout=${cfg.timeoutSec}s poll=${cfg.pollSec}s trigger=${cfg.trigger} dryRun=${!!args.dryRun}`);

  // ① 前置检查（先看 MAA 走哪种连接：PC 端走 Win32，ADB 通不通与能不能跑无关）
  job.connectMode = cfg.connectMode && cfg.connectMode !== 'auto' ? cfg.connectMode : await maaConnectMode(cfg).catch(() => 'unknown');
  const adbRequired = job.connectMode !== 'pc';
  job.elevated = await isElevated();
  job.adb = adbRequired ? await adbConnect(cfg).catch((e) => ({ ok: false, error: e?.message ?? String(e) })) : { ok: null, skipped: true };
  job.portOwner = adbRequired ? await portOwner(cfg.adbAddress).catch(() => '') : '';
  const pre = decidePreflight({
    elevated: job.elevated,
    maaExists: exists(cfg.maaPath),
    adbDeviceOnline: !!job.adb?.ok,
    adbError: job.adb?.error,
    portOwner: job.portOwner,
    adbRequired
  });
  log(`前置检查：提权=${job.elevated} MAA=${exists(cfg.maaPath)} 连接方式=${job.connectMode}${adbRequired ? ` ADB=${job.adb?.ok} 端口占用=${job.portOwner || '（无）'}` : '（Win32 截图/点击，不需要 ADB）'}`);
  for (const w of pre.warnings) log(`⚠️ ${w}`);
  for (const b of pre.blockers) log(`❌ ${b}`);
  if (!pre.ok) return finish(false, pre.blockers.join('；'));
  if (args.dryRun) {
    return finish(true, adbRequired
      ? `预检通过（dry-run 不启动客户端/MAA）：ADB ${job.adb?.ok ? '已连' : '未连（会由执行器先拉客户端）'}`
      : '预检通过（dry-run 不启动客户端/MAA）：PC 端走 Win32 截图/点击，不需要 ADB');
  }

  if (args.prepareMaa) {
    const r = await prepareMaa(cfg);
    return finish(r.ok, r.ok
      ? (r.changed ? `已调好 MAA 设置：${(r.items ?? []).join('、')}` : 'MAA 设置本来就对（RunDirectly=true / StartGame=false）')
      : `改 MAA 配置失败：${r.error}`);
  }

  // ② MAA 已经在跑就先退出：否则会和我们要起的那只抢同一个客户端，而且它退出时会把我们刚写的
  //    MAA 设置覆盖回去（MAA 是"退出时保存整个配置"的）。
  const procs0 = await listProcesses().catch(() => []);
  const toolNames = (cfg.toolProcessNames ?? ['MAA']).map((n) => String(n).replace(/\.exe$/i, '').toLowerCase());
  const toolRunning = (procs) => procs.some((p) => toolNames.includes(String(p).replace(/\.exe$/i, '').toLowerCase()));
  if (toolRunning(procs0)) {
    return finish(false, `${cfg.toolProcessNames.join('/')} 已经在运行了：先手动关掉它再触发（避免两个抢同一个游戏窗口）`);
  }

  // ③ 触发方式：auto=先调好「直接运行」；hotkey/兜底=启动后发 Link Start 热键
  if (cfg.trigger === 'auto') {
    const r = await prepareMaa(cfg);
    if (!r.ok) log(`⚠️ 调 MAA 设置失败（${r.error}），改用热键触发`);
    else if (r.changed) log(`MAA 设置已调：${(r.items ?? []).join('、')}`);
  } else {
    log('按配置用热键触发（Ctrl+Shift+Alt+L）');
  }

  // ④ **先起官方 PC 端**：按候选链试，并以「游戏进程真的出现」为准（桌面图标只开启动器，不算成功）。
  //    候选全失败时，把启动器留给 owner 点一下，再等一段时间。
  //    判定只看游戏本体进程（Arknights.exe / Endfield.exe）：PlatformProcess.exe 是反作弊平台的常驻
  //    辅助进程，游戏没开它也可能在 —— 2026-09-29 22:47 就是被它骗成"已在运行"，白等一轮。
  const matchedGameNames = (procs) => (cfg.clientProcesses ?? []).filter((n) => {
    const want = String(n).replace(/\.exe$/i, '').toLowerCase();
    return (procs ?? []).some((p) => String(p).replace(/\.exe$/i, '').toLowerCase() === want);
  });

  /**
   * 等游戏本体进程出现（最多 sec 秒）；成功时把 job 的成功字段一并写好。
   *
   * 注意：这里**只判进程**。区分"真游戏窗口 / 启动失败弹窗"放在后面的 `waitGameWindow`：
   * 那个函数本来就要等窗口出现，而终末地的「游戏启动失败」弹窗大约 15s 才出来 ——
   * 在 waitForGame 里轮询窗口既抓不准、又会把每个候选的耗时拖长（测试里 clientBootSec=1 会被拖挂）。
   */
  const waitForGame = async (sec) => {
    const t0 = now();
    while (now() - t0 < sec * 1000) {
      await sleep(3000);
      if (isGameRunning(await listProcesses().catch(() => []), cfg.clientProcesses)) {
        // 成功也要**明确打一行**（2026-09-29 22:0x 教训：只在失败时说话，owner 会以为检查失败）
        job.startedClient = true;
        job.clientBootMs = now() - t0;
        log(`✅ 检测到游戏进程：${cfg.clientProcesses.join(' / ')}（用时 ${Math.round(job.clientBootMs / 1000)}s）`);
        return true;
      }
    }
    return false;
  };

  /** 启动器是不是正在运行（Games.exe / Launcher.exe）。 */
  const launcherRunning = async () => {
    const names = cfg.launcherProcessNames ?? [];
    if (!names.length) return false;
    const procs = await listProcesses().catch(() => []);
    return isGameRunning(procs, names);
  };

  /**
   * 「点启动器上的开始游戏」这条候选：先确保启动器窗口在，再按几何参数点一下。
   * 返回 true 表示**点下去了**（是否真把游戏拉起来由后面的 waitForGame 判定）。
   */
  const clickLauncherCandidate = async (candidate) => {
    const lc = cfg.launcherClick ?? {};
    if (lc.enabled === false) { log('⚠️ launcherClick.enabled=false：跳过点击'); return false; }
    const label = `点启动器开始游戏（客户区 ${lc.point?.x ?? '?'},${lc.point?.y ?? '?'}）`;
    const names = cfg.launcherProcessNames ?? [];
    const hasWindow = async () => {
      const info = await windowInfo(names).catch(() => null);
      return info && (info.windows ?? []).length ? info : null;
    };

    // 关键区分：**"启动器进程在"不等于"有窗口"**。
    // 2026-10-23 实测踩过：一个没有窗口的僵尸 Launcher.exe（非提权启动、卡在等待）让脚本以为
    // "启动器已在运行"，于是跳过启动、干等 15s 窗口不存在、整条点击路径失效。
    let info = await hasWindow();
    if (!info) {
      const procRunning = await launcherRunning();
      if (procRunning) {
        log('⚠️ 启动器进程在、但没有窗口（僵尸进程）：关掉它重开一个');
        const closed = await killByName(names).catch(() => ({ killed: [], failed: [] }));
        if (closed?.killed?.length) log(`   已关闭：${closed.killed.join('、')}`);
        await sleep(1500);
      }
      const started = await startClient(candidate);
      job.clientAttempts.push({ target: `${path.basename(candidate.exe)}（仅启动界面）`, ok: started.ok, pid: started.pid ?? null, error: started.error ?? '' });
      log(started.ok ? `先拉起启动器界面（PID ${started.pid ?? '?'}）` : `⚠️ 拉起启动器失败：${started.error}`);
    } else {
      log(`启动器窗口已在（${info.windows[0].title} ${info.windows[0].width}x${info.windows[0].height}），直接点「开始游戏」`);
    }

    // 等启动器窗口出现
    const w0 = now();
    const waitMs = Number(lc.windowWaitMs ?? 15000);
    while (now() - w0 < waitMs) {
      info = await hasWindow();
      if (info) break;
      await sleep(1000);
    }
    if (!info) {
      log(`⚠️ ${Math.round(waitMs / 1000)}s 内没看到启动器窗口，跳过点击`);
      return false;
    }
    const clicked = await clickLauncher(cfg).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    job.clickAttempt = { ok: clicked.ok === true, error: clicked.error ?? '', window: clicked.window ?? null, detail: clicked.detail ?? '' };
    if (!clicked.ok) {
      log(`⚠️ 点击「开始游戏」没成功：${clicked.error}`);
      job.clientAttempts.push({ target: label, ok: false, pid: null, error: clicked.error ?? '' });
      return false;
    }
    log(`🖱️ 已点击「开始游戏」（${clicked.detail ?? ''}；窗口 ${clicked.window?.title ?? '?'} 客户区 ${clicked.window?.clientWidth}x${clicked.window?.clientHeight}）`);
    job.clientAttempts.push({ target: label, ok: true, pid: null, error: '' });
    return true;
  };

  /** 按候选链启动客户端，直到"游戏进程真的出现"。成功返回 true。 */
  const tryLaunchCandidates = async () => {
    // 启动前先清掉**残留的 MaaEnd**：它是我们自己的工具，本轮稍后会重新起；
    // 而它若停着，往往还带一个"发现新版本/更新完成"对话框，会压住启动器窗口 ——
    // 2026-10-23 实测：点「开始游戏」的坐标正好落在 MaaEnd 的更新弹窗上，游戏因此没起来。
    const toolNames = (cfg.toolProcessNames ?? []).map((n) => (/\.exe$/i.test(n) ? n : `${n}.exe`));
    if (toolNames.length && (await listProcesses().catch(() => [])).some((p) => isGameRunning([p], toolNames))) {
      log(`先关掉残留的 ${toolNames.join('/')}（它可能带着更新弹窗，会挡住启动器）`);
      const r = await killByName(toolNames).catch(() => ({ killed: [], failed: [] }));
      if (r?.killed?.length) log(`   已关闭：${r.killed.join('、')}`);
      await sleep(1200);
    }
    for (const candidate of cfg.clientCandidates) {
      const label = `${path.basename(candidate.exe)}${candidate.args?.length ? ' ' + candidate.args.join(' ') : ''}`;
      // ① 「点开始游戏」候选：不是"启动一个 exe"，而是先确保启动器窗口在、再点按钮
      if (candidate.click) {
        if (!(await clickLauncherCandidate(candidate))) continue;
        log(`等游戏进程出现（最多 ${cfg.clientBootSec}s）`);
        if (await waitForGame(cfg.clientBootSec)) {
          job.clientLaunchedBy = `${label}（点开始游戏）`;
          return true;
        }
        log(`⚠️ 点了「开始游戏」，但 ${cfg.clientBootSec}s 内没看到游戏进程：换下一个候选`);
        continue;
      }
      const started = await startClient(candidate);
      job.clientAttempts.push({ target: label, ok: started.ok, pid: started.pid ?? null, error: started.error ?? '' });
      if (!started.ok) {
        log(`⚠️ 启动 ${label} 失败：${started.error}`);
        continue;
      }
      log(`已启动 ${label}（PID ${started.pid ?? '?'}）：等游戏进程出现（最多 ${cfg.clientBootSec}s）`);
      if (await waitForGame(cfg.clientBootSec)) {
        job.clientLaunchedBy = label;
        return true;
      }
      // 启动器候选的特殊情况：启动器**本来就已经开着**时，新起的 Launcher.exe 会被单实例
      // 交接吞掉（参数不会被执行），游戏自然起不来。这时把启动器关掉，用同样的命令重试一次。
      // 2026-10-23 终末地更新后游戏侧会校验"是否由启动器拉起"，所以这条路径是主路径。
      if (candidate.launcher && (await launcherRunning())) {
        log(`⚠️ ${label} 没把游戏拉起来，且启动器还在运行（单实例会吞掉参数）：关掉启动器后重试一次`);
        const closed = await killByName(cfg.launcherProcessNames ?? []).catch(() => ({ killed: [], failed: [] }));
        if (closed?.killed?.length) log(`   已关闭启动器：${closed.killed.join('、')}`);
        await sleep(2000);
        const retry = await startClient(candidate);
        job.clientAttempts.push({ target: `${label}（关掉启动器后重试）`, ok: retry.ok, pid: retry.pid ?? null, error: retry.error ?? '' });
        if (retry.ok) {
          log(`已重新启动 ${label}（PID ${retry.pid ?? '?'}）：再等游戏进程 ${cfg.clientBootSec}s`);
          if (await waitForGame(cfg.clientBootSec)) {
            job.clientLaunchedBy = `${label}（关掉启动器后重试成功）`;
            return true;
          }
        } else {
          log(`⚠️ 重试启动 ${label} 失败：${retry.error}`);
        }
      }
      log(`⚠️ ${label} 起来了，但 ${cfg.clientBootSec}s 内没看到游戏进程（可能只是启动了启动器），换下一个候选`);
    }
    return false;
  };

  /** 等游戏窗口真的出现（Win32 截图需要窗口：有进程 ≠ 有窗口）。 */
  const waitGameWindow = async () => {
    const brokenInfo = async () => windowInfo(cfg.clientProcesses).catch(() => null);
    const describe = (info) => (info?.windows ?? []).map((w) => `${w.title} ${w.width}x${w.height}`).join(' / ');

    if (await windowReady(cfg.clientProcesses).catch(() => true)) {
      // 有窗口也要看"是不是失败弹窗"：终末地直启被拒时，那个 245x178 的「游戏启动失败」
      // 也会让 windowReady 返回 true（2026-10-23 实测：脚本因此白等 30 分钟）。
      const info = await brokenInfo();
      if (isBrokenGameWindow(info)) {
        log(`⚠️ 检测到的"窗口"其实是启动失败弹窗（${describe(info)}）：判定这个候选启动失败`);
        await killByName(cfg.clientProcesses).catch(() => ({ killed: [], failed: [] }));
        return false;
      }
      return true;
    }
    const w0 = now();
    log(`游戏进程在，但窗口还没出来：最多再等 ${cfg.windowWaitSec}s（Win32 截图需要窗口）`);
    while (now() - w0 < cfg.windowWaitSec * 1000) {
      await sleep(2000);
      const info = await brokenInfo();
      if (isBrokenGameWindow(info)) {
        log(`⚠️ 出现的是启动失败弹窗（${describe(info)}）：这不是游戏窗口，判定这个候选启动失败`);
        await killByName(cfg.clientProcesses).catch(() => ({ killed: [], failed: [] }));
        return false;
      }
      if (await windowReady(cfg.clientProcesses).catch(() => true)) {
        log(`✅ 游戏窗口已出现（用时 ${Math.round((now() - w0) / 1000)}s）`);
        return true;
      }
    }
    return false;
  };

  let gameUp = isGameRunning(procs0, cfg.clientProcesses);
  let skippedBecauseRunning = false;
  if (gameUp) {
    const names = matchedGameNames(procs0).join('、');
    log(`官方 PC 端已在运行（匹配进程：${names}），跳过启动`);
    job.startedClient = true;
    job.clientLaunchedBy = `（已在运行：${names}）`;
    skippedBecauseRunning = true;
  } else if (cfg.startClient) {
    gameUp = await tryLaunchCandidates();
    if (!gameUp) {
      // 2026-10-23 起终末地的现实：游戏侧校验"是否由启动器拉起"（一次性票据 Launcher.meta），
      // 直启会被弹「游戏启动失败」，而启动器的 --game/--reason 参数**并不能**触发启动。
      // 所以这里如实说"要人去启动器点一下"，然后按 manualWaitSec 等他点。
      log(`⚠️ 候选都没能拉起游戏。注意：终末地现在**必须由启动器拉起**（游戏侧校验启动票据），`
        + `而启动器的 --game/--reason 参数实测不触发启动 → 请你在启动器里点「开始游戏」，`
        + `我最多再等 ${Math.round(cfg.manualWaitSec / 60)} 分钟（你一点，我就接着跑）`);
      const t1 = now();
      while (now() - t1 < cfg.manualWaitSec * 1000) {
        await sleep(5000);
        if (isGameRunning(await listProcesses().catch(() => []), cfg.clientProcesses)) {
          gameUp = true; job.clientLaunchedBy = '（手动启动）';
          log('✅ 检测到游戏进程（手动启动的）');
          break;
        }
      }
      job.startedClient = gameUp;
    }
  } else {
    log('⚠️ startClient=false：不主动起客户端，直接起 MAA（可能因客户端没开而失败）');
  }
  job.gameRunning = gameUp;

  // 窗口确认（+ 自愈）：如果"已在运行"是误判（残留/辅助进程），窗口永远不会出来 → 照样走候选链
  if (gameUp) {
    let windowOk = await waitGameWindow();
    if (!windowOk && skippedBecauseRunning && cfg.startClient) {
      log('⚠️ 有进程匹配、但窗口一直没出现：按"误判/残留进程"处理，改用候选链启动游戏');
      job.startedClient = false;
      job.clientLaunchedBy = null;
      gameUp = await tryLaunchCandidates();
      if (gameUp) windowOk = await waitGameWindow();
      job.startedClient = gameUp;
      job.gameRunning = gameUp;
      log(gameUp ? '✅ 候补启动成功' : '❌ 候补启动也没把游戏拉起来');
    }
  }
  await sleep(cfg.clientWaitSec * 1000);

  // ③ ADB：**只有走 ADB 的模式才等**。官方 PC 端是 Win32 截图/点击，16384 全程没人听也照样能跑
  //    （2026-09-29 22:0x 实测：MAA 用 Win32Controller::screencap/click 正常打完 1-7，之前那条 ADB 警告是误报）。
  let adbReady = false;
  if (adbRequired) {
    const adbDeadline = now() + cfg.adbWaitSec * 1000;
    while (now() < adbDeadline) {
      const a = await adbConnect(cfg).catch(() => ({ ok: false }));
      if (a.ok) { adbReady = true; break; }
      await sleep(5000);
    }
    log(adbReady ? `ADB 已就绪（${cfg.adbAddress}），可以起 MAA` : `⚠️ 等了 ${cfg.adbWaitSec}s ADB 还是没连上，照样起 MAA（它自己还会重试，但很可能失败）`);
  } else {
    log('PC 端模式（Win32 截图/点击）：不等 ADB');
  }
  job.adbReady = adbReady;

  // ⑤ 记录日志起点 → 启动 MAA
  const offsets = new Map();
  for (const file of logFiles(cfg)) {
    try { offsets.set(file, statSize(file)); } catch { offsets.set(file, 0); }
  }
  job.expectedTaskCount = await expectedTaskCount(cfg).catch(() => 0);
  const started = await startMaa(cfg);
  if (!started.ok) return finish(false, `启动工具失败：${started.error}`);
  job.maaPid = started.pid ?? null;
  job.maaDeElevated = !!started.deElevated;
  // 只认这个时间点之后的日志行（往前留 2 秒余量）；轮转过来的旧文件里可能有上一次运行的完成事件
  job.logSince = formatLogTime(now() - 2000);   // 用可注入的 now()，测试里才能用虚拟时钟
  log(`${path.basename(cfg.maaPath)} 已启动（PID ${job.maaPid ?? '?'}，${job.maaDeElevated ? '已降权到普通权限' : '管理员权限'}），开始盯 ${offsets.size} 个日志文件${job.expectedTaskCount ? `（本实例 ${job.expectedTaskCount} 个任务）` : ''}`);

  if (cfg.trigger !== 'auto') {
    await sleep(8000);
    const hk = await sendHotkey(cfg);
    log(hk.ok ? `已发送 Link Start 热键（${cfg.triggerHotkey?.keys ?? ''}）` : `发送热键失败：${hk.error}`);
  }

  // ⑤ 等结果（跑完即停；最长 timeoutSec）—— 计时从 **MAA 启动**开始算：
  // 前面「起客户端 + 等 ADB」花掉的时间不该吃掉任务本身的 30 分钟预算。
  const deadline = now() + cfg.timeoutSec * 1000;
  let verdict = null;
  // 「工具进程不见了」必须**连续确认**才算真退出：Get-Process 偶发失败/返回空会把还活着的
  // MAAEND 判死（2026-09-29 23:00 事故：MAAEND 正跑着任务，被执行器误判退出并掐死）。
  let missStreak = 0;
  let lastGrowthAt = now();
  let lastBeatAt = 0;
  const missConfirmations = Number(cfg.toolMissConfirmations) > 0 ? Number(cfg.toolMissConfirmations) : 3;   // 连续几次看不到才算
  const quietMsBeforeExit = Number(cfg.toolExitQuietSec) >= 0 ? Number(cfg.toolExitQuietSec) * 1000 : 60000;  // 且日志安静多久（0=不要求）
  while (now() < deadline) {
    await sleep(cfg.pollSec * 1000);
    let slice = '';
    // 这可能是一批正在滚动的日志（终末地：maafw.log + 当天的 GUI 日志），逐个文件按 offset 读增量
    for (const file of logFiles(cfg)) {
      try {
        const size = statSize(file);
        if (!offsets.has(file)) {
          // 中途新出现的日志：
          //  · 如果是"轮转过来的旧文件"（maafw.bak.*.log），本次运行的早期事件就在它的**尾部** → 读尾部
          //  · 读进来的行还会按时间戳过滤（只认本次运行之后的），所以不会把上一次运行算进来
          offsets.set(file, Math.max(0, size - 8 * 1024 * 1024));
        } else if (size < offsets.get(file)) {
          // 同一路径的文件变小了 = 被轮转/截断（MAAEND 会把 maafw.log rename 掉再新建，这是实测踩到的坑）
          // → 新内容从 0 开始，必须把偏移量归零，否则 size <= from 会让我们永远读不到东西
          offsets.set(file, 0);
        }
        const from = offsets.get(file);
        if (size <= from) continue;
        const len = Math.min(size - from, 8 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, len, from);
        fs.closeSync(fd);
        offsets.set(file, from + len);
        slice += buf.toString('utf8');
      } catch { /* 读不到就下一轮 */ }
    }
    job.watchedFiles = [...offsets.keys()].map((f) => path.basename(f));
    // 心跳：跑的过程中也把进度落盘（桥接/人看 state 文件就知道跑到哪了，而不是只有结束才有内容）
    if (now() - lastBeatAt > 30000) {
      lastBeatAt = now();
      try {
        fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
        fs.writeFileSync(cfg.stateFile, `${JSON.stringify({ ...job, running: true, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      } catch { /* 写不进去不影响跑 */ }
    }
    if (slice) lastGrowthAt = now();     // 日志还在动 = 工具活着
    if (slice) {
      // 本次实际提交了几个任务（权威值），修正/覆盖配置里数出来的期望值
      const submitted = submittedTaskCount(slice);
      if (submitted.count > 0 && submitted.count !== job.expectedTaskCount) {
        log(`📋 本次实际提交 ${submitted.count} 个任务（配置里算的是 ${job.expectedTaskCount}）→ 按 ${submitted.count} 个算完成`);
        job.expectedTaskCount = submitted.count;
        job.expectedTaskCountBy = submitted.by;
      }
      const c = findCompletion(slice, cfg, job.logSince);
      const ev = countTaskEvents(slice, job.logSince);
      job.successCount += ev.succeeded;
      job.failedCount += ev.failed;
      if (ev.failedNames?.length) job.failedNames = [...new Set([...(job.failedNames ?? []), ...ev.failedNames])];
      job.logTail = tailLines(slice, 8);
      // 框架级错误（工具真的坏了）→ 立刻收手；单个任务失败**不算**，继续让剩下的任务跑
      const fatalHit = (cfg.fatalPatterns ?? []).find((p) => new RegExp(p).test(slice));
      if (fatalHit) { verdict = { ok: false, reason: `工具内部错误（${fatalHit}），已中止` }; break; }
      if (c.allTasksCompleted) {
        job.completionBy = 'marker';
        verdict = { ok: job.failedCount === 0, reason: `日志出现完成标记（${cfg.completionPatterns.join(' / ')}）${job.failedCount ? `；但已有 ${job.failedCount} 个任务失败` : ''}`, tasks: c.finishedTasks };
        break;
      }
      // 本实例所有任务都"有结果"了（成功+失败 ≥ 提交数）→ 收尾
      if (job.expectedTaskCount > 0 && job.successCount + job.failedCount >= job.expectedTaskCount) {
        job.completionBy = 'task-count';
        const settled = job.successCount + job.failedCount;
        verdict = job.failedCount === 0
          ? { ok: true, reason: `${job.successCount}/${job.expectedTaskCount} 个任务全部成功`, tasks: [] }
          : { ok: false, partial: true, reason: `部分完成：${settled}/${job.expectedTaskCount} 个任务有结果（成功 ${job.successCount}、失败 ${job.failedCount}${ev.failedNames?.length ? `，失败的是 ${ev.failedNames.join('、')}` : ''}）`, tasks: [], failedTasks: ev.entries?.failed ?? [], failedNames: ev.failedNames ?? [] };
        break;
      }
    }
    const procs = await listProcesses().catch(() => []);
    if (toolRunning(procs)) {
      missStreak = 0;
      continue;
    }
    missStreak += 1;
    const quietMs = now() - lastGrowthAt;
    if (missStreak < missConfirmations || quietMs < quietMsBeforeExit) {
      job.toolMissStreak = missStreak;
      log(`⋯ 第 ${missStreak} 次没看到 ${cfg.toolProcessNames.join('/')}（日志 ${Math.round(quietMs / 1000)}s 前还在动）→ 再确认，不急着判退出`);
      continue;
    }
    job.toolMissStreak = missStreak;
    // 真退出了：任务数跑够就算成功（MAAEND 跑完可能自己退出/被关）
    if (job.expectedTaskCount > 0 && job.successCount >= job.expectedTaskCount) {
      job.completionBy = 'task-count';
      verdict = { ok: true, reason: `${job.successCount}/${job.expectedTaskCount} 个任务成功（工具已退出）`, tasks: [] };
    } else {
      verdict = { ok: false, reason: `${cfg.toolProcessNames.join('/')} 连续 ${missStreak} 次没看到、且日志安静 ${Math.round(quietMs / 1000)}s，判定为已退出；但没看到完成标记${job.expectedTaskCount ? `（成功 ${job.successCount}/${job.expectedTaskCount}）` : ''}（可能是连接失败/被手动关掉）` };
    }
    break;
  }
  if (verdict) {
    job.finishedTasks = verdict.tasks ?? [];
    // verdict 里的额外信息要落到 job 上（回报措辞会用：partial / failedTasks / failedNames）
    if (verdict.partial) job.partial = true;
    if (Array.isArray(verdict.failedTasks) && verdict.failedTasks.length) job.failedTasks = verdict.failedTasks;
    if (Array.isArray(verdict.failedNames) && verdict.failedNames.length) job.failedNames = verdict.failedNames;
  }

  // ⑤ 收尾
  if (cfg.closeMaa) {
    const procs = await listProcesses().catch(() => []);
    const exes = cfg.toolProcessNames.map((n) => (/\.exe$/i.test(n) ? n : `${n}.exe`));
    if (toolRunning(procs)) {
      const r = await killByName(exes);
      job.closedMaa = r.killed.length > 0;
      log(job.closedMaa ? `已关闭 ${r.killed.join('、')}` : `关闭 ${exes.join('/')} 失败（请手动确认）`);
    } else {
      job.closedMaa = true;
    }
  }
  if (cfg.closeClient) {
    const r = await killByName(cfg.clientProcesses);
    job.clientKilled = r.killed;
    job.closedClient = r.killed.length > 0;
    log(job.closedClient ? `已关闭客户端：${r.killed.join('、')}` : '客户端本来就没在跑（或关闭失败）');
    // 走启动器拉起时，启动器 UI 会一直挂着。留着它影响不大，但**第二天又会撞上"单实例吞参数"**
    // 那条兜底路径（多等一轮 45s）。既然这轮是我们把它拉起来的，就顺手关干净。
    if (cfg.closeLauncher && (cfg.launcherProcessNames ?? []).length) {
      const lr = await killByName(cfg.launcherProcessNames).catch(() => ({ killed: [], failed: [] }));
      job.launcherKilled = lr.killed;
      if (lr.killed.length) log(`已关闭启动器：${lr.killed.join('、')}`);
    }
  }

  // 失败报告里补一句"客户端到底起来没有"，否则群里只看到一句莫名其妙的 MAA 报错
  const clientNote = gameUp ? '' : '；而且游戏客户端一直没起来（看同目录的 -daily.log 里的候选启动记录）';
  job.failedTasks = job.failedTasks ?? [];
  if (verdict) return finish(verdict.ok, verdict.ok ? verdict.reason : verdict.reason + clientNote);
  return finish(false, `等满 ${Math.round(cfg.timeoutSec / 60)} 分钟还没跑完（超时兜底；MAA 自己的 25 分钟卡死超时也该触发过）${clientNote}`);
}

/** 抢运行锁（避免两次请求同时跑）。 */
export function acquireLock(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return { ok: false, pid }; } catch { /* 死锁，继续抢 */ }
    }
  } catch { /* 没锁文件 */ }
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, String(process.pid), 'utf8');
    return { ok: true, pid: process.pid };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 命令行入口：各档案的 wrapper（arknights-daily.mjs / endfield-daily.mjs）调它。
 * 配置读 config.json 的 socialV2.<档案名>，执行细节见 INSTALL_NOTES 16.5。
 */
export function runProfileCli(profileName = 'arknights', argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const profile = args.profile ?? profileName;
  let raw = null;
  try {
    const social = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))?.socialV2 ?? {};
    raw = social[profile] ?? null;
  } catch { /* 用默认值 */ }
  const cfg = mergeConfig(raw, args, REPO_ROOT, profile);
  const log = makeLogger(cfg.logFile, profile);
  const lock = acquireLock(cfg.lockFile);
  if (!lock.ok) {
    log(`[${profile}] 已有一次运行在进行（PID ${lock.pid ?? '?'}），本次退出`);
    process.exit(0);
  }
  runJob(cfg, args)
    .then((job) => {
      try {
        fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
        fs.writeFileSync(cfg.stateFile, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
      } catch (error) { log(`⚠️ 写状态文件失败：${error?.message ?? error}`); }
      log(`[${profile}] 结束：ok=${job.ok} 原因=${job.reason}`);
      try { fs.rmSync(cfg.lockFile, { force: true }); } catch { /* ignore */ }
      process.exit(job.ok ? 0 : 1);
    })
    .catch((error) => {
      log(`[${profile}] 💥 异常：${error?.stack ?? error}`);
      try { fs.rmSync(cfg.lockFile, { force: true }); } catch { /* ignore */ }
      process.exit(1);
    });
}
