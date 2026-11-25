// agy-tools.mjs —— AGY worker 用的"工具"命令（替代 MCP 工具）
//
// 用法：
//   node scripts/agy-tools.mjs memory-list  --key group:123 --category activeTopic
//   node scripts/agy-tools.mjs memory-add   --key group:123 --category activeTopic --content "在聊备孕"
//   node scripts/agy-tools.mjs sticker      --key group:123 --sticker <emoji_id|md5|url>
//   node scripts/agy-tools.mjs voice        --key group:123 --text "晚安" --ja "おやすみ"
//
// 说明：voice 直接复用现成的 /api/tts/speak（合成→发中文→发语音，串行队列），不另写逻辑 ✓

import fs from 'node:fs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const base = 'http://127.0.0.1:3100';
const tok = fs.readFileSync('D:/dsh/qq-bridge/state/console-token', 'utf8').trim();
const u = (p, qs = {}) => {
  const x = new URL(base + p);
  x.searchParams.set('token', tok);
  for (const [k, v] of Object.entries(qs)) if (v != null) x.searchParams.set(k, String(v));
  return x;
};
const post = async (p, body) => {
  const r = await fetch(u(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  return { http: r.status, body: await r.json().catch(() => null) };
};
const get = async (p, qs) => {
  const r = await fetch(u(p, qs), { signal: AbortSignal.timeout(30000) });
  return { http: r.status, body: await r.json().catch(() => null) };
};

const cmd = process.argv[2];
const key = arg('key');
if (!key && cmd !== 'help') { console.error('缺少 --key'); process.exit(2); }

let out;
switch (cmd) {
  case 'memory-list':
    out = await get('/api/agy/memory', { key, category: arg('category') });
    break;
  case 'memory-add': {
    const category = arg('category');
    const content = arg('content');
    if (!category || !content) { console.error('需要 --category 与 --content'); process.exit(2); }
    out = await post('/api/agy/memory', { key, category, content });
    break;
  }
  case 'sticker':
    out = await post('/api/agy/sticker', { key, sticker: arg('sticker') });
    break;
  case 'voice':
    out = await post('/api/tts/speak', { key, text: arg('text'), ja: arg('ja') });
    break;
  default:
    console.log('子命令：memory-list | memory-add | sticker | voice');
    process.exit(0);
}

console.log(JSON.stringify(out.body ?? { http: out.http }, null, 2));
process.exit(out.http >= 400 ? 1 : 0);
