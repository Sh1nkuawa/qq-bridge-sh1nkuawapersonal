// 看一眼群里当前公告正文（走桥接控制台 API，只读）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const token = cfg.consoleToken || fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const port = Number(cfg.consolePort) || 3100;
const gid = (cfg.allow?.groups ?? [])[0];

const r = await fetch(`http://127.0.0.1:${port}/api/socialV2/admin-status?key=group:${gid}`, {
  headers: { 'x-console-token': token },
  signal: AbortSignal.timeout(20000),
});
const d = await r.json().catch(() => null);
console.log('HTTP ' + r.status);
console.log('机器人身份: ' + (d?.botRole ?? d?.role ?? '?'));
const notice = d?.notice?.text ?? d?.currentNotice ?? d?.noticeText ?? '';
console.log(`当前公告（${String(notice).length} 字）:`);
console.log(notice ? notice : '(接口没返回正文，字段：' + Object.keys(d ?? {}).join(',') + ')');
console.log('待审草稿: ' + (d?.pending ? JSON.stringify(d.pending).slice(0, 150) : '无'));
