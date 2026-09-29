// 读 DSH 的会话记录（session.v4.jsonl.zstd）并打印尾部事件，用于诊断端到端用例里模型做了什么。
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const n = Number(process.argv[3] || '12');
const raw = fs.readFileSync(file);
let text;
try {
  text = zlib.zstdDecompressSync(raw).toString('utf8');
} catch (e) {
  console.error('zstd 解压失败：' + e.message);
  process.exit(1);
}
const lines = text.split('\n').filter(Boolean);
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
