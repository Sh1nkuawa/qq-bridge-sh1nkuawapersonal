// 复盘一次失败的 assistant/attempt：把流式 chunk 汇总成「块类型 / 工具名 / 工具入参原文 / 结束原因」。
// 用法：node scripts/replay-dsh-attempt.mjs <会话文件> <行号>
import { readZstdFrameLines } from './zstd-frames.mjs';

const file = process.argv[2];
const lineNo = Number(process.argv[3]);
const lines = readZstdFrameLines(file);
const j = JSON.parse(lines[lineNo - 1]);
const stream = j?.data?.stream ?? [];
console.log(`事件: ${j.type}  turn=${j.data?.turn} step=${j.data?.step}  时间=${new Date(Number(j.time)).toLocaleString('zh-CN')}`);
console.log(`stream 项数: ${stream.length}\n`);

const blocks = new Map();
const toolInputs = [];
for (const item of stream) {
  const c = item.chunk ?? item;
  if (c.type === 'block-start') blocks.set(c.index, { type: c.blockType, name: c.toolName ?? c.name ?? '' });
  if (c.type === 'block-end') {
    const b = blocks.get(c.index) ?? {};
    const info = { index: c.index, type: c.block?.type ?? b.type, tool: c.block?.toolName ?? c.block?.name ?? b.name, text: String(c.block?.text ?? '') };
    if (info.type === 'tool-input' || info.tool) toolInputs.push(info);
  }
  // 工具入参增量
  for (const key of ['delta', 'text', 'inputJsonDelta', 'partialJson']) {
    const v = c[key] ?? c.chunk?.[key];
    if (typeof v === 'string' && v) toolInputs.push({ index: c.index, delta: v });
  }
}

console.log('块：');
for (const [i, b] of blocks) console.log(`  #${i} ${b.type}${b.name ? ' (' + b.name + ')' : ''}`);

const deltas = toolInputs.filter((t) => t.delta);
if (deltas.length) {
  const joined = deltas.map((d) => d.delta).join('');
  console.log(`\n工具入参增量 ${deltas.length} 段，拼起来 ${joined.length} 字符：`);
  console.log(joined.slice(0, 2000));
  console.log('\n--- 末尾 300 字符 ---');
  console.log(joined.slice(-300));
  for (const label of ['JSON.parse 成功', 'JSON.parse 失败']) {
    try { JSON.parse(joined); console.log('✅ 完整 JSON 可解析'); } catch (e) { console.log('❌ JSON 解析失败: ' + e.message); }
    break;
  }
}

const finish = stream.map((s) => s.chunk).find((c) => c?.type === 'finish');
console.log('\nfinish: ' + JSON.stringify(finish?.reason ?? finish ?? null).slice(0, 400));
