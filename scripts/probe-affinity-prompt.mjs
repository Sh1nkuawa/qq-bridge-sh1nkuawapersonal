// 检查最新 QQ 会话里有没有注入好感度（关系）面板，并打印片段
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const root = path.join(os.homedir(), '.dsh', 'sessions', '--D-dsh-qq-bridge--');
const dirs = fs.readdirSync(root).map((n) => ({ n, t: fs.statSync(path.join(root, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 3);

function readSession(f) {
  const b = fs.readFileSync(f);
  const magic = Buffer.from('28b52ffd', 'hex');
  const offs = [];
  let i = 0;
  while ((i = b.indexOf(magic, i)) !== -1) { offs.push(i); i += 4; }
  let out = '';
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : b.length;
    try { out += zlib.zstdDecompressSync(b.subarray(offs[k], end)).toString('utf8'); } catch { /* 坏帧 */ }
  }
  return out;
}

for (const d of dirs) {
  // DSH 会随版本改会话文件名（v3 → v4）：两个都试，别让诊断脚本因为一个扩展名就静默失效。
  const f = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']
    .map((n) => path.join(root, d.n, n))
    .find((p) => fs.existsSync(p));
  if (!f) continue;
  let txt = '';
  try { txt = readSession(f); } catch (e) { console.log(`${d.n}: 解压失败 ${e.message}`); continue; }
  const has = txt.includes('【关系');
  console.log(`\n=== ${d.n}（最后写入 ${new Date(d.t).toLocaleString('sv')}）关系面板: ${has ? '✅ 有' : '❌ 无'}`);
  if (!has) continue;
  // 找到包含面板的那条 user/message，打印其内容片段
  for (const line of txt.split('\n')) {
    if (!line.trim() || !line.includes('【关系')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.data?.content ?? e?.data?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : '';
    const idx = text.indexOf('【关系');
    if (idx >= 0) {
      console.log(text.slice(idx, idx + 700));
      break;
    }
  }
}
