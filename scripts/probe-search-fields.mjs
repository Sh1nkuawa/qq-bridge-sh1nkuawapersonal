// 只打印 web_search 的关键字段（source / relevance / 前几条标题），避免被长 snippet 截断
import { spawn } from 'node:child_process';

const query = process.argv[2] || '孙景昊 山东大学 导师 评价';
const child = spawn('D:/nodejs16/node.exe', ['D:/dsh/qq-bridge/src/mcp-web-search-safe.js'], {
  cwd: 'D:/dsh/qq-bridge', stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
let id = 1;
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (method, params) => {
  const i = id++;
  return new Promise((resolve) => { pending.set(i, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
};
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const res = await rpc('tools/call', { name: 'web_search', arguments: { query } });
const txt = (res.result?.content ?? []).map((c) => c.text ?? '').join('');
let parsed = null;
try { parsed = JSON.parse(txt); } catch { console.log('原始输出:', txt.slice(0, 300)); }
if (parsed) {
  console.log('query     :', parsed.query);
  console.log('source    :', parsed.source);
  console.log('relevance :', parsed.relevance);
  console.log('条数      :', (parsed.results ?? []).length);
  (parsed.results ?? []).slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. ${String(r.title).slice(0, 60)}`);
    console.log(`     ${String(r.url).slice(0, 90)}`);
    console.log(`     ${String(r.snippet ?? '').slice(0, 90)}`);
  });
}
child.kill();
process.exit(0);
