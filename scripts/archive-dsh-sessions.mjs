// 归档 DSH 会话：把不再使用的会话目录搬到 ~/.dsh/sessions-archive/ 下（**可逆**，不删任何东西）。
//
// 背景（2026-10-12）：DSH 本身没有"归档会话"功能（dsh-web-app / dsh-session / 会话 UI 包里
// 都搜不到 archive），而 qq-bridge 每清一次上下文就新开一个 DSH 会话 → 攒到 400+，把工作区
// 列表撑满了。会话在磁盘上是 `~/.dsh/sessions/<工作区 slug>/session-<uuid>/`（里面是
// session.jsonl.zstd 等），**没有中央索引文件**，所以"搬走目录"就等于"从界面里归档" ✓。
//
// 用法：
//   node scripts/archive-dsh-sessions.mjs                    # 只预览（默认，不动任何文件）
//   node scripts/archive-dsh-sessions.mjs --apply            # 真正搬走
//   node scripts/archive-dsh-sessions.mjs --keep-days 14     # 保留最近 14 天（默认 7）
//   node scripts/archive-dsh-sessions.mjs --only <slug>      # 只处理某个工作区
//   node scripts/archive-dsh-sessions.mjs --restore <manifest.json>   # 按清单还原
//
// 三条保护（永不触碰）：
//   ① qq-bridge/state/sessions.json 里记着的会话 id —— 桥接随时可能 resume 它们
//   ② 最近 keep-days 天内有更新的会话
//   ③ 工作区目录里非 `session-*` 的条目（可能是 DSH 自己的工作区元数据）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const ARCHIVE = path.join(DSH_HOME, 'sessions-archive');
const BRIDGE_STATE = path.join(ROOT, 'state', 'sessions.json');

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const apply = argv.includes('--apply');
const keepDays = Number(arg('keep-days', '7')) || 7;
const only = arg('only', '');
const restoreFrom = arg('restore', '');

/** 目录里最新的文件时间（用文件更准：搬动目录本身会改 mtime） */
function latestMtime(dir) {
  let newest = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else newest = Math.max(newest, fs.statSync(q).mtimeMs);
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return newest || fs.statSync(dir).mtimeMs;
}

function dirSize(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(q) : fs.statSync(q).size;
  }
  return n;
}

/** 桥接记着的会话 id（递归找 session-* 字符串） */
function protectedIds() {
  const ids = new Set();
  try {
    const text = fs.readFileSync(BRIDGE_STATE, 'utf8').replace(/^\uFEFF/, '');
    for (const m of text.matchAll(/session-[0-9a-f-]{8,}/g)) ids.add(m[0]);
  } catch { /* 读不到就当没有：下面还有 keep-days 兜底 */ }
  return ids;
}

// ── 还原模式 ────────────────────────────────────────────────────────────────
if (restoreFrom) {
  const manifest = JSON.parse(fs.readFileSync(restoreFrom, 'utf8'));
  let back = 0, skipped = 0;
  for (const e of manifest.moved ?? []) {
    if (!fs.existsSync(e.to)) { skipped++; continue; }
    if (fs.existsSync(e.from)) { skipped++; continue; }
    fs.mkdirSync(path.dirname(e.from), { recursive: true });
    fs.renameSync(e.to, e.from);
    back++;
  }
  console.log(`还原完成：搬回 ${back} 个，跳过 ${skipped} 个（目标已存在或归档文件不在）`);
  process.exit(0);
}

// ── 扫描 ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(SESSIONS)) {
  console.error(`找不到会话目录：${SESSIONS}`);
  process.exit(1);
}
const protectedSet = protectedIds();
const cutoff = Date.now() - keepDays * 86400000;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const moved = [];
const kept = { inUse: 0, recent: 0 };
console.log(`会话目录：${SESSIONS}`);
console.log(`归档目录：${ARCHIVE}`);
console.log(`保留最近 ${keepDays} 天；桥接记着的会话 ${protectedSet.size} 个`);
console.log(`模式：${apply ? '★ 真搬（--apply）' : '只预览（加 --apply 才动手）'}\n`);

for (const ws of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue;
  if (only && ws.name !== only) continue;
  const wsDir = path.join(SESSIONS, ws.name);
  let movedHere = 0, bytesHere = 0;
  for (const e of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!/^session-/.test(e.name)) continue;                     // 保护③
    const src = path.join(wsDir, e.name);
    if (protectedSet.has(e.name)) { kept.inUse++; continue; }     // 保护①
    const mtime = latestMtime(src);
    if (mtime >= cutoff) { kept.recent++; continue; }             // 保护②
    const dest = path.join(ARCHIVE, stamp.slice(0, 7), ws.name, e.name);
    const bytes = dirSize(src);
    moved.push({ id: e.name, ws: ws.name, from: src, to: dest, mtime: new Date(mtime).toISOString(), bytes });
    movedHere++; bytesHere += bytes;
    if (apply) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(src, dest);
    }
  }
  if (movedHere) console.log(`  ${ws.name.padEnd(44)} ${String(movedHere).padStart(4)} 个  ${(bytesHere / 1048576).toFixed(1)} MB`);
}

const totalBytes = moved.reduce((n, m) => n + m.bytes, 0);
console.log(`\n可归档：${moved.length} 个会话、${(totalBytes / 1048576).toFixed(1)} MB`);
console.log(`保留：桥接在用 ${kept.inUse} 个、最近 ${keepDays} 天 ${kept.recent} 个`);

if (apply && moved.length) {
  const manifest = path.join(ARCHIVE, `manifest-${stamp}.json`);
  fs.mkdirSync(ARCHIVE, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ archivedAt: new Date().toISOString(), keepDays, moved }, null, 2), 'utf8');
  console.log(`\n已归档 ✓ 清单：${manifest}`);
  console.log(`想还原：node scripts/archive-dsh-sessions.mjs --restore "${manifest}"`);
} else if (!apply && moved.length) {
  console.log('\n（预览模式，什么都没动。确认后加 --apply 执行）');
}
