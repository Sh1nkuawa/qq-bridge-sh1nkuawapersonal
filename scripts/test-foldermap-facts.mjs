// 防漂移：docs/FOLDER_MAP.md 的**结构类事实**必须与仓库/工作区现状一致。
//
// 起因（2026-10-05）：那份文档手抄了一堆会漂移的东西，等被发现时已经全错 ——
//   · src/bridge.js 写「约 10,400 行」，实际 14,109 行；
//   · scripts 写「共 170 个（167 .mjs + 3 JSON）」，实际 190 个（181 .mjs + 5 .ps1 + 3 .json + 1 .html）；
//   · docs/ 结构写 design/ research/ audits/ legacy/ 四个子目录，实际只剩 guides/；
//   · dsh/ 漏了 skills/、plugins/ 漏了 qq-agent-presets；
//   · §1 的目录树与整个 §5 描述的是工作区根**并不存在**的 voice-tool/ 与两个 .cmd 启动器。
// 人不会主动重读文档，所以这里把"能机器判定"的部分钉死，让文档烂掉时先红在回归里。
//
// 断言的取舍：
//   · **不断言行号、行数、文件个数**（每次提交都会变，那种断言只会被绕过）；
//   · 只断言**结构性事实**：目录里有哪些子目录、文档点到的路径是否真实存在、
//     以及"不许再手抄会漂移的硬数字"（出现就失败，逼作者改成指向自动生成的 FILE_INDEX）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = path.resolve(ROOT, '..');
const DOC = path.join(ROOT, 'docs', 'FOLDER_MAP.md');
const text = fs.readFileSync(DOC, 'utf8');

let pass = 0; let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + ' — ' + (e?.message ?? e)); }
};
const subdirs = (p) => fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory())
  .map((d) => d.name).filter((n) => !n.startsWith('.') && n !== 'node_modules').sort();

console.log('## 各目录的子目录集合：文档必须点到（漏一个就红）');
for (const [label, abs, mustMention] of [
  ['dsh/', path.join(ROOT, 'dsh'), true],
  ['plugins/', path.join(ROOT, 'plugins'), true],
]) {
  const real = subdirs(abs);
  ok(`${label} 实际有 ${real.join(' / ')}，文档里都提到了`, () => {
    const missing = real.filter((n) => !text.includes(n));
    assert.deepEqual(missing, [], `文档没提到：${missing.join(', ')}`);
  });
  assert.ok(mustMention);
}

console.log('\n## docs/：子目录与根级 md 都要在文档里出现');
const docsDirs = subdirs(path.join(ROOT, 'docs'));
const docsRootMd = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
ok(`docs/ 子目录（${docsDirs.join(' / ') || '无'}）都提到了`, () => {
  const missing = docsDirs.filter((n) => !text.includes(n));
  assert.deepEqual(missing, [], `文档没提到子目录：${missing.join(', ')}`);
});
ok(`docs/ 根级 md（${docsRootMd.length} 个）都提到了`, () => {
  const missing = docsRootMd.filter((n) => !text.includes(n));
  assert.deepEqual(missing, [], `文档没提到：${missing.join(', ')}`);
});
ok('文档不再声称存在 design/ research/ audits/ legacy/ 这些子目录', () => {
  for (const gone of ['design/', 'research/', 'audits/', 'legacy/']) {
    if (docsDirs.includes(gone.replace('/', ''))) continue;   // 万一以后又建回来了
    assert.ok(!new RegExp(`^[│├└\\s]*${gone}`, 'm').test(text), `文档里还有 ${gone} 的目录项，但它不存在`);
  }
});

console.log('\n## §1 目录树里的每一项都必须真实存在（voice-tool 那次就是这里翻车）');
const treeBlock = text.split('```')[1] ?? '';
const treeItems = treeBlock.split('\n')
  .map((l) => /^[│├└─\s]*([^\s←]+)/.exec(l)?.[1])
  .filter((v) => v && v !== 'D:\\dsh/' && v !== 'D:\\dsh' && !v.startsWith('←'));
ok(`目录树解析出 ${treeItems.length} 项`, () => assert.ok(treeItems.length >= 3, '解析失败，正则要跟着文档格式更新'));
for (const item of treeItems) {
  const rel = item.replace(/[\\/]+$/, '');
  ok(`目录树项真实存在：${rel}`, () => {
    if (rel.endsWith('*')) {
      const prefix = rel.slice(0, -1);
      const hit = fs.readdirSync(WS).some((n) => n.startsWith(prefix));
      assert.ok(hit, `工作区根没有以 ${prefix} 开头的项`);
      return;
    }
    assert.ok(fs.existsSync(path.join(WS, rel)), `工作区根没有 ${rel}`);
  });
}
ok('voice-tool 若不存在，文档必须写明"未安装"', () => {
  const exists = fs.existsSync(path.join(WS, 'voice-tool'));
  if (exists) return;
  assert.match(text, /本机未安装/, 'voice-tool 不存在，但文档没写"本机未安装"');
});

console.log('\n## 不许再手抄会漂移的硬数字（改为引用自动生成的 FILE_INDEX）');
// 只看正文：`>` 引用块里是文档自己的沿革说明（会引用这些错误示例当反面教材），不该被误判。
const body = text.split('\n').filter((l) => !l.trimStart().startsWith('>')).join('\n');
// ⚠️ 用**通用模式**而不是上一次的具体字面量：上一版只匹配 `约 10,400 行` / `共 170 个`，
//    结果改写成 `14,109 行` 就绕过去了（"防住了昨天的错，没防住今天的错"）。
ok('正文里没有任何行数主张（任何 3 位以上数字 + 「行」）', () => {
  const m = /(?<![\w.-])\d[\d,]{2,}\s*行/.exec(body);
  assert.equal(m, null, `正文仍写着行数：${m?.[0]} —— 请引用 FILE_INDEX.md 的「行数」列`);
});
ok('正文里没有文件个数主张（「共 N 个文件/脚本」）', () => {
  const m = /共\s*\d+\s*个(?:文件|脚本)|共\s*\d{3,}\s*个/.exec(body);
  assert.equal(m, null, `正文仍写着文件总数：${m?.[0]}`);
});
ok('正文里没有扩展名计数（如「181 .mjs」「5 个 .ps1」）', () => {
  // 负向后顾是必须的：否则 `patch-dsh-base64.mjs`、`probe-015.mjs` 这类**文件名里的数字**
  // 会被误判成"按扩展名计数"（实测踩过）。
  const m = /(?<![\w.-])\d+\s*个?\s*`?\.(?:mjs|js|cjs|ps1|json|html)/.exec(body);
  assert.equal(m, null, `正文仍写着按扩展名的计数：${m?.[0]}`);
});
ok('文档指向了 FILE_INDEX.md（硬数字的唯一出处）', () => assert.match(text, /FILE_INDEX\.md/));
ok('FILE_INDEX.md 真的有「行数」列（否则"以它为准"盖不住行数）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'docs', 'FILE_INDEX.md'), 'utf8');
  assert.match(idx, /\|\s*文件\s*\|\s*行数\s*\|/, 'FILE_INDEX 表头里没有「行数」列');
  assert.match(idx, /总行数（含空行）/, 'FILE_INDEX 没写清行数口径');
});

console.log('\n## 正文提到的脚本必须真的存在（§4 那种"列了一堆已删除脚本"的漂移）');
const mentioned = new Set();
for (const m of body.matchAll(/`scripts\/([A-Za-z0-9._-]+\.(?:mjs|js|cjs|ps1))`/g)) mentioned.add(m[1]);
ok(`正文点到 ${mentioned.size} 个具体脚本文件`, () => assert.ok(mentioned.size >= 5, '一个都没解析到，正则要跟着文档格式更新'));
for (const name of [...mentioned].sort()) {
  ok(`存在：scripts/${name}`, () => {
    const abs = path.join(ROOT, 'scripts', name);
    if (fs.existsSync(abs)) return;
    // 允许"通配/成组"写法（例如 console-ui-*.json），也允许被显式标记为已清理的行
    const line = body.split('\n').find((l) => l.includes(name)) ?? '';
    if (name.includes('*') || /已清理|已删除|已移出|已废弃|曾经的脚本/.test(line)) return;
    assert.fail(`文档里点了 scripts/${name}，但磁盘上不存在（若是已清理，请挪进 §4.1 并去掉 scripts/ 前缀）`);
  });
}

console.log('\n## FILE_INDEX.md 必须与仓库一致（生成物不许过期）');
const chk = spawnSync(process.execPath, ['scripts/gen-file-index.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
ok('gen-file-index --check 通过', () => {
  assert.equal(chk.status, 0, (chk.stdout || '') + (chk.stderr || ''));
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
