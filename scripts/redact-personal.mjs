// 发布前脱敏：把真实群号/QQ/昵称/本机用户名替换成占位符。
//
// 用法：
//   node scripts/redact-personal.mjs --dry      # 只报告会改什么（默认）
//   node scripts/redact-personal.mjs --apply    # 真正写入
//
// 设计：
// - 映射表放在 state/personal-ids.json（state/ 已被 .gitignore 忽略，映射本身不会被提交）；
//   也可以由本脚本在第一次运行时按内置清单生成。
// - 只处理"会被提交的文本文件"（git status 里的 modified/untracked，且未被 .gitignore 忽略），
//   外加 README/NOTICE/docs 等文档；不碰 node_modules、state/、二进制文件。
// - 逐条替换并统计，输出每个文件改了多少处，方便复核。
// 【重要】本脚本**不含**任何真实 ID：映射表必须放在 state/personal-ids.json
// （state/ 已被 .gitignore 忽略），否则映射本身就把要藏的东西公开了。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_FILE = path.join(ROOT, 'state', 'personal-ids.json');
const APPLY = process.argv.includes('--apply');

const TEMPLATE = {
  '_说明': '把真实值替换成占位符；这个文件在 state/ 下，不会进版本库',
  '真实群号': '占位群号',
  '真实ownerQQ': '占位QQ',
  '真实机器人QQ': '占位QQ',
  'C:\\\\Users\\\\真实用户名': 'C:\\\\Users\\\\<you>',
  '真实群名片': '群友A'
};

function loadMap() {
  if (!fs.existsSync(MAP_FILE)) {
    console.error(`缺少映射表：${MAP_FILE}`);
    console.error('请照着下面这个形状填（key=真实值，value=占位符），然后再跑：\n');
    console.error(JSON.stringify(TEMPLATE, null, 2));
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8').replace(/^\uFEFF/, ''));
  const map = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_说明') continue;
    if (!k || typeof v !== 'string' || !v) continue;
    map[k] = v;
  }
  if (!Object.keys(map).length) { console.error('映射表是空的'); process.exit(2); }
  return map;
}

function gitTolerant(args, input) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return String(error?.stdout ?? '');
  }
}

function candidateFiles() {
  const porcelain = gitTolerant(['status', '--porcelain', '-z']).split('\0').filter(Boolean);
  const list = [];
  for (const entry of porcelain) {
    if (entry.length < 4) continue;
    const rest = entry.slice(3);
    const file = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
    if (file) list.push(file);
  }
  const ignored = new Set(gitTolerant(['check-ignore', '--stdin', '-z'], list.join('\0') + '\0').split('\0').map((s) => s.trim()).filter(Boolean));
  return list.filter((f) => !ignored.has(f));
}

const map = loadMap();
if (!fs.existsSync(MAP_FILE)) {
  try {
    fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
  } catch { /* 写不了就算了 */ }
}

// 长 key 优先替换（避免长昵称被它的前缀抢先匹配掉）
const keys = Object.keys(map).sort((a, b) => b.length - a.length);
const files = candidateFiles();
let totalHits = 0;
const perFile = [];

for (const file of files) {
  const abs = path.join(ROOT, file);
  let text;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
    text = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  if (text.includes('\u0000')) continue;

  let next = text;
  const hits = [];
  for (const key of keys) {
    if (!next.includes(key)) continue;
    const count = next.split(key).length - 1;
    hits.push(`${key}→${map[key]}×${count}`);
    next = next.split(key).join(map[key]);
  }
  if (!hits.length) continue;
  totalHits += hits.length;
  perFile.push({ file, hits });
  if (APPLY) fs.writeFileSync(abs, next, 'utf8');
}

console.log(`${APPLY ? '【已写入】' : '【干跑】'}待处理文件 ${files.length} 个；命中 ${perFile.length} 个文件、共 ${totalHits} 类替换`);
for (const { file, hits } of perFile) {
  console.log(`  ${file}`);
  for (const h of hits) console.log(`      ${h}`);
}
if (!APPLY) console.log('\n确认无误后执行：node scripts/redact-personal.mjs --apply');
console.log(`\n映射表：${path.relative(ROOT, MAP_FILE)}（在 .gitignore 的 state/ 下，不会被提交）`);
