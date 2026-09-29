// 找出 main() 的 body 在哪里被提前闭合（括号深度第一次回到 0 的那一行）。
// 用法：node scripts/trace-depth.mjs <文件> [起始行号，默认找 'async function main']
import fs from 'node:fs';
import { scanBraces } from './check-braces.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2];
if (!file) { console.error('用法：node scripts/trace-depth.mjs <文件>'); process.exit(1); }
const src = fs.readFileSync(file, 'utf8');

// 复制一份 scan 逻辑但记录每行结束时的深度
const OPEN = new Set(['{', '(', '[']);
const CLOSE = { '}': '{', ')': '(', ']': '[' };
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'do', 'else', 'yield', 'await', 'new']);
let i = 0, line = 1, mode = 'code', prev = '', word = '', regexClass = false;
const stack = [];
const depthByLine = [];
const regexAllowed = () => prev === '' || /[([{,;:=!&|?+\-*%^~<>]/.test(prev) || KEYWORDS_BEFORE_REGEX.has(word);
while (i < src.length) {
  const ch = src[i], next = src[i + 1];
  if (mode === 'line') { if (ch === '\n') { mode = 'code'; depthByLine[line] = stack.length; line++; } i++; continue; }
  if (mode === 'block') { if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; } if (ch === '\n') { depthByLine[line] = stack.length; line++; } i++; continue; }
  if (mode === 'sq' || mode === 'dq') { const q = mode === 'sq' ? "'" : '"'; if (ch === '\\') { i += 2; continue; } if (ch === q) { mode = 'code'; prev = q; } if (ch === '\n') { depthByLine[line] = stack.length; line++; } i++; continue; }
  if (mode === 'regex') { if (ch === '\\') { i += 2; continue; } if (ch === '[') regexClass = true; else if (ch === ']') regexClass = false; else if (ch === '/' && !regexClass) { mode = 'code'; prev = '/'; i++; while (/[a-z]/i.test(src[i] ?? '')) i++; continue; } if (ch === '\n') { depthByLine[line] = stack.length; line++; } i++; continue; }
  if (mode === 'tpl') { if (ch === '\\') { i += 2; continue; } if (ch === '`') { mode = 'code'; prev = '`'; i++; continue; } if (ch === '$' && next === '{') { stack.push({ ch: '{', line, virtual: true }); mode = 'code'; prev = '{'; i += 2; continue; } if (ch === '\n') { depthByLine[line] = stack.length; line++; } i++; continue; }
  if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
  if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
  if (ch === "'") { mode = 'sq'; i++; continue; }
  if (ch === '"') { mode = 'dq'; i++; continue; }
  if (ch === '`') { mode = 'tpl'; i++; continue; }
  if (ch === '/' && regexAllowed()) { mode = 'regex'; regexClass = false; i++; continue; }
  if (OPEN.has(ch)) { stack.push({ ch, line, virtual: false }); prev = ch; word = ''; i++; continue; }
  if (CLOSE[ch]) {
    const top = stack.pop();
    if (!top) { console.log(`❌ 第 ${line} 行多余 '${ch}'`); break; }
    if (top.virtual) { mode = 'tpl'; prev = '}'; i++; continue; }
    prev = ch; word = ''; i++; continue;
  }
  if (/[A-Za-z_$]/.test(ch)) { word += ch; prev = ch; i++; continue; }
  if (ch === '\n') { depthByLine[line] = stack.length; line++; i++; continue; }
  prev = ch; word = ''; i++;
}
depthByLine[line] = stack.length;

const lines = src.split('\n');
let mainLine = 0;
for (let n = 1; n <= lines.length; n++) if (/^\s*(export\s+)?async function main\(/.test(lines[n - 1])) { mainLine = n; break; }
console.log(`main() 起始行：${mainLine}`);
console.log('main 之后深度回到 0（= body 被提前闭合）的行：');
let reported = 0;
for (let n = mainLine + 1; n <= lines.length && reported < 8; n++) {
  if ((depthByLine[n] ?? 0) === 0 && (depthByLine[n - 1] ?? 0) > 0) {
    console.log(`  >> 第 ${n} 行（上一行深度 ${depthByLine[n - 1]}）：${lines[n - 1].trim().slice(0, 100)}`);
    reported++;
  }
}
if (!reported) console.log('  （没有提前回到 0，问题可能是别的类型）');
