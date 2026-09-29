// 通用 MCP 探测：启动一个 stdio MCP 服务，列出工具名，可选调用一次
import { spawn } from 'node:child_process';

const [script, ...rest] = process.argv.slice(2);
const callTool = rest[0] || '';
const callArgs = rest[1] ? JSON.parse(rest[1]) : {};

const child = spawn('D:/nodejs16/node.exe', [script], { cwd: 'D:/dsh/qq-bridge', stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[server stderr] ' + d.toString()));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`${method} 超时`)), 30000);
  });
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
  console.log(`✅ ${script} initialize OK: ${JSON.stringify(init.result?.serverInfo)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`   工具数 ${names.length}: ${names.join(', ')}`);
  if (callTool) {
    const res = await rpc('tools/call', { name: callTool, arguments: callArgs });
    console.log(`   调用 ${callTool} → ${JSON.stringify(res.result).slice(0, 500)}`);
  }
} catch (e) {
  console.error('❌ 探测失败:', e.message);
} finally {
  child.kill();
  process.exit(0);
}
