// 隔离测试：用配置里的 cookie 分别走 raw fetch 和 NodeApiClient，看差在哪
import fs from 'node:fs';
import { NodeApiClient } from '../src/dsh-client.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const base = cfg.dsh.baseUrl;
const cookie = cfg.dsh.authCookie || '';
console.log('baseUrl   :', base);
console.log('cookie 长度:', cookie.length, ' 名字:', cookie.split('=')[0]);
console.log('token     :', cfg.dsh.authToken ? '已配置' : '空');

// --- A) raw fetch ---
for (const ep of ['/api/settings/describe', '/api/agentPresets/list']) {
  const r = await fetch(base + ep, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  const t = await r.text();
  console.log(`\n[A raw] POST ${ep} → ${r.status}  ${t.slice(0, 120).replace(/\s+/g, ' ')}`);
}

// --- B) NodeApiClient（与桥接同路径）---
const api = new NodeApiClient(base, undefined, {
  token: cfg.dsh.authToken,
  cookie,
});
try {
  const res = await api.callUnary?.('settings/describe', {}) ?? null;
  console.log('\n[B client] callUnary ok:', JSON.stringify(res).slice(0, 200));
} catch (e) {
  console.log('\n[B client] callUnary 失败:', e.message);
}

// --- C) 看 client 内部 cookie 是否设置成功 ---
try {
  const c = await api.ensureAuth();
  console.log('\n[C] ensureAuth() 返回:', String(c).slice(0, 60), '… 长度', String(c).length);
  console.log('[C] 与配置一致:', String(c) === cookie);
} catch (e) {
  console.log('\n[C] ensureAuth 失败:', e.message);
}
process.exit(0);
