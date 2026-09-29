// 把草稿正文提交到桥接的「待审公告」队列（owner 私聊回「通过」/控制台点按钮后才会发布）。
// 用法：node scripts/propose-notice.mjs <正文文件>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('用法：node scripts/propose-notice.mjs <正文文件>'); process.exit(1); }
const content = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const port = Number(cfg.consolePort) || 3100;
let token = String(cfg.consoleToken || '').trim();
if (!token) {
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}
const key = `group:${cfg.allow?.groups?.[0] ?? ''}`;

console.log(`提交公告草稿：${content.length} 字（上限 ${cfg.socialV2?.admin?.announcement?.maxChars ?? 2000}）`);
const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/announcement/propose`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify({ key, content }),
  signal: AbortSignal.timeout(30000)
});
const body = await res.json().catch(() => null);
console.log(`HTTP ${res.status}`);
if (!body?.ok) {
  console.error('❌ 提交失败：', body?.error ?? body);
  process.exit(1);
}
console.log('✅ 已进入待审：id=' + body.pending.id + '，提交时间 ' + new Date(body.pending.createdAt).toLocaleString('zh-CN'));
console.log('与当前公告的差异：', body.diff);
console.log('\n接下来：owner 在私聊里回复「通过」→ 桥接发布；回复「拒绝」→ 作废。控制台「群管理」面板也有按钮。');
