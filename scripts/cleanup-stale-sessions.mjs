#!/usr/bin/env node
// cleanup-stale-sessions.mjs — 清理 qq-bridge 工作区里的“孤儿会话” / 过旧会话
//
// 背景：桥接的 busy 看门狗曾经会把「正在长轮询/生图」的活回合误判为死回合，
// 解绑本地映射却没有真的停掉 DSH 侧的回合；下次唤醒又建一个新会话，
// 于是同一个 QQ 群同时有两个 agent 在跑（互相抢 qq_wait_for_messages 锁、重复发言）。
//
// 这个脚本做一件事：列出 cwd 在 qq-bridge/state/agents 下的根会话，
// 把**不属于** state/sessions.json 里当前映射的那些全部 stopSessionWork + 归档。
//
// 也支持按时间归档（owner 2026-11-27：qq 工作区会话太多，把 10 天以前的收起来）：
//   node scripts/cleanup-stale-sessions.mjs --older-than 10          # 只报告
//   node scripts/cleanup-stale-sessions.mjs --older-than 10 --apply  # 真正归档
// 判定用会话的 updatedAt（最后一次活动），**当前映射的会话永不归档**（防手滑）。
//
// 用法：
//   node scripts/cleanup-stale-sessions.mjs            # 只报告，不改动
//   node scripts/cleanup-stale-sessions.mjs --apply    # 真正停掉并归档
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

// --older-than <天数>：把"最后一次活动早于 N 天前"的会话也纳入归档
const olderIdx = process.argv.findIndex((a) => a === '--older-than' || a.startsWith('--older-than='));
let olderDays = 0;
if (olderIdx >= 0) {
  const raw = process.argv[olderIdx].includes('=')
    ? process.argv[olderIdx].split('=')[1]
    : process.argv[olderIdx + 1];
  const n = Number(String(raw ?? '').replace(/d$/i, ''));
  if (!Number.isFinite(n) || n <= 0) {
    console.error('--older-than 需要一个正数（天），例如 --older-than 10');
    process.exit(2);
  }
  olderDays = n;
}
const cutoff = olderDays > 0 ? Date.now() - olderDays * 86400_000 : 0;

// 已经在"归档"里的会话要跳过：DSH 的归档是**注册表登记**（storages/workspace.json 的
// global.archivedSessionIds），session/list 仍然会列出它们（只是侧边栏不显示）。
// 不跳过的话，第二次跑会把同一批再"归档"一遍，报告也没法看。
function readArchivedIds() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  const file = path.join(home, 'storages', 'workspace.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = j?.global?.archivedSessionIds;
    return Array.isArray(ids) ? new Set(ids) : new Set();
  } catch {
    return null;   // 读不到就退化成"不跳过"（重复归档无害）
  }
}
const archivedIds = readArchivedIds();

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const stateFile = path.join(ROOT, 'state', 'sessions.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { sessions: {} };
const keep = new Set(Object.values(state.sessions ?? {}).filter((v) => typeof v === 'string' && v));

const stateDir = path.join(ROOT, 'state');
const norm = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep)).toLowerCase();
// QQ 会话的 cwd 就是 config.sessionCwd（默认 D:\dsh\qq-bridge）；
// 黑话学习会话的 cwd 在 state/slang-agent 下，绝不能当成孤儿清掉。
const targetCwd = norm(cfg.sessionCwd || ROOT);

const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, { token: cfg.dsh.authToken, cookie: cfg.dsh.authCookie || '' });

console.log(`桥接当前映射（保留）：${keep.size ? [...keep].join(', ') : '（无）'}`);
console.log(`QQ 会话工作目录：${cfg.sessionCwd || ROOT}`);
console.log(`模式：${APPLY ? '应用（会停掉并归档孤儿会话）' : '只报告（加 --apply 才动手）'}\n`);

let list;
try {
  list = unwrap(await api.sessions.list({}), 'session.list');
} catch (error) {
  console.error('❌ 读取会话列表失败：', error?.message ?? error);
  process.exit(1);
}

const all = (list.items ?? []).filter((it) => !it.parentSessionId && !String(it.origin ?? '').includes('subagent'));
const items = all.filter((it) => norm(it.cwd) === targetCwd);
console.log(`DSH 共 ${all.length} 个根会话，其中 ${items.length} 个是 QQ 会话：\n`);

const stale = [];
const fmt = (ms) => new Date(Number(ms ?? 0)).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
let already = 0;
for (const it of items) {
  const at = Number(it.updatedAt ?? it.createdAt ?? 0);
  const inUse = keep.has(it.sessionId);
  const isArchived = archivedIds ? archivedIds.has(it.sessionId) : false;
  const tooOld = cutoff > 0 && at < cutoff;
  if (isArchived) already += 1;
  const hit = !inUse && !isArchived && (olderDays > 0 ? tooOld : true);
  if (hit) stale.push(it);
  const tag = inUse ? '✅ 在用（永不归档）'
    : isArchived ? '📦 已归档（跳过）'
      : hit ? (olderDays > 0 ? `⚠️ 超过 ${olderDays} 天` : '⚠️ 孤儿')
        : '🕒 近期（保留）';
  // 已归档的一般是几百条，只在需要时逐条列（-v 或待归档的才列）
  if (!isArchived || hit) console.log(`  ${tag}  ${it.sessionId}  ${fmt(at)}  ${String(it.title ?? it.name ?? '').slice(0, 40)}`);
}
if (already) console.log(`  … 另有 ${already} 个已归档（注册表里已登记，跳过）`);
for (const it of all.filter((x) => norm(x.cwd) !== targetCwd)) {
  console.log(`  ·  其他（不动）  ${it.sessionId}  cwd=${it.cwd}`);
}

if (!stale.length) {
  console.log('\n没有需要清理的会话。');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\n共 ${stale.length} 个会话待归档。确认无误后加 --apply 执行。`);
  process.exit(0);
}

console.log('');
for (const it of stale) {
  try {
    await api.stopSessionWork(it.sessionId);
    console.log(`🛑 已请求停止回合：${it.sessionId}`);
  } catch (error) {
    console.log(`⚠️ 停止失败 ${it.sessionId}：${error?.message ?? error}`);
  }
  try {
    await api.workspace.archiveSession({ sessionId: it.sessionId });
    console.log(`📦 已归档：${it.sessionId}`);
  } catch (error) {
    console.log(`⚠️ 归档失败 ${it.sessionId}：${error?.message ?? error}`);
  }
}
console.log('\n完成。');
process.exit(0);
