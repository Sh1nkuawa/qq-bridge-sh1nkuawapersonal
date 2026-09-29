// 把 qq-chat-v2 preset 里误插到 26 前面的 27 条移到 26 后面，并统一缩进
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const f = path.join(os.homedir(), '.dsh', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const lines = fs.readFileSync(f, 'utf8').split('\n');

// 定位 27 区块（从 "27. 【@我" 到 "27.7"）与 26 行
const i27 = lines.findIndex((l) => /^\s*27\.\s*【@我/.test(l));
const i267 = lines.findIndex((l) => /^\s*27\.7/.test(l));
const i26 = lines.findIndex((l) => /^\s*26\.\s*【偷图收藏/.test(l));

if (i27 < 0 || i267 < 0 || i26 < 0) {
  console.error(`定位失败: i27=${i27} i267=${i267} i26=${i26}`);
  process.exit(1);
}
if (i27 > i26) {
  console.log('顺序已经正确，无需调整');
  process.exit(0);
}

const INDENT = ' '.repeat(6); // 与 25/26 条一致的缩进
const block27 = lines.slice(i27, i267 + 1).map((l) => INDENT + l.trim());
const line26 = INDENT + lines[i26].trim();

// 删除旧的 27 区块与 26 行（先删后面的下标，避免位移）
const out = [];
for (let i = 0; i < lines.length; i++) {
  if (i >= i27 && i <= i267) continue;   // 跳过旧 27
  if (i === i26) continue;               // 跳过旧 26
  out.push(lines[i]);
}
// 在原本 27 的位置插入 26 + 27
const insertAt = i27;
out.splice(insertAt, 0, line26, ...block27);

fs.copyFileSync(f, f + '.bak-before-reorder');
fs.writeFileSync(f, out.join('\n'), 'utf8');

// 打印结果
const after = fs.readFileSync(f, 'utf8').split('\n');
const s = after.findIndex((l) => /^\s*26\.\s*【偷图收藏/.test(l));
console.log('调整后的顺序：');
for (let i = s - 1; i <= s + 9 && i < after.length; i++) {
  const l = after[i];
  if (l.trim() === '') continue;
  console.log('  ' + String(i + 1).padStart(4) + '| ' + l.slice(0, 70) + (l.length > 70 ? '…' : ''));
}
