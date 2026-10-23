// probe-endfield-launch.mjs —— 抓一次「终末地到底是怎么被拉起来的」（只读观察，不启动游戏）
//
// 背景（2026-10-23）：终末地更新后，直接跑 `Endfield.exe` 会被判「不是由启动器拉起」
// （启动器二进制里有 "The game was not launched from the TapTap launcher. Please open the
// game from the launcher"）。要判断"能不能绕过"，先得知道**启动器拉起游戏时到底传了什么**：
// 命令行参数？token 文件？共享内存？——这个探针就把那一刻能观察到的东西全记下来。
//
// 用法：
//   node scripts/probe-endfield-launch.mjs            # 盯 120 秒，等 Endfield.exe 出现
//   node scripts/probe-endfield-launch.mjs --sec 300  # 盯更久
//
// 输出：控制台 + state/endfield-launch-capture.json（含两次快照差异）
//   1) Endfield.exe 的 PID / 父 PID / **完整命令行**；
//   2) 父进程是谁、它的命令行（通常是 Launcher.exe 或 PlatformProcess.exe）；
//   3) 游戏目录里在观察窗口内**新增/改动**的文件（token 文件类的线索）；
//   4) U8 SDK 的几个会话文件（sdk_data.dat / sdid_s 等）的大小与修改时间。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const secIdx = argv.indexOf('--sec');
const SEC = secIdx >= 0 ? Math.max(5, Number(argv[secIdx + 1]) || 120) : 120;
const GAME_DIR = 'G:\\Hypergryph Launcher\\games\\Endfield Game';
const OUT = path.join(ROOT, 'state', 'endfield-launch-capture.json');

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}

function procs() {
  const raw = ps("Get-CimInstance Win32_Process -Filter \"Name='Endfield.exe' or Name='Launcher.exe' or Name='Games.exe' or Name='PlatformProcess.exe' or Name='MaaEnd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress");
  if (!raw) return [];
  try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [j]; } catch { return []; }
}

function snapshot(dir) {
  const out = {};
  const walk = (d, depth) => {
    if (depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      try { const st = fs.statSync(p); out[path.relative(dir, p)] = { size: st.size, mtime: st.mtimeMs }; } catch { /* 忽略 */ }
    }
  };
  walk(dir, 0);
  return out;
}

console.log(`盯 ${SEC} 秒，等 Endfield.exe 出现…（现在就先在启动器里点一次「开始游戏」）`);
const before = snapshot(GAME_DIR);
const started = Date.now();
let hit = null;
while (Date.now() - started < SEC * 1000) {
  const list = procs();
  const game = list.find((p) => p.Name === 'Endfield.exe');
  if (game) {
    hit = { game, all: list };
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}

if (!hit) {
  console.log(`\n❌ ${SEC} 秒内没看到 Endfield.exe。`);
  const list = procs();
  console.log('   当前相关进程：' + (list.map((p) => `${p.Name}#${p.ProcessId}`).join(', ') || '（无）'));
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 3000));   // 让启动器把该写的写下去
const after = snapshot(GAME_DIR);
const changed = [];
for (const [rel, st] of Object.entries(after)) {
  const b = before[rel];
  if (!b) changed.push({ rel, kind: '新增', size: st.size, mtime: new Date(st.mtime).toLocaleString('zh-CN') });
  else if (b.size !== st.size || Math.abs(b.mtime - st.mtime) > 500) changed.push({ rel, kind: '改动', size: st.size, mtime: new Date(st.mtime).toLocaleString('zh-CN') });
}

const parent = (() => {
  const p = hit.all.find((x) => x.ProcessId === hit.game.ParentProcessId);
  return p ? { name: p.Name, pid: p.ProcessId, cmd: p.CommandLine ?? '' } : null;
})();

const capture = {
  capturedAt: new Date().toISOString(),
  game: {
    pid: hit.game.ProcessId,
    ppid: hit.game.ParentProcessId,
    cmd: hit.game.CommandLine ?? '',
    createdAt: hit.game.CreationDate,
  },
  parent,
  related: hit.all.map((p) => ({ name: p.Name, pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine ?? '' })),
  changedFiles: changed,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(capture, null, 2), 'utf8');

console.log('\n✅ 抓到了');
console.log(`   Endfield.exe  PID=${capture.game.pid}  父 PID=${capture.game.ppid}`);
console.log(`   命令行: ${capture.game.cmd || '（空——没有参数！）'}`);
console.log(`   父进程: ${parent ? `${parent.name}#${parent.pid}` : '（已退出/查不到）'}`);
if (parent?.cmd) console.log(`   父进程命令行: ${parent.cmd}`);
console.log(`   启动窗口内新增/改动的文件: ${changed.length} 个`);
for (const c of changed.slice(0, 12)) console.log(`     ${c.kind}  ${c.rel}  ${c.size}B  ${c.mtime}`);
console.log(`\n已写入 ${path.relative(ROOT, OUT)}`);
