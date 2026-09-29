// 在 codex.exe 里找 "refresh_strategy" 附近的字符串，看有没有可配置项/环境变量能跳过联网刷新模型列表
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const bin = fs.readdirSync(path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'))
  .map((d) => path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', d, 'codex.exe'))
  .find((p) => fs.existsSync(p));
console.log('二进制:', bin);
const buf = fs.readFileSync(bin);
console.log('大小:', (buf.length / 1048576).toFixed(1), 'MB');

const needles = ['refresh_strategy', 'list_models', 'model_list', 'models_refresh', 'offline', 'CODEX_MODEL'];
for (const needle of needles) {
  const b = Buffer.from(needle, 'utf8');
  let i = 0;
  const hits = [];
  while ((i = buf.indexOf(b, i)) !== -1 && hits.length < 6) { hits.push(i); i += b.length; }
  if (!hits.length) { console.log(`\n[${needle}] 未出现`); continue; }
  console.log(`\n[${needle}] ${hits.length} 处，上下文:`);
  for (const off of hits) {
    // 往前找 60 字节、往后 140 字节，抽出可打印 ASCII
    const seg = buf.subarray(Math.max(0, off - 60), Math.min(buf.length, off + 140));
    const txt = [...seg].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
    console.log('   ' + txt.replace(/\.{3,}/g, ' | '));
  }
}
