// 把 SnowLuma 的 OneBot HTTP/WS accessToken 统一成同一个值，并触发配置重载 + 复测
import fs from 'node:fs';
import path from 'node:path';

const SL_DIR = 'D:/dsh/snowluma/config';
const BRIDGE_CFG = 'D:/dsh/qq-bridge/config.json';

const file = fs.readdirSync(SL_DIR).find((f) => /^onebot_\d+\.json$/.test(f));
if (!file) { console.error('没找到 onebot_*.json'); process.exit(1); }
const p = path.join(SL_DIR, file);
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
const ws = (cfg.networks?.wsServers ?? [])[0];
const http = (cfg.networks?.httpServers ?? [])[0];
if (!ws?.accessToken) { console.error('WS 没设 token，请先在 WebUI 里设置'); process.exit(1); }

const mask = (t) => (t ? `${t.slice(0, 2)}***(${t.length})` : '(空)');
const target = ws.accessToken;

console.log('统一前:  http=%s  ws=%s', mask(http?.accessToken), mask(ws.accessToken));

let changed = false;
for (const s of cfg.networks?.httpServers ?? []) {
  if (s.accessToken !== target) { s.accessToken = target; changed = true; }
}
for (const s of cfg.networks?.wsServers ?? []) {
  if (s.accessToken !== target) { s.accessToken = target; changed = true; }
}

if (changed) {
  fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('已写回', path.basename(p), '（备份:', path.basename(p) + '.bak）');
} else {
  console.log('两端 token 已经一致，无需修改');
}

// 同步到桥接配置
const bc = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'));
bc.snowluma.accessToken = target;
fs.writeFileSync(BRIDGE_CFG, JSON.stringify(bc, null, 2) + '\n', 'utf8');
console.log('桥接 config.json 的 accessToken 已同步');

// 触发 SnowLuma 重载：尝试常见管理端点
const bases = ['http://127.0.0.1:5099', 'http://127.0.0.1:3000'];
const paths = ['/api/onebot/reload', '/api/config/reload', '/api/reload', '/set_restart'];
for (const b of bases) {
  for (const ep of paths) {
    try {
      const r = await fetch(b + ep, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target}` },
        body: '{}',
        signal: AbortSignal.timeout(2500),
      });
      if (r.status < 500) {
        console.log(`重载尝试 ${b}${ep} → HTTP ${r.status}`);
      }
    } catch { /* 忽略 */ }
  }
}

// 等待后复测 HTTP
await new Promise((r) => setTimeout(r, 2500));
for (const [label, url, token] of [
  ['HTTP(新token)', 'http://127.0.0.1:3000/get_login_info', target],
  ['HTTP(原HTTPtoken)', 'http://127.0.0.1:3000/get_login_info', http?.accessToken],
]) {
  if (!token) continue;
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
    const t = await r.text();
    console.log(`[复测] ${label} → HTTP ${r.status}  ${t.slice(0, 200)}`);
  } catch (e) {
    console.log(`[复测] ${label} → 失败 ${e.message}`);
  }
}
