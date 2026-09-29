// 真机禁言验证：对指定 QQ 禁言 N 秒，确认成功后**立即解禁**（默认 60 秒 → 验证完就解开）。
// 用法：node scripts/test-mute-live.mjs <QQ> [秒]
// 只走控制台接口（等同点控制台「手动禁言」按钮），不经过模型。
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
const key = `group:${cfg.allow?.groups?.[0] ?? 123456789}`;
const userId = String(process.argv[2] ?? '').trim();
const seconds = Math.max(60, Number(process.argv[3]) || 60);
if (!/^\d+$/.test(userId)) { console.error('用法：node scripts/test-mute-live.mjs <QQ> [秒]'); process.exit(1); }

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

const before = await api('/api/socialV2/admin-status?key=' + encodeURIComponent(key));
console.log(`群 ${key}｜机器人身份 ${before.body?.botRole}｜干跑=${before.body?.dryRun}｜手动禁言不受干跑影响`);

console.log(`\n① 禁言 ${userId} ${seconds} 秒（最小 60 秒）…`);
const muted = await api('/api/socialV2/mute', { method: 'POST', body: JSON.stringify({ key, userId, minutes: Math.max(1, Math.round(seconds / 60)) }) });
console.log(muted.status, JSON.stringify(muted.body));
if (!muted.body?.ok) {
  console.error('❌ 禁言失败，不再尝试解禁（本来就没禁上）');
  process.exit(1);
}

console.log('\n② 立刻解禁（避免真的影响对方）…');
const unmuted = await api('/api/socialV2/unmute', { method: 'POST', body: JSON.stringify({ key, userId }) });
console.log(unmuted.status, JSON.stringify(unmuted.body));

const after = await api('/api/socialV2/admin-status?key=' + encodeURIComponent(key));
console.log('\n③ 审计记录（最近 4 条）：');
for (const r of (after.body?.recent ?? []).slice(0, 4)) console.log('  ·', r.line);
console.log('\n是否仍在禁言中：', (after.body?.muted ?? []).some((m) => String(m.target).endsWith(`:${userId}`)) ? '⚠️ 是（需要再解禁）' : '否');
process.exit(muted.body?.ok && unmuted.body?.ok ? 0 : 1);
