// 实测 web_fetch 的 HTML 提取效果：用 agent 当时抓失败的页面
import { spawn } from 'node:child_process';

const child = spawn('D:/nodejs16/node.exe', ['D:/dsh/qq-bridge/src/mcp-web-search-safe.js'], {
  cwd: 'D:/dsh/qq-bridge', stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error(method + ' 超时')), 60000);
  });
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const targets = [
  'https://me.sjtu.edu.cn/teacher_directory.html',
  'https://cn.bing.com/search?q=%22%E9%99%88%E6%A0%B9%E8%89%AF%22+%E4%B8%8A%E6%B5%B7%E4%BA%A4%E9%80%9A%E5%A4%A7%E5%AD%A6',
];

for (const url of targets) {
  console.log('\n' + '='.repeat(72));
  console.log('URL:', url);
  try {
    const r = await rpc('tools/call', { name: 'web_fetch', arguments: { url, maxChars: 3000 } });
    const txt = r.result?.content?.[0]?.text ?? JSON.stringify(r.result);
    console.log('返回长度:', txt.length, '  isError:', r.result?.isError ?? false);
    console.log('--- 前 1200 字符 ---');
    console.log(txt.slice(0, 1200));
  } catch (e) {
    console.log('调用失败:', e.message);
  }
}

child.kill();
process.exit(0);
