// 打印 codex.exe 里 refresh_strategy / cache_ttl 附近的完整字符串块，推断配置键名
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const bin = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
const exe = fs.readdirSync(bin).map((d) => path.join(bin, d, 'codex.exe')).find((p) => fs.existsSync(p));
const buf = fs.readFileSync(exe);

function show(needle, before, after) {
  const b = Buffer.from(needle, 'utf8');
  let i = buf.indexOf(b);
  let n = 0;
  while (i !== -1 && n < 3) {
    const seg = buf.subarray(Math.max(0, i - before), Math.min(buf.length, i + after));
    const txt = [...seg].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('');
    console.log(`\n===== ${needle} @ ${i} =====`);
    console.log(txt.replace(/\s{2,}/g, ' '));
    i = buf.indexOf(b, i + b.length);
    n += 1;
  }
  if (n === 0) console.log(`\n[${needle}] 未找到`);
}

show('refresh_strategy', 600, 600);
show('cache_ttl', 300, 300);
show('list_models', 200, 400);
