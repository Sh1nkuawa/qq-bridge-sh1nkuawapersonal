// 静态自检：找出"被当作函数调用、但既没声明也没导入"的标识符。
//
// 起因：`node --check` 只查语法，查不出作用域错误。实测踩过两次：
// 导入时起了别名（todayKey→feedTodayKey、summarize→summarizeFeed），调用处忘了改，
// 结果异常发生在"投喂成功"这条路径上 → 群里的道谢和私聊 owner 的通知静默丢失。
//
// 做法：先剥掉注释与字符串字面量，再收集所有 `name(` 调用点，与声明/导入名单比对。
// 用法：node scripts/check-bridge-identifiers.mjs [文件...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const GLOBALS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Proxy', 'Reflect', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortSignal',
  'AbortController', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'structuredClone', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'atob', 'btoa', 'require', 'super', 'Function',
  'WebSocket', 'FormData', 'Blob', 'Headers', 'Request', 'Response', 'Intl', 'eval', 'globalThis', 'process',
  'async', 'await', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void',
  'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'case', 'break', 'continue', 'class', 'extends', 'yield'
]);

/** 剥掉注释与字符串，只留"像代码"的部分 */
export function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '"' || c === "'") {
      const quote = c; i += 1;
      while (i < n && src[i] !== quote) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1; out += ' '; continue;
    }
    if (c === '`') {
      i += 1;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { // 模板里的表达式保留
          let depth = 1; i += 2; const start = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1;
            i += 1;
          }
          out += ' ' + src.slice(start, i - 1) + ' ';
          continue;
        }
        i += 1;
      }
      i += 1; out += ' '; continue;
    }
    out += c; i += 1;
  }
  return out;
}

export function findMissingCalls(src) {
  const code = stripNonCode(src);
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const alias = seg.includes(' as ') ? seg.split(' as ').pop().trim() : seg;
      if (alias) declared.add(alias.replace(/\s+/g, ''));
    }
  }
  for (const m of code.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*|\(|,)\s*([A-Za-z_$][\w$]*)\s*(?:,|\)\s*(?:=>|\{))/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

  // 兜底过滤：名字在**原始源码**里以任何形式被声明过（含 `X as`、函数参数、正则剥离残留等），
  // 就认为不是"未定义"—— 这样能把正则字面量/参数/模板串造成的误报压掉，
  // 同时仍然能抓到 todayKey / summarize 这类**全文件都没有定义**的写错别名。
  const declaredSomewhere = (name) => {
    if (new RegExp(`\\bfunction\\s+${name}\\b`).test(src)) return true;
    if (new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(src)) return true;
    if (new RegExp(`\\bas\\s+${name}\\b`).test(src)) return true;
    if (new RegExp(`[{,]\\s*${name}\\s*[,)=}]`).test(src)) return true;
    return false;
  };

  const missing = [];
  const lines = code.split('\n');
  const seen = new Set();
  lines.forEach((line, idx) => {
    const noMember = line.replace(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g, '.CALL(');
    for (const m of noMember.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (declared.has(name) || GLOBALS.has(name) || seen.has(name)) continue;
      if (declaredSomewhere(name)) continue;
      seen.add(name);
      missing.push({ name, line: idx + 1 });
    }
  });
  return missing;
}

// ── 自测：确保这个检查真的能抓到"忘了改别名"的问题 ──
const SELFTEST = `
import { todayKey as feedTodayKey, summarize as summarizeFeed } from './feed.js';
function real() { return 1; }
const x = feedTodayKey();
const y = summarizeFeed({});
const z = real();
const bad1 = todayKey();
const bad2 = summarize({});
`;
if (process.env.AFFINITY_CHECK_SELFTEST !== '0') {
  const st = findMissingCalls(SELFTEST).map((m) => m.name).sort();
  const expected = ['summarize', 'todayKey'];
  const okSelf = JSON.stringify(st) === JSON.stringify(expected);
  console.log(`${okSelf ? '✅' : '❌'} 自检器自身有效（能抓到别名写错：期望 ${expected.join('/')}，实际 ${st.join('/') || '无'}）`);
  if (!okSelf) process.exit(2);
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['src/bridge.js', 'src/feed.js', 'src/affinity.js', 'scripts/gen-image-worker.mjs', 'src/mcp-snowluma-safe.js', 'src/mcp-web-search-safe.js'];

let problems = 0;
for (const rel of files) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const missing = findMissingCalls(fs.readFileSync(file, 'utf8'));
  if (missing.length) {
    problems += missing.length;
    console.log(`\n⚠️ ${rel}：`);
    for (const m of missing) console.log(`   L${m.line}  ${m.name}()`);
  } else {
    console.log(`✅ ${rel} 干净`);
  }
}
process.exit(problems ? 1 : 0);
