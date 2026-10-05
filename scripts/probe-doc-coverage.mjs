// 探针：现有文档对"每个文件的作用"覆盖到什么程度？
//   · 统计仓库里被跟踪的文件总数；
//   · 看 docs/FOLDER_MAP.md 与 docs/README.md 里分别"点名"了多少个文件（按 basename 匹配）；
//   · 按目录给覆盖情况，指出哪些目录完全没有逐文件说明。
// 只读。用法：node scripts/probe-doc-coverage.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
const files = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => !f.startsWith('node_modules/'));

const docs = {
  'docs/FOLDER_MAP.md': fs.readFileSync(path.join(ROOT, 'docs', 'FOLDER_MAP.md'), 'utf8'),
  'docs/README.md': fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8'),
};
const allDocs = Object.values(docs).join('\n') + '\n' + fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  + '\n' + fs.readFileSync(path.join(ROOT, 'INSTALL_NOTES.md'), 'utf8');

const named = (text, f) => text.includes(path.basename(f));
const byDir = new Map();
for (const f of files) {
  const dir = path.dirname(f) === '.' ? '(仓库根)' : path.dirname(f).split('/')[0];
  const e = byDir.get(dir) ?? { total: 0, inMap: 0, inDocs: 0 };
  e.total++;
  if (named(docs['docs/FOLDER_MAP.md'], f)) e.inMap++;
  if (named(allDocs, f)) e.inDocs++;
  byDir.set(dir, e);
}

console.log(`被跟踪文件总数: ${files.length}\n`);
console.log('目录'.padEnd(22) + '文件数   FOLDER_MAP 点名   任意文档点名（宽松）');
console.log('─'.repeat(78));
for (const [dir, e] of [...byDir].sort((a, b) => b[1].total - a[1].total)) {
  console.log(dir.padEnd(22) + String(e.total).padStart(5) + String(e.inMap).padStart(13) + String(e.inDocs).padStart(18));
}
const tot = { total: files.length, inMap: 0, inDocs: 0 };
for (const e of byDir.values()) { tot.inMap += e.inMap; tot.inDocs += e.inDocs; }
console.log('─'.repeat(78));
console.log('合计'.padEnd(22) + String(tot.total).padStart(5) + String(tot.inMap).padStart(13) + String(tot.inDocs).padStart(18));
console.log(`\nFOLDER_MAP 逐文件点名率: ${(tot.inMap / tot.total * 100).toFixed(1)}%`
  + `　任意文档（含提交说明式记录）宽泛提及率: ${(tot.inDocs / tot.total * 100).toFixed(1)}%`);
const neverMentioned = files.filter((f) => !named(allDocs, f));
console.log(`\n在任何文档/记录里都找不到名字的文件: ${neverMentioned.length} 个，例如：`);
for (const f of neverMentioned.slice(0, 15)) console.log('  · ' + f);
