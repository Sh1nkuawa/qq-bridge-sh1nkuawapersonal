// 测 web_search 的实际返回
import { spawn } from 'node:child_process';
const child = spawn('D:/nodejs16/node.exe', ['D:/dsh/qq-bridge/src/mcp-web-search-safe.js'],
  { cwd: 'D:/dsh/qq-bridge', stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const pending = new Map(); let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString('utf8'); let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error('超时')), 60000);
  });
}
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const queries = ['陈根良 上海交通大学', '杀戮尖塔2 新卡'];
for (const q of queries) {
  console.log('\n' + '='.repeat(60));
  console.log('query:', q);
  try {
    const r = await rpc('tools/call', { name: 'web_search', arguments: { query: q } });
    const t = r.result?.content?.[0]?.text ?? '';
    console.log('长度:', t.length, ' isError:', r.result?.isError ?? false);
    console.log(t.slice(0, 900));
  } catch (e) { console.log('失败:', e.message); }
}
child.kill(); process.exit(0);
