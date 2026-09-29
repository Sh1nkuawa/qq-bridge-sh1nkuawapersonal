// 打印某个 DSH 会话里模型每一步的 reasoning 摘要（做"它为什么没做某件事"的复盘用）。
// 用法：node scripts/dump-session-reasoning.mjs <会话文件> [最多几条]
import { readZstdFrameLines } from './zstd-frames.mjs';

const file = process.argv[2];
const max = Number(process.argv[3] || '12');
const lines = readZstdFrameLines(file);

const steps = [];
for (const l of lines) {
  let j = null;
  try { j = JSON.parse(l); } catch { continue; }
  if (j.type !== 'assistant/message') continue;
  const msg = j.data?.message ?? j.message ?? {};
  const content = Array.isArray(msg.content) ? msg.content : [];
  const reasoning = content.find((c) => c.type === 'reasoning')?.text ?? '';
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  const calls = content.filter((c) => c.type === 'tool-call').map((c) => c.name ?? c.toolName ?? '?');
  steps.push({
    time: j.time ? new Date(Number(j.time)).toLocaleTimeString('zh-CN') : '?',
    turn: j.data?.turn ?? j.turn, step: j.data?.step ?? j.step,
    reasoning, text, calls,
  });
}
console.log(`共 ${steps.length} 条 assistant 输出，打印最后 ${Math.min(max, steps.length)} 条\n`);
for (const s of steps.slice(-max)) {
  console.log('═'.repeat(88));
  console.log(`[${s.time}] turn=${s.turn} step=${s.step}${s.calls.length ? '  工具: ' + s.calls.join(',') : ''}`);
  if (s.reasoning) console.log('--- 思考 ---\n' + s.reasoning.slice(0, 1400));
  if (s.text) console.log('--- 文本 ---\n' + s.text.slice(0, 700));
}
