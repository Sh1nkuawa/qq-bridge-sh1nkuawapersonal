// 读桥接控制台状态，定位「会话繁忙」的原因
import fs from 'node:fs';

const TOKEN = fs.readFileSync('D:/dsh/qq-bridge/state/console-token', 'utf8').trim();
const BASE = 'http://127.0.0.1:3100';

async function api(pathname, init = {}) {
  const r = await fetch(BASE + pathname, {
    ...init,
    headers: {
      'content-type': 'application/json',
      cookie: `console_token=${TOKEN}`,
      'x-console-token': TOKEN,
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const t = await r.text();
  return { status: r.status, text: t };
}

// 试出正确的鉴权方式：先看 /api/status
for (const [label, headers] of [
  ['query token', {}],
]) {
  const r = await api(`/api/status?token=${TOKEN}`, { headers });
  console.log(`[status] HTTP ${r.status}`);
  try {
    const j = JSON.parse(r.text);
    console.log(JSON.stringify(j, null, 2).slice(0, 2000));
  } catch {
    console.log(r.text.slice(0, 300));
  }
}

// socialV2 状态（含每个会话的 busy / pending）
for (const ep of ['/api/socialV2/state', '/api/socialV2/states', '/api/sessions', '/api/pending']) {
  const r = await api(`${ep}?token=${TOKEN}`);
  console.log(`\n[${ep}] HTTP ${r.status}`);
  console.log(r.text.slice(0, 1500));
}
