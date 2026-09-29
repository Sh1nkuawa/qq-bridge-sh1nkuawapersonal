// 探针：当前 src/mcp-snowluma-safe.js 实际注册了哪些工具（按 config.json 的开关过滤后）。
// 用途：确认「生图」这类工具在重启 DSH 后真的进了模型可见的工具清单。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = process.argv[2] || path.join(ROOT, 'src', 'mcp-snowluma-safe.js');
const WANT = process.argv.slice(3);

const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
let buf = '';
let asked = false;
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

child.stderr.on('data', (d) => process.stderr.write(d));

child.stdout.on('data', (d) => {
  buf += d.toString();
  if (!asked && /"id":\s*1/.test(buf)) {
    asked = true;
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  }
  if (!/"id":\s*2/.test(buf)) return;
  const line = buf.split('\n').find((l) => l.includes('"id":2'));
  let names = [];
  try { names = JSON.parse(line).result.tools.map((t) => t.name); } catch { /* 下面报错 */ }
  console.log(`工具总数: ${names.length}`);
  if (WANT.length) {
    for (const n of WANT) console.log(`${names.includes(n) ? '✅' : '❌'} ${n}`);
  } else {
    console.log(names.join(' '));
  }
  child.kill();
  process.exit(0);
});

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
});

setTimeout(() => { console.error('探测超时'); child.kill(); process.exit(1); }, 20000);
