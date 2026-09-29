// 把 SnowLuma 的 OneBot accessToken 同步进 qq-bridge 配置，并实测连接
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BRIDGE_CFG = 'D:/dsh/qq-bridge/config.json';
const SL_CONFIG_DIR = 'D:/dsh/snowluma/config';

// 找到 onebot_<uin>.json
const files = fs.readdirSync(SL_CONFIG_DIR).filter((f) => /^onebot_\d+\.json$/.test(f));
if (!files.length) {
  console.error('[sync] 没找到 SnowLuma 的 onebot_*.json，请先在 WebUI 里配置 OneBot');
  process.exit(1);
}
const slPath = path.join(SL_CONFIG_DIR, files[0]);
const sl = JSON.parse(fs.readFileSync(slPath, 'utf8'));
const uin = files[0].match(/onebot_(\d+)\.json/)[1];

const ws = (sl.networks?.wsServers ?? [])[0] ?? {};
const http = (sl.networks?.httpServers ?? [])[0] ?? {};

const cfg = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'));
const before = {
  wsUrl: cfg.snowluma.wsUrl, httpUrl: cfg.snowluma.httpUrl, token: cfg.snowluma.accessToken,
};

cfg.snowluma.wsUrl = `ws://${ws.host ?? '127.0.0.1'}:${ws.port ?? 3001}${ws.path && ws.path !== '/' ? ws.path : ''}`;
cfg.snowluma.httpUrl = `http://${http.host ?? '127.0.0.1'}:${http.port ?? 3000}${http.path && http.path !== '/' ? http.path : ''}`;
// WS 与 HTTP 的 token 若不同，桥接只能填一个；以 WebSocket 的为准（桥接主链路用它）
cfg.snowluma.accessToken = ws.accessToken ?? http.accessToken ?? '';

fs.writeFileSync(BRIDGE_CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

const mask = (t) => (t ? `${t.slice(0, 2)}***（长度 ${t.length}）` : '(空)');
console.log('[sync] 账号 UIN =', uin);
console.log('[sync] wsUrl        ', before.wsUrl, '→', cfg.snowluma.wsUrl);
console.log('[sync] httpUrl      ', before.httpUrl, '→', cfg.snowluma.httpUrl);
console.log('[sync] accessToken  ', mask(before.token), '→', mask(cfg.snowluma.accessToken));
if (ws.accessToken && http.accessToken && ws.accessToken !== http.accessToken) {
  console.log('[sync] ⚠️ HTTP 与 WS 的 token 不一致，已取 WS 的；若用 HTTP API 需另配');
}

// ---- 实测 OneBot HTTP：get_login_info ----
async function probeHttp() {
  const url = cfg.snowluma.httpUrl.replace(/\/$/, '') + '/get_login_info';
  const headers = cfg.snowluma.accessToken
    ? { Authorization: `Bearer ${cfg.snowluma.accessToken}` }
    : {};
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    console.log(`\n[probe] GET ${url} → HTTP ${res.status}`);
    console.log('[probe] 响应:', body.slice(0, 300));
  } catch (e) {
    console.log('\n[probe] HTTP 探测失败:', e.message);
  }
}

// ---- 实测 OneBot WebSocket ----
function probeWs() {
  return new Promise((resolve) => {
    const { WebSocket } = globalThis;
    if (!WebSocket) {
      console.log('[probe] 当前 Node 无内置 WebSocket，跳过');
      return resolve();
    }
    const url = cfg.snowluma.wsUrl;
    const headers = cfg.snowluma.accessToken
      ? { Authorization: `Bearer ${cfg.snowluma.accessToken}` }
      : {};
    let done = false;
    const finish = (msg) => { if (!done) { done = true; console.log(msg); try { sock.close(); } catch {} resolve(); } };
    let sock;
    try {
      sock = new WebSocket(url, { headers });
    } catch (e) {
      // Node 内置 WebSocket 不支持 headers 时回退
      try { sock = new WebSocket(url); } catch (e2) { return finish(`[probe] WS 连接失败: ${e2.message}`); }
    }
    sock.addEventListener('open', () => finish(`[probe] WS ${url} 连接成功 ✅`));
    sock.addEventListener('error', (e) => finish(`[probe] WS 连接错误（token 不对时会 401）: ${e.message ?? e.type}`));
    sock.addEventListener('close', (e) => finish(`[probe] WS 关闭 code=${e.code ?? '?'}`));
    setTimeout(() => finish('[probe] WS 超时（8s）'), 8000);
  });
}

await probeHttp();
await probeWs();
