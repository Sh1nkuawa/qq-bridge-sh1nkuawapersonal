#!/usr/bin/env node
// 给 DSH 打补丁：把"会爆栈的 base64 校验正则"换成线性校验。
//
// 为什么需要（2026-09-30 实测）：
//   dsh-mcp-client 用 /^(?:[A-Za-z0-9+/]{4})*(?:...)?$/ 校验 MCP 工具返回的图片 base64。
//   这个 `(?:…)*` 在 V8 里是**递归**实现，深度 ∝ data.length/4：base64 到 ~4.4MB
//   （≈3.3MB 的图，手机原图常见）就抛 `RangeError: Maximum call stack size exceeded`，
//   于是 DSH 把图片降级成文本：
//     [image unavailable: image/png; Maximum call stack size exceeded; …]
//   → 模型看不到那张图（群里的表现就是"这张死活读不出来、重发也没用"）。
//   实测阈值：2.4MB base64（1.8MB 图）通过；4.4MB（3.3MB 图）爆栈。
//
// 用法：
//   node scripts/patch-dsh-base64.mjs          # 打补丁（幂等，自动备份 .bak-qqbridge）
//   node scripts/patch-dsh-base64.mjs --check  # 只检查状态，不改文件
//   node scripts/patch-dsh-base64.mjs --revert # 从备份还原
//
// 注意：这是对**全局安装的 dsh 包**做的本地补丁，npm 更新 dsh 后会被覆盖，需要重新执行一次。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OLD_LINE = 'const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;';
const NEW_BLOCK = [
  '/**',
  ' * 规范 base64 校验（线性时间）。',
  ' *',
  ' * [qq-bridge 本地补丁 2026-09-30] 原来是 /^(?:[A-Za-z0-9+/]{4})*(?:…)?$/：`(?:…)*` 在 V8 里是递归实现，',
  ' * 递归深度 ∝ data.length/4，图片 base64 到 ~4.4MB（≈3.3MB 的图）就 RangeError: Maximum call stack',
  ' * size exceeded —— 图片会被降级成 "[image unavailable: …]"，模型直接看不到。改成逐字符线性扫描。',
  ' */',
  'function isCanonicalBase64(value) {',
  '\tif (typeof value !== "string") return false;',
  '\tif (value.length === 0) return true;',
  '\tif (value.length % 4 !== 0) return false;',
  '\tconst pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;',
  '\tconst end = value.length - pad;',
  '\tfor (let i = 0; i < end; i += 1) {',
  '\t\tconst c = value.charCodeAt(i);',
  '\t\tconst ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;',
  '\t\tif (!ok) return false;',
  '\t}',
  '\tfor (let i = end; i < value.length; i += 1) if (value.charCodeAt(i) !== 61) return false;',
  '\treturn true;',
  '}'
].join('\n');
const OLD_CALL = 'if (!CANONICAL_BASE64.test(block.data)) throw new Error("the image data is not canonical base64");';
const NEW_CALL = 'if (!isCanonicalBase64(block.data)) throw new Error("the image data is not canonical base64");';

/** 从旧正则行为打分：新函数必须与它在小样本上完全一致（含空串为 true）。 */
function selfTest() {
  const OLD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  // eslint-disable-next-line no-new-func
  const isCanonicalBase64 = new Function(`${NEW_BLOCK}; return isCanonicalBase64;`)();
  const cases = ['', 'AAAA', 'AA==', 'AAA=', 'A===', 'AAAA=', 'AA=A', 'AB+/', 'AB-_', 'AAAA\n', 'AAA', 'AA==AA==', 'Zm9v', 'Zm9vYg=='];
  for (const c of cases) {
    if (OLD.test(c) !== isCanonicalBase64(c)) throw new Error(`自检失败：${JSON.stringify(c)} 老=${OLD.test(c)} 新=${isCanonicalBase64(c)}`);
  }
  // 大图不该爆栈：4.4MB base64（≈3.3MB 图，实测老正则在这里 RangeError）
  const big = Buffer.alloc(3300 * 1024, 0x41).toString('base64');
  try { OLD.test(big); } catch { /* 预期会爆 */ }
  if (isCanonicalBase64(big) !== true) throw new Error('自检失败：大图没通过线性校验');
  const bigBad = big.slice(0, -1) + '_';
  if (isCanonicalBase64(bigBad) !== false) throw new Error('自检失败：非法字符没被拒');
  return true;
}

function targets() {
  const roots = [];
  // 全局 dsh 包（本机：D:\nodejs16\node_global\node_modules\@deepseek-ai\dsh）
  try {
    const pkg = require.resolve('@deepseek-ai/dsh/package.json');
    roots.push(path.dirname(pkg));
  } catch { /* 解析不到就用下面的候选 */ }
  for (const guess of [
    'D:/nodejs16/node_global/node_modules/@deepseek-ai/dsh',
    path.join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh')
  ]) if (guess && fs.existsSync(guess)) roots.push(guess);

  const files = [];
  for (const root of roots) {
    for (const sub of ['dsh-mcp-client', 'dsh-acp']) {
      for (const rel of [['node_modules', '@deepseek-ai', sub, 'lib', 'index.js'], [sub, 'lib', 'index.js']]) {
        const p = path.join(root, ...rel);
        if (fs.existsSync(p)) files.push(p);
      }
    }
  }
  return [...new Set(files)];
}

const mode = process.argv.includes('--check') ? 'check' : (process.argv.includes('--revert') ? 'revert' : 'apply');
const files = targets();
if (!files.length) {
  console.error('没找到 dsh-mcp-client / dsh-acp（先确认全局 dsh 装在哪）');
  process.exit(2);
}
selfTest();
console.log(`自检通过（与旧正则行为一致；4.4MB base64 不再爆栈）`);

let patched = 0, already = 0, reverted = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const hasOld = src.includes(OLD_LINE);
  const hasNew = src.includes('function isCanonicalBase64(value)');
  const bak = `${file}.bak-qqbridge`;

  if (mode === 'check') {
    console.log(`  ${hasOld ? '❌ 未打补丁（还是老正则）' : (hasNew ? '✅ 已打补丁' : '❔ 认不出（可能改版了）')}  ${file}`);
    continue;
  }
  if (mode === 'revert') {
    if (!fs.existsSync(bak)) { console.log(`  ⏭️ 没有备份，跳过  ${file}`); continue; }
    fs.copyFileSync(bak, file);
    console.log(`  ↩️ 已还原  ${file}`);
    reverted += 1;
    continue;
  }
  if (hasNew && !hasOld) { already += 1; console.log(`  ✅ 已经是补丁后的版本  ${file}`); continue; }
  if (!hasOld) { console.log(`  ⚠️ 找不到老正则（DSH 可能改版了），跳过  ${file}`); continue; }
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  let next = src.replace(OLD_LINE, NEW_BLOCK).replace(OLD_CALL, NEW_CALL);
  if (next.includes('CANONICAL_BASE64')) {
    // 还有别处引用这个常量：保守起来，补一个同名别名，避免留下未定义引用
    next = next.replace(NEW_BLOCK, `${NEW_BLOCK}\nconst CANONICAL_BASE64 = { test: (value) => isCanonicalBase64(value) };`);
  }
  fs.writeFileSync(file, next, 'utf8');
  patched += 1;
  console.log(`  🔧 已打补丁（备份 ${path.basename(bak)}）  ${file}`);
}
console.log(`\n结果：补丁 ${patched} 个，已是最新 ${already} 个，还原 ${reverted} 个。`);
if (mode === 'apply' && patched) console.log('⚠️ 需要重启 DSH 才会生效（本次会话也会随之结束）。');
