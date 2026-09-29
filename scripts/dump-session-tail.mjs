// 解码某个 DSH 会话（zstd 分帧）并打印最近的工具调用/结果，用于还原"模型到底看到了什么"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const root = path.join(os.homedir(), '.dsh', 'sessions', '--D-dsh-qq-bridge--');
const want = process.argv[2];
const limit = Number(process.argv[3] || 40);

function readSession(f) {
  const b = fs.readFileSync(f);
  const magic = Buffer.from('28b52ffd', 'hex');
  const offs = [];
  let i = 0;
  while ((i = b.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
  let out = '';
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : b.length;
    try { out += zlib.zstdDecompressSync(b.subarray(offs[k], end)).toString('utf8'); } catch { /* 跳过坏帧 */ }
  }
  return out;
}

const dirs = fs.readdirSync(root)
  .filter((n) => !want || n.includes(want))
  .map((n) => ({ n, t: fs.statSync(path.join(root, n)).mtimeMs }))
  .sort((a, b) => a.t - b.t);

const dir = dirs[dirs.length - 1];
console.log(`会话: ${dir.n}  (mtime ${new Date(dir.t).toLocaleString('sv')})\n`);
const txt = readSession(path.join(root, dir.n, 'session.v3.jsonl.zstd'));
const events = [];
for (const line of txt.split('\n')) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch { /* 非 JSON 行 */ }
}
const t = (ms) => new Date(Number(ms)).toLocaleTimeString('sv');
const out = [];
for (const e of events) {
  if (e.type === 'assistant/message') {
    for (const p of (e.data?.message?.content ?? [])) {
      if (p.type === 'tool-call') out.push(`[${t(e.time)}] 🔧 ${String(p.name).replace('mcp__snowluma__', '')} ${String(p.arguments).slice(0, 200)}`);
      if (p.type === 'reasoning' && /生图|image|超时|timeout|网络/.test(p.text || '')) out.push(`[${t(e.time)}] 🧠 ${String(p.text).slice(0, 300).replace(/\n/g, ' ')}`);
    }
  }
  if (e.type === 'tool/result') {
    for (const p of (e.data?.message?.content ?? [])) {
      if (p.type !== 'tool-result') continue;
      const s = (p.content ?? []).map((x) => x.text ?? '').join(' ');
      out.push(`[${t(e.time)}] 📥 ${p.isError ? '[ERR] ' : ''}${s.slice(0, 400).replace(/\n/g, ' ')}`);
    }
  }
}
console.log(out.slice(-limit).join('\n'));
