// 把 SnowLuma 的 HTTP / WS 两个 token 分别同步到桥接配置
//   snowluma.accessToken -> WS（接收事件用）
//   snowluma.httpToken   -> HTTP API（发送消息用，SnowLuma 允许两端不同）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.json');
const SL = 'D:/dsh/snowluma/config';

const file = fs.readdirSync(SL).find((f) => /^onebot_\d+\.json$/.test(f));
if (!file) { console.error('[sync] 没找到 onebot_*.json'); process.exit(1); }
const sl = JSON.parse(fs.readFileSync(path.join(SL, file), 'utf8'));
const ws = (sl.networks?.wsServers ?? [])[0] ?? {};
const http = (sl.networks?.httpServers ?? [])[0] ?? {};

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
cfg.snowluma.wsUrl = `ws://${ws.host ?? '127.0.0.1'}:${ws.port ?? 3001}${ws.path && ws.path !== '/' ? ws.path : ''}`;
cfg.snowluma.httpUrl = `http://${http.host ?? '127.0.0.1'}:${http.port ?? 3000}${http.path && http.path !== '/' ? http.path : ''}`;
cfg.snowluma.accessToken = ws.accessToken ?? '';
cfg.snowluma.httpToken = http.accessToken ?? '';
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

const mask = (t) => (t ? `${t.slice(0, 4)}***(${t.length})` : '(空)');
console.log('[sync] wsUrl      =', cfg.snowluma.wsUrl);
console.log('[sync] httpUrl    =', cfg.snowluma.httpUrl);
console.log('[sync] accessToken(WS)   =', mask(cfg.snowluma.accessToken));
console.log('[sync] httpToken(HTTP)   =', mask(cfg.snowluma.httpToken));
console.log('[sync] 两端 token 相同吗 :', cfg.snowluma.accessToken === cfg.snowluma.httpToken);

// 实测两端
const both = [
  ['WS 端点', `ws://${ws.host}:${ws.port}`, ws.accessToken],
  ['HTTP 端点', `http://${http.host}:${http.port}/get_login_info`, http.accessToken],
];
for (const [label, url, token] of both) {
  if (!url.startsWith('http')) continue;
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    console.log(`[sync] ${label} → HTTP ${r.status}  ${t.slice(0, 140)}`);
  } catch (e) {
    console.log(`[sync] ${label} → 失败 ${e.message}`);
  }
}
