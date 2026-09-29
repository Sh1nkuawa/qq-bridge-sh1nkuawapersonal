// 用 MCP stdio 协议实测：服务器能否启动、是否列出 qq_get_balance、调用是否返回余额
import { spawn } from 'node:child_process';

const child = spawn('D:/nodejs16/node.exe', ['D:/dsh/qq-bridge/src/mcp-snowluma-safe.js'], {
  cwd: 'D:/dsh/qq-bridge',
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d.toString()));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`${method} 超时`)), 30000);
  });
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1' },
  });
  console.log('✅ initialize OK:', JSON.stringify(init.result?.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log('工具总数:', names.length);
  console.log('含 qq_get_balance:', names.includes('qq_get_balance'));
  const bal = (tools.result?.tools ?? []).find((t) => t.name === 'qq_get_balance');
  if (bal) console.log('  描述:', bal.description);

  const call = await rpc('tools/call', { name: 'qq_get_balance', arguments: {} });
  console.log('\n=== 调用结果 ===');
  console.log(JSON.stringify(call.result, null, 2).slice(0, 600));
} catch (e) {
  console.error('❌ 探测失败:', e.message);
} finally {
  child.kill();
  process.exit(0);
}
