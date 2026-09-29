// 用 DSH 自带的 @babel/parser 精确定位语法错误（node --check 只报个笼统位置）。
// 用法：node scripts/find-syntax-error.mjs <文件>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/nodejs16/node_global/node_modules/@deepseek-ai/dsh/node_modules/');
let parser;
try {
  parser = require('@babel/parser');
} catch (error) {
  console.error('拿不到 @babel/parser：', error.message);
  process.exit(2);
}

const file = process.argv[2];
if (!file) { console.error('用法：node scripts/find-syntax-error.mjs <文件>'); process.exit(1); }
const src = fs.readFileSync(file, 'utf8');
try {
  parser.parse(src, { sourceType: 'script', ecmaVersion: 'latest', plugins: ['topLevelAwait'] });
  console.log(`✅ ${file} 语法没问题`);
} catch (error) {
  const loc = error.loc ?? {};
  console.log(`❌ ${path.basename(file)} 语法错误：${error.message}`);
  if (loc.line) {
    console.log(`   位置：第 ${loc.line} 行 第 ${loc.column} 列`);
    const lines = src.split('\n');
    for (let i = Math.max(1, loc.line - 6); i <= Math.min(lines.length, loc.line + 6); i++) {
      console.log(`${i === loc.line ? '>>' : '  '} ${String(i).padStart(5)} | ${lines[i - 1]}`);
    }
  }
  process.exit(1);
}
