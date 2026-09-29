// 发布前体检：把"将要提交的文件"里可能泄漏的内容扫一遍（不会修改任何东西）。
// 用法：node scripts/preflight-publish.mjs
//
// 检查项：
//   1) git 真正会提交的文件清单（modified + untracked，且未被 .gitignore 忽略）；
//   2) 从 config.json 读出真实凭据值，逐个在待提交文件里搜；
//   3) 通用敏感形态：dsh-auth-* cookie、tvly-* key、afdian token、OneBot token、
//      本机用户名/路径、QQ 号（群号/owner/bot）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args, input) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
// check-ignore 在"没有任何路径被忽略"时退出码是 1，不是错误 —— 这里容忍它。
const runTolerant = (args, input) => {
  try { return run(args, input); } catch (error) { return String(error?.stdout ?? ''); }
};

// 1) 待提交文件（用 -z 拿 NUL 分隔的原始路径，避免中文/空格被 git 加引号转义）
const porcelain = run(['status', '--porcelain', '-z']).split('\0').filter(Boolean);
const candidates = [];
for (const entry of porcelain) {
  if (entry.length < 4) continue;
  const rest = entry.slice(3);
  // 重命名条目格式： "R  old\0new" —— -z 下 old/new 分处两条记录，这里只取新路径
  const file = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
  if (file) candidates.push(file);
}
let filesToCommit = [];
if (candidates.length) {
  const ignored = new Set(
    runTolerant(['check-ignore', '--stdin', '-z'], candidates.join('\0') + '\0')
      .split('\0').map((s) => s.trim()).filter(Boolean)
  );
  filesToCommit = candidates.filter((f) => !ignored.has(f));
}

// 2) 真实凭据（从 config.json 读，文件本身已被 gitignore）
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
} catch { /* 没有 config.json 就只跑通用形态 */ }
const literalSecrets = [
  ['afdian token', cfg?.socialV2?.feed?.afdian?.token],
  ['afdian user_id', cfg?.socialV2?.feed?.afdian?.userId],
  ['Tavily key', cfg?.webSearch?.tavilyApiKey],
  ['OneBot token', cfg?.snowluma?.accessToken],
  ['OneBot http token', cfg?.snowluma?.httpToken],
  ['console token', cfg?.consoleToken],
  ['DSH authCookie', cfg?.dsh?.authCookie]
].filter(([, v]) => v && String(v).trim().length >= 6);

const patterns = literalSecrets.map(([label, value]) => ({ label, re: new RegExp(escapeRe(String(value)), 'g'), secret: true }));
patterns.push(
  { label: 'dsh-auth cookie', re: /dsh-auth-[A-Za-z0-9_=-]{10,}/g, secret: true },
  { label: 'Tavily key 形态', re: /tvly-[a-z0-9-]{10,}/gi, secret: true },
  { label: 'bearer/authorization 明文', re: /["']?(?:authorization|bearer)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]{20,}/gi, secret: true },
  { label: '本机用户名', re: /\\Users\\[^\\/\s"']+|\/Users\/[^/\s"']+/g, secret: false },
  { label: 'QQ 号（9~11 位）', re: /(?<![\d.])\d{9,11}(?![\d.])/g, secret: false }
);

// 脱敏后使用的占位符：报告里自动忽略，避免"自己吓自己"
const PLACEHOLDERS = new Set([
  '123456789', '987654321', '1234567890', '9876543210', '541234567', '2147483647', '1765206550',
  '100000001', '100000002',
  '200000001', '200000002', '200000003', '200000004', '200000005',
  '200000006', '200000007', '200000008', '200000009', '200000010'
]);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const report = [];
for (const file of filesToCommit) {
  const abs = path.join(ROOT, file);
  let text;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    text = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  if (text.includes('\u0000')) continue; // 二进制
  for (const { label, re, secret } of patterns) {
    re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (PLACEHOLDERS.has(value) || /<you>/.test(value)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ line, sample: value.slice(0, 60) });
      if (hits.length >= 5) break;
    }
    if (hits.length) report.push({ file, label, secret, hits });
  }
}

console.log(`待提交文件：${filesToCommit.length} 个（另有 ${candidates.length - filesToCommit.length} 个被 .gitignore 忽略）`);
const secretHits = report.filter((r) => r.secret);
const softHits = report.filter((r) => !r.secret);

if (secretHits.length) {
  console.log('\n❌ 真的凭据命中（必须先处理）：');
  for (const r of secretHits) {
    console.log(`  ${r.file} — ${r.label}`);
    for (const h of r.hits) console.log(`      L${h.line}: ${h.sample}`);
  }
} else {
  console.log('\n✅ 没发现真实凭据泄漏到待提交文件里');
}

if (softHits.length) {
  console.log('\n⚠️ 个人信息类（自己判断要不要公开）：');
  const grouped = new Map();
  for (const r of softHits) {
    const key = `${r.file} — ${r.label}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(...r.hits);
  }
  for (const [key, hits] of grouped) {
    const uniq = [...new Set(hits.map((h) => h.sample))].slice(0, 6);
    console.log(`  ${key}：${uniq.join(', ')}${hits.length > uniq.length ? ` …共 ${hits.length} 处` : ''}`);
  }
} else {
  console.log('\n✅ 没有本机路径/QQ 号等个人信息');
}

console.log('\n提示：config.json 与 state/ 已在 .gitignore 里，历史上也从未提交过（可用 git log --all -- config.json 自查）。');
process.exit(secretHits.length ? 1 : 0);
