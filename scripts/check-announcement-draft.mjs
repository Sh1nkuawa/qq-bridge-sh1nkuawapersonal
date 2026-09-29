// 提交前本地校验：公告正文是否过得了桥接的 validateAnnouncement（长度/链接/@全体/敏感特征）。
// 用法：node scripts/check-announcement-draft.mjs state/_announcement-voice.txt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAnnouncement, summarizeNoticeDiff } from '../src/moderation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
if (!file) { console.error('用法: node scripts/check-announcement-draft.mjs <草稿文件>'); process.exit(2); }

const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).socialV2?.admin;
const r = validateAnnouncement(text, cfg);

console.log(`字符数    : ${String(r.text).length} / 上限 ${cfg?.announcement?.maxChars ?? 600}`);
console.log(`UTF-8 字节: ${Buffer.byteLength(r.text, 'utf8')} / 上限 ${cfg?.announcement?.maxBytes ?? 1400}`);
console.log(`校验      : ${r.ok ? '✅ 通过' : '❌ 失败'}`);
if (!r.ok) for (const e of r.errors) console.log('  - ' + e);

let current = '';
try { current = fs.readFileSync(path.join(ROOT, '群公告.md'), 'utf8'); } catch { /* 没有旧公告 */ }
console.log(`与上一版公告差异：${summarizeNoticeDiff(current, r.text)}`);
console.log('\n---- 规范化后的正文 ----\n' + r.text);
process.exit(r.ok ? 0 : 1);
