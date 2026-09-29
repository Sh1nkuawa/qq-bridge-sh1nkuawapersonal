// 在所有 QQ 会话里搜关键词，打印命中会话里的 web_search / web_fetch 调用与结果（用来判断搜索质量）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const root = path.join(os.homedir(), '.dsh', 'sessions', '--D-dsh-qq-bridge--');
const keyword = process.argv[2] || '';
const maxSessions = Number(process.argv[3] || 8);

function readSession(f) {
  const b = fs.readFileSync(f);
  const magic = Buffer.from('28b52ffd', 'hex');
  const offs = [];
  let i = 0;
  while ((i = b.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
  let out = '';
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : b.length;
    try { out += zlib.zstdDecompressSync(b.subarray(offs[k], end)).toString('utf8'); } catch { /* 坏帧跳过 */ }
  }
  return out;
}

const dirs = fs.readdirSync(root)
  .map((n) => ({ n, t: fs.statSync(path.join(root, n)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, maxSessions);

const t = (ms) => new Date(Number(ms)).toLocaleString('sv');

for (const d of dirs) {
  // DSH 会随版本改会话文件名（v3 → v4）：两个都试，别让诊断脚本因为一个扩展名就静默失效。
  const f = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']
    .map((n) => path.join(root, d.n, n))
    .find((p) => fs.existsSync(p));
  if (!f) continue;
  const txt = readSession(f);
  if (keyword && !txt.includes(keyword)) continue;
  console.log(`\n================ ${d.n}（最后写入 ${t(d.t)}）================`);
  const callNames = new Map();
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant/message') {
      for (const p of (e.data?.message?.content ?? [])) {
        if (p.type === 'tool-call' && /web_search|web_fetch/.test(p.name)) {
          if (p.id) callNames.set(String(p.id), p.name);
          console.log(`[${t(e.time)}] 🔧 ${String(p.name).replace('mcp__web-search-safe__', '')} ${String(p.arguments).slice(0, 200)}`);
        }
      }
    }
    if (e.type === 'tool/result') {
      for (const p of (e.data?.message?.content ?? [])) {
        if (p.type !== 'tool-result') continue;
        const name = callNames.get(String(p.toolCallId)) ?? '';
        if (!/web_search|web_fetch/.test(name)) continue;
        const s = (p.content ?? []).map((x) => x.text ?? '').join(' ');
        console.log(`[${t(e.time)}] 📥 ${p.isError ? '[ERR] ' : ''}${s.slice(0, 700).replace(/\s+/g, ' ')}`);
        console.log('   ──');
      }
    }
  }
}
