// 只读探活：桥接控制台是否在跑、什么模式、AI 是否暂停、表情包库状态。
// 用法：node scripts/probe-bridge.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = Number(cfg.consolePort) || 3100;
let token = String(cfg.consoleToken || '').trim();
if (!token) {
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}
const base = `http://127.0.0.1:${port}`;

async function call(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-console-token': token, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs || 10000)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
  return { status: res.status, body };
}

try {
  const st = await call('/api/status');
  console.log('== /api/status ==');
  console.log('HTTP', st.status);
  if (st.body && typeof st.body === 'object') {
    console.log(JSON.stringify({
      mode: st.body.mode,
      dshReady: st.body.dshReady,
      socialV2Paused: st.body.socialV2Paused,
      ownerQQ: st.body.ownerQQ,
      allowGroups: st.body.allowGroups,
      allowPrivate: st.body.allowPrivate,
      role: st.body.role
    }, null, 2));
  } else {
    console.log(st.body);
  }
} catch (error) {
  console.log('❌ 桥接控制台不可达：', error?.message ?? error);
  process.exit(1);
}

const probe = await call('/api/socialV2/meme-probe');
console.log('\n== /api/socialV2/meme-probe ==');
console.log('HTTP', probe.status);
console.log(JSON.stringify(probe.body, null, 2));
