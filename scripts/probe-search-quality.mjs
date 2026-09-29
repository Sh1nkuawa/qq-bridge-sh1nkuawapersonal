// 诊断搜索质量：分别看 Bing RSS / Bing HTML / 百度 三条链路对同一条中文查询的真实返回
import { spawn } from 'node:child_process';

const QUERY = process.argv[2] || '孙景昊 山东大学 导师 评价';

// ---- 1) 直接看各引擎的原始返回（用 MCP 内部同一套 safeFetch 之外的最简 fetch，仅诊断用）----
async function rawFetch(url, label) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    console.log(`\n=== ${label} ===`);
    console.log(`  HTTP ${res.status}  长度 ${body.length}`);
    // 抽取前几个标题，判断查询有没有被正确使用
    const titles = [...body.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].trim()).slice(0, 3);
    if (titles.length) console.log('  <title>:', titles.join(' | ').slice(0, 200));
    const items = [...body.matchAll(/<item\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].trim()).slice(0, 5);
    if (items.length) console.log('  RSS item 标题:', items.join(' / ').slice(0, 300));
    console.log('  含 b_algo:', body.includes('b_algo'));
    console.log('  片段:', body.replace(/\s+/g, ' ').slice(0, 220));
    return body;
  } catch (error) {
    console.log(`\n=== ${label} ===`);
    console.log('  ❌ 失败:', error?.message ?? error);
    return '';
  }
}

const enc = new URLSearchParams({ q: QUERY }).toString();
await rawFetch(`https://cn.bing.com/search?format=rss&${enc}`, `Bing RSS: ${QUERY}`);
await rawFetch(`https://cn.bing.com/search?${enc}`, `Bing HTML: ${QUERY}`);
await rawFetch(`https://www.baidu.com/s?wd=${encodeURIComponent(QUERY)}`, `百度 HTML: ${QUERY}`);
await rawFetch(`https://cn.bing.com/search?q=${encodeURIComponent('"孙景昊" 山东大学')}`, 'Bing HTML（带引号精确匹配）');

// ---- 2) 走一遍我自己的 MCP 工具，看它最终给了模型什么 ----
console.log('\n=== 我的 MCP web_search 实际返回 ===');
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
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const res = await rpc('tools/call', { name: 'web_search', arguments: { query: QUERY } });
const txt = (res.result?.content ?? []).map((c) => c.text ?? '').join('');
console.log(txt.slice(0, 1200));
child.kill();
process.exit(0);
