// 扫 DSH 会话记录（session.v4.jsonl.zstd）找报错：解压后按行解析，挑出 error / tool input /
// Messages stream 之类的事件，打印时间与会话。
//
// 用法：
//   node scripts/scan-dsh-session-errors.mjs [--since "2026-09-29 17:40"] [--dir <会话根目录>] [--all]
// 默认只看 QQ 桥接的会话目录（~/.dsh/sessions/--D-dsh-qq-bridge--）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SINCE = new Date(argOf('since', '1970-01-01')).getTime();
const ALL = argv.includes('--all');
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const DIR = argOf('dir', path.join(SESSIONS_ROOT, '--D-dsh-qq-bridge--'));
const PATTERN = /tool input|Messages stream|"type"\s*:\s*"error"|stream error|不可用|失败/i;

function listSessionFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'session.v4.jsonl.zstd') out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

async function readTranscript(file) {
  // 用事件式解压而不是 pipeline：zstd 文件可能是**多帧拼接**（DSH 追加写），
  // pipeline 到这里会以 "The operation was aborted" 收场。
  const bufs = [];
  await new Promise((resolve, reject) => {
    const dec = zlib.createZstdDecompress();
    const src = fs.createReadStream(file);
    src.on('error', reject);
    dec.on('data', (c) => bufs.push(c));
    dec.on('end', resolve);
    dec.on('error', reject);
    src.pipe(dec);
  });
  const text = Buffer.concat(bufs).toString('utf8');
  if (text.trim()) return text;
  // 兜底：单帧同步解压
  return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
}

const roots = ALL ? [SESSIONS_ROOT] : [DIR];
let files = [];
for (const r of roots) files.push(...listSessionFiles(r));
files = files.filter((f) => { try { return fs.statSync(f).mtimeMs >= SINCE; } catch { return false; } });
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

console.log(`会话根目录: ${roots.join(' , ')}`);
console.log(`扫描 ${files.length} 个会话记录（mtime >= ${new Date(SINCE).toLocaleString('zh-CN')}）\n`);

let hits = 0;
for (const f of files) {
  let text = '';
  try { text = await readTranscript(f); } catch (e) { console.log(`⚠ 解压失败 ${path.basename(path.dirname(f))}: ${e.message}`); continue; }
  const lines = text.split('\n').filter(Boolean);
  const matched = [];
  for (const line of lines) {
    if (!PATTERN.test(line)) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    const ts = parsed?.at ?? parsed?.time ?? parsed?.createdAt ?? parsed?.timestamp ?? null;
    const type = parsed?.type ?? parsed?.kind ?? '?';
    const msg = (() => {
      const j = JSON.stringify(parsed ?? line);
      const m = j.match(/"message"\s*:\s*"([^"]{0,300})"/) || j.match(/"error"\s*:\s*"([^"]{0,300})"/);
      return m ? m[1] : j.slice(0, 300);
    })();
    matched.push({ ts, type, msg });
  }
  if (!matched.length) continue;
  hits += matched.length;
  console.log(`── ${path.basename(path.dirname(f))}  (${lines.length} 行, mtime ${fs.statSync(f).mtime.toLocaleString('zh-CN')})`);
  for (const m of matched.slice(-8)) {
    const when = m.ts ? new Date(Number(m.ts) < 1e12 ? Number(m.ts) * 1000 : Number(m.ts)).toLocaleString('zh-CN') : '(无时间)';
    console.log(`   [${when}] ${m.type}: ${m.msg.slice(0, 240)}`);
  }
  console.log('');
}
console.log(hits ? `共 ${hits} 条可疑事件` : '没有匹配到报错事件');
