// 只读：打印当前群公告全文（含所有历史公告的标题/时间），供改写参考。
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
const groupId = String(cfg.allow?.groups?.[0] ?? '');

const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/announcement?groupId=${groupId}`, {
  headers: { 'x-console-token': token },
  signal: AbortSignal.timeout(20000)
});
const body = await res.json();
console.log(`群 ${groupId}｜公告 ${body.current?.count ?? 0} 条｜最新一条 ${body.current?.publishTime ? new Date(body.current.publishTime * 1000).toLocaleString('zh-CN') : '无'}`);
console.log('\n===== 现行公告全文（' + String(body.current?.text ?? '').length + ' 字）=====\n');
console.log(body.current?.text ?? '(无)');
console.log('\n===== 待审草稿 =====');
console.log(body.pending ? body.pending.content : '(无)');
