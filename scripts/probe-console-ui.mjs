// 控制台 UI 体检：确认「我们本地的面板」确实在**桥接实际发出的页面**里，并报告它们所在的
// 折叠分组是否默认展开；可选地与某个 git 版本做元素 id 对比，看合并有没有弄丢本地 UI。
//
// 用法：
//   node scripts/probe-console-ui.mjs                       # 只查当前服务的页面
//   node scripts/probe-console-ui.mjs --diff 19364e9:public/console.html
//
// 背景：上游 v0.1.7 把控制台设置项改成可折叠的 <details class="settings-group">，默认只展开
// 第一组。我们的 memes / 群管理面板因此"看着像没了"——这个脚本就是为了以后一眼看清状态。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const token = cfg.consoleToken || (() => { try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; } })();
const base = `http://127.0.0.1:${Number(cfg.consolePort) || 3100}`;

// 本副本相对上游新增/改动的控制台元素与端点；缺任何一个都说明更新没带上。
const OURS = [
  'v2MemesEnabled', 'v2MemesPackDirs', 'v2MemesProbe', 'v2MemesTestSend',
  'v2AdminEnabled', 'v2AdminDryRun', 'v2AdminLoad', 'v2AdminMuteBtn', 'v2AdminNoticeApprove',
  'data-v2-tool="sendMeme"', 'data-v2-tool="adminInfo"', 'data-v2-tool="requestMute"', 'data-v2-tool="proposeAnnouncement"',
  '/api/socialV2/meme-probe', '/api/socialV2/admin-status',
];

let failed = 0;
const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`);
const html = await res.text();
console.log(`桥接控制台 ${base} → HTTP ${res.status}，页面 ${html.length} 字符\n`);

console.log('=== 我们的控制台元素 ===');
for (const k of OURS) {
  const n = html.split(k).length - 1;
  if (!n) failed++;
  console.log(`${n ? '✅' : '❌'} ${k} × ${n}`);
}

console.log('\n=== 折叠分组状态 ===');
const tags = html.match(/<details[^>]*>/g) || [];
console.log(`details 共 ${tags.length} 个，默认展开 ${tags.filter((s) => /\bopen\b/.test(s)).length} 个`);
const anchor = html.indexOf('本地表情包库与群管理');
if (anchor < 0) {
  console.log('❌ 没找到「本地表情包库与群管理」分组标题');
  failed++;
} else {
  const lastOpen = html.lastIndexOf('<details', anchor);
  const tag = html.slice(lastOpen, html.indexOf('>', lastOpen) + 1);
  const isOpen = /\bopen\b/.test(tag);
  console.log(`${isOpen ? '✅' : '❌'} 我们的面板所在分组：${tag}${isOpen ? '（默认展开）' : '（默认折叠 → 用户会以为"没有我们的更新"）'}`);
  if (!isOpen) failed++;
}

const diffSpec = process.argv.includes('--diff') ? process.argv[process.argv.indexOf('--diff') + 1] : null;
if (diffSpec) {
  const pre = execFileSync('git', ['show', diffSpec], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ids = (s) => new Set([...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const preIds = ids(pre);
  const curIds = ids(html);
  const lost = [...preIds].filter((id) => !curIds.has(id));
  console.log(`\n=== 与 ${diffSpec} 的元素 id 对比 ===`);
  console.log(`合并前 ${preIds.size} 个 / 现在 ${curIds.size} 个；丢失 ${lost.length} 个`);
  for (const id of lost) console.log('  - ' + id);
  if (lost.length) failed++;
}

console.log(`\n${failed ? '❌ ' + failed + ' 项不通过' : '✅ 控制台已带上本副本的全部本地 UI'}`);
process.exit(failed ? 1 : 0);
