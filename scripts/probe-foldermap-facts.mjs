// probe-foldermap-facts.mjs —— docs/FOLDER_MAP.md 的**人读版**事实核对表（只读）。
//
// 用途：把 `test-foldermap-facts.mjs` 断言的那些结构性事实打印成"文档写什么 / 实际多少"的对照，
// 用于手工体检、写报告、或改文档前先看一眼现状。
//
// 特别提醒"行数"的口径陷阱（2026-10-05 真的为此吵过一轮）：
//   · 总行数（`wc -l` / `\n` 个数）—— FILE_INDEX.md 的「行数」列用的是这个；
//   · 非空行（PowerShell `Get-Content … | Measure-Object -Line`）—— 会小几百行，差的全是空行。
//   两个数都"真"，但对不上；所以本脚本把两种口径都打出来，避免又把定义不同当成算错。
//
// 用法：node scripts/probe-foldermap-facts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = path.resolve(ROOT, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'FOLDER_MAP.md'), 'utf8');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (rel) => fs.existsSync(path.join(ROOT, rel));
const ls = (rel) => fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name).sort();

console.log('① 行数口径（本文已不再写行数；这里是体检用）');
const raw = read('src/bridge.js');
const total = (raw.match(/\n/g) || []).length;
const nonBlank = raw.split(/\r?\n/).filter((l) => l.trim() !== '').length;
console.log(`   src/bridge.js  总行（wc -l / FILE_INDEX 口径）: ${total}`);
console.log(`                  非空行（PowerShell Measure-Object 口径）: ${nonBlank}`);
console.log(`                  空行: ${total - nonBlank}  ← 两个数差的就是它，不是谁算错`);
const idx = read('docs/FILE_INDEX.md');
const idxBridge = /\[`bridge\.js`\][^|]*\|\s*([\d,]+)\s*\|/.exec(idx)?.[1];
console.log(`   FILE_INDEX.md 里 bridge.js 的行数: ${idxBridge ?? '(没取到)'}`);

console.log('\n② §4.1 声称"已清理"的脚本，确认磁盘上确实没有');
const removed = ['cleanup-probe-sessions', 'cleanup-probe-workspaces', 'cleanup-test-sessions',
  'fix-probe-workspace-title', 'diag-archive', 'debug-whitelist', 'patch-qq-chat-v2-presleep',
  'patch-qq-chat-v2-stickers', 'patch-qq-chat-v2-collect-memory', 'patch-web-mcp-timeout'];
let ghost = 0;
for (const n of removed) {
  const onDisk = has(`scripts/${n}.mjs`);
  if (onDisk) ghost++;
  console.log(`   ${n.padEnd(34)} ${onDisk ? '⚠ 仍存在（§4.1 说它已清理，需要改文档）' : '已清理 ✓'}`);
}
console.log(`   → 若上面出现 ⚠，说明 §4.1 与磁盘不一致（共 ${ghost} 个）`);

console.log('\n③ §4.2/§4.3 点到的脚本必须真实存在');
const still = ['probe-015.mjs', 'probe-rpc-compat.mjs', 'probe-models.mjs', 'probe-workspace.mjs',
  'probe-events.mjs', 'probe-tools.mjs', 'test-onebot-connection.mjs', 'test-mcp-exec.mjs',
  'test-mcp-host.mjs', 'test-mcp-safe.mjs', 'test-mcp-web-search.mjs',
  'patch-snowluma-sdk.mjs', 'patch-dsh-base64.mjs', 'test-audit.mjs',
  'console-ui-contracts.json', 'console-ui-fixture.mjs', 'audit-bridge-harness.mjs', 'dsh-modules.mjs'];
for (const n of still) console.log(`   scripts/${n.padEnd(30)} ${has(`scripts/${n}`) ? '存在 ✓' : '**不存在** ✗'}`);

console.log('\n④ §1 表格里的目录/文件');
for (const [label, rel] of [
  ['仓库内 .npm-cache（文档曾并列进 node_modules 那行）', '.npm-cache'],
  ['仓库内 .npmrc', '.npmrc'],
  ['工作区根 tools/start-bot.bat（§1 目录树里 tools/ 的依据）', '../tools/start-bot.bat'],
  ['工作区根 voice-tool/（文档已标"本机未安装"）', '../voice-tool'],
]) {
  const abs = path.join(ROOT, rel);
  console.log(`   ${label.padEnd(52)} ${fs.existsSync(abs) ? '存在' : '不存在'}`);
}

console.log('\n⑤ 结构：各目录子目录集合（文档必须都点到）');
for (const rel of ['dsh', 'plugins', 'docs']) {
  const real = ls(rel);
  const missing = real.filter((n) => !DOC.includes(n));
  console.log(`   ${rel}/ : ${real.join(' / ')}${missing.length ? `   ⚠ 文档没提到：${missing.join(', ')}` : '   ✓ 文档都点了'}`);
}

console.log('\n⑥ §1 目录树里每一项是否真实存在');
for (const item of (DOC.split('```')[1] ?? '').split('\n')
  .map((l) => /^[│├└─\s]*([^\s←]+)/.exec(l)?.[1])
  .filter((v) => v && !v.startsWith('D:\\dsh') && !v.startsWith('←'))) {
  const rel = item.replace(/[\\/]+$/, '');
  const okExist = rel.endsWith('*')
    ? fs.readdirSync(WS).some((n) => n.startsWith(rel.slice(0, -1)))
    : fs.existsSync(path.join(WS, rel));
  console.log(`   ${rel.padEnd(26)} ${okExist ? '存在 ✓' : '**不存在** ✗'}`);
}

console.log('\n⑦ §2 是否登记了 patch-dsh-base64.mjs');
console.log('   docs/FOLDER_MAP.md 提到它: ' + (DOC.includes('patch-dsh-base64') ? '是 ✓' : '**否** ✗'));

const check = spawnSync(process.execPath, ['scripts/gen-file-index.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
console.log('\n⑧ FILE_INDEX.md 是否与仓库一致');
console.log('   gen-file-index --check: ' + (check.status === 0 ? '一致 ✓' : '**已过期，需重跑** ✗'));
