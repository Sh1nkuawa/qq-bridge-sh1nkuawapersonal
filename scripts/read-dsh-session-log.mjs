// 读 DSH 的会话记录（session.v4.jsonl.zstd）并打印尾部事件，用于诊断端到端用例里模型做了什么。
// 注意：这些文件是多帧 zstd 拼接，必须用 zstd-frames.mjs 读（zstdDecompressSync 只解第一帧，
// 会让人误以为"这个会话是空的"）。
import { readZstdFrameLines } from './zstd-frames.mjs';

const file = process.argv[2];
const n = Number(process.argv[3] || '12');
let lines;
try {
  lines = readZstdFrameLines(file);
} catch (e) {
  console.error('zstd 解压失败：' + e.message);
  process.exit(1);
}
console.log(`共 ${lines.length} 行事件，尾部 ${n} 行：\n`);
for (const l of lines.slice(-n)) {
  try {
    const j = JSON.parse(l);
    const t = j.type ?? j.kind ?? '?';
    const brief = JSON.stringify(j).slice(0, 600);
    console.log(`--- ${t} ---`);
    console.log(brief);
  } catch {
    console.log(l.slice(0, 400));
  }
}
