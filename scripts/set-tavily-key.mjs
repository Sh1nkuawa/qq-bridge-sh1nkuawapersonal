// 把外部 API 密钥写进 config.json（该文件已在 .gitignore 里，不入库）
// 用法：node scripts/set-tavily-key.mjs <key>   —— 只写 key，不做别的
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const file = path.join(ROOT, 'config.json');

const key = String(process.argv[2] ?? '').trim();
if (!/^tvly-[A-Za-z0-9_-]{10,}$/.test(key)) {
  console.error('密钥格式不像 Tavily key（应以 tvly- 开头）');
  process.exit(1);
}

let raw = fs.readFileSync(file, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const cfg = JSON.parse(raw);
cfg.webSearch = cfg.webSearch && typeof cfg.webSearch === 'object' ? cfg.webSearch : {};
cfg.webSearch.provider = 'tavily';
cfg.webSearch.tavilyApiKey = key;

fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('已写入 config.json → webSearch.tavilyApiKey（' + key.slice(0, 9) + '…' + key.slice(-4) + '）');
console.log('config.json 在 .gitignore 中，不会入库。');
