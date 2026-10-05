// 探针：核对 docs/FOLDER_MAP.md 里那些"数字/清单"是否还成立。
// 只读。用法：node scripts/probe-foldermap-facts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => spawnSync('git', String(args).split(/\s+/).filter(Boolean), { cwd: ROOT, encoding: 'utf8' }).stdout || '';
const lines = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).length;

console.log('① bridge.js 行数');
console.log(`   文档写：约 10,400 行   实际：${lines('src/bridge.js')} 行`);

console.log('\n② scripts/ 文件数与扩展名构成（git 跟踪）');
const scripts = git('ls-files scripts').split('\n').map((s) => s.trim()).filter(Boolean);
const byExt = {};
for (const f of scripts) { const e = path.extname(f).toLowerCase() || '(无扩展名)'; byExt[e] = (byExt[e] || 0) + 1; }
console.log(`   文档写：共 170 个（167 .mjs + 3 JSON）   实际：共 ${scripts.length} 个`);
console.log('   ' + Object.entries(byExt).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join('　'));
const ps1 = scripts.filter((f) => f.endsWith('.ps1'));
console.log(`   .ps1 文件（文档里没有这个类别）：${ps1.length} 个 —— ` + ps1.map((f) => path.basename(f)).join(', '));

console.log('\n③ docs/ 实际子目录');
const docsDirs = fs.readdirSync(path.join(ROOT, 'docs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const docsRootMd = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
console.log(`   文档写：guides/ design/ research/ audits/ legacy/`);
console.log(`   实际子目录：${docsDirs.join(', ') || '(无)'}`);
console.log(`   docs/ 根级 md（${docsRootMd.length} 个）：${docsRootMd.join(', ')}`);

console.log('\n④ dsh/ 与 ⑤ plugins/ 实际内容');
console.log('   dsh/     ：' + fs.readdirSync(path.join(ROOT, 'dsh')).filter((n) => !n.startsWith('.')).join(', '));
console.log('   plugins/ ：' + fs.readdirSync(path.join(ROOT, 'plugins')).filter((n) => !n.startsWith('.')).join(', '));

console.log('\n⑥⑦ 工作区根（仓库的上一级）实际有什么');
const WS = path.resolve(ROOT, '..');
const items = fs.readdirSync(WS).filter((n) => !n.startsWith('.'));
console.log(`   共 ${items.length} 项；文档的目录树只画了 4 项`);
console.log('   voice-tool/ 是否存在：' + (fs.existsSync(path.join(WS, 'voice-tool')) ? '存在' : '**不存在**'));
console.log('   两个启动器是否存在：'
  + ['发语音-图形界面.cmd', '重启DSH-加载语音工具.cmd'].map((n) => `${n}=${fs.existsSync(path.join(WS, n)) ? '有' : '无'}`).join('  '));
console.log('   目录：' + items.filter((n) => fs.statSync(path.join(WS, n)).isDirectory()).join(', '));
console.log('   文件（前 20）：' + items.filter((n) => fs.statSync(path.join(WS, n)).isFile()).slice(0, 20).join(', '));
