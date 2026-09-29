// 精确一点的 JS 括号平衡检查：正确处理字符串、模板字面量（含 ${} 嵌套）、注释与正则字面量。
// 用法：node scripts/check-braces.mjs <文件> [更多文件...]
import fs from 'node:fs';

const OPEN = new Set(['{', '(', '[']);
const CLOSE = { '}': '{', ')': '(', ']': '[' };
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete', 'void', 'do', 'else', 'yield', 'await', 'new']);

export function scanBraces(src) {
  const stack = [];
  let i = 0;
  let line = 1;
  let mode = 'code'; // code | line | block | sq | dq | tpl | regex
  let prev = ''; // 上一个有效字符（用于判断 / 是除号还是正则开头）
  let word = ''; // 最近的标识符
  let regexClass = false;

  const regexAllowed = () => {
    if (prev === '') return true;
    if (/[([{,;:=!&|?+\-*%^~<>]/.test(prev)) return true;
    if (KEYWORDS_BEFORE_REGEX.has(word)) return true;
    return false;
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '\n') line++;

    if (mode === 'line') { if (ch === '\n') mode = 'code'; i++; continue; }
    if (mode === 'block') { if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; } i++; continue; }
    if (mode === 'sq' || mode === 'dq') {
      const q = mode === 'sq' ? "'" : '"';
      if (ch === '\\') { i += 2; continue; }
      if (ch === q) { mode = 'code'; prev = q; }
      i++; continue;
    }
    if (mode === 'regex') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') { regexClass = true; i++; continue; }
      if (ch === ']') { regexClass = false; i++; continue; }
      if (ch === '/' && !regexClass) { mode = 'code'; prev = '/'; i++; while (/[a-z]/i.test(src[i] ?? '')) i++; continue; }
      i++; continue;
    }
    if (mode === 'tpl') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { mode = 'code'; prev = '`'; i++; continue; }
      if (ch === '$' && next === '{') { stack.push({ ch: '{', line, virtual: true }); mode = 'code'; prev = '{'; i += 2; continue; }
      i++; continue;
    }

    // mode === 'code'
    if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
    if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
    if (ch === "'") { mode = 'sq'; i++; continue; }
    if (ch === '"') { mode = 'dq'; i++; continue; }
    if (ch === '`') { mode = 'tpl'; i++; continue; }
    if (ch === '/' && regexAllowed()) { mode = 'regex'; regexClass = false; i++; continue; }
    if (OPEN.has(ch)) { stack.push({ ch, line, virtual: false }); prev = ch; word = ''; i++; continue; }
    if (CLOSE[ch]) {
      const top = stack.pop();
      if (!top) return { ok: false, line, msg: `第 ${line} 行出现多余的 '${ch}'（栈已空）`, stack };
      if (top.ch !== CLOSE[ch]) return { ok: false, line, msg: `第 ${line} 行 '${ch}' 与第 ${top.line} 行的 '${top.ch}' 不匹配`, stack };
      if (top.virtual) { mode = 'tpl'; prev = '}'; i++; continue; }
      prev = ch; word = ''; i++; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) { word += ch; prev = ch; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    prev = ch; word = '';
    i++;
  }
  if (mode === 'sq' || mode === 'dq' || mode === 'tpl' || mode === 'regex' || mode === 'block') {
    return { ok: false, line, msg: `文件结束时仍处于 ${mode}（字符串/模板/正则/注释没闭合，起始可能在更早处）`, stack };
  }
  if (stack.length) {
    const last = stack[stack.length - 1];
    return { ok: false, line, msg: `文件结束仍差闭合：第 ${last.line} 行的 '${last.ch}' 没关上（还差 ${stack.length} 个）`, stack };
  }
  return { ok: true, line };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-braces.mjs')) {
  let bad = 0;
  for (const file of process.argv.slice(2)) {
    const r = scanBraces(fs.readFileSync(file, 'utf8'));
    console.log(`${r.ok ? '✅' : '❌'} ${file}${r.ok ? '' : ' — ' + r.msg}`);
    if (!r.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}
