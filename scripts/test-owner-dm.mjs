// 验证「owner 私聊命令」链路（用控制台模拟器，不需要 owner 真的发消息）。
// 用法：node scripts/test-owner-dm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const port = Number(cfg.consolePort) || 3100;
let token = String(cfg.consoleToken || '').trim();
if (!token) {
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
async function api(pathname, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-console-token': token, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30000)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const simulate = async (text) => (await api('/api/socialV2/owner-dm-simulate', { method: 'POST', body: JSON.stringify({ text }) })).body;

console.log('## owner 私聊命令接管（白名单之前）');
const chatter = await simulate('在吗');
ok('普通私聊内容不被接管（照旧走白名单/会话逻辑）', chatter?.handled === false, chatter?.note ?? '');
const cmd = await simulate('/公告');
ok('/公告 被接管（私聊也能查公告）', cmd?.handled === true, `pending ${cmd?.pendingBefore} → ${cmd?.pendingAfter}`);
const rec = await simulate('/禁言记录 3');
ok('/禁言记录 被接管', rec?.handled === true);

console.log('## 审批词处理');
const before = await api('/api/socialV2/announcement');
const pendingId = before.body?.pending?.id ?? null;
if (!pendingId) {
  const noPending = await simulate('通过');
  ok('没有待审草稿时"通过"被接管但不发布', noPending?.handled === true && noPending?.pendingAfter === null, noPending?.note ?? '');
} else {
  const approve = await simulate('通过');
  ok('"通过"被接管并触发发布', approve?.handled === true, `${pendingId} → ${approve?.pendingAfter}`);
  const log = await api('/api/socialV2/moderation-log?limit=5');
  const last = (log.body?.records ?? []).find((r) => r.action === 'announce');
  ok('审计里有发布记录', Boolean(last), last ? `${last.ok ? '成功' : '失败：' + last.error}` : '');
  if (last?.ok) {
    ok('发布成功后待审草稿被消费', approve?.pendingAfter === null);
  } else {
    // 发布失败（例如内容超长）时**刻意保留**草稿，方便改完重发
    ok('发布失败时保留草稿（设计如此）', approve?.pendingAfter === pendingId);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
