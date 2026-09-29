// 验证 DSH launch token：GET /?token=XXX 看是否返回 set-cookie
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const base = 'http://127.0.0.1:3080';

const cands = [];
try {
  const t = fs.readFileSync(path.join(home, 'ext-bridge-token'), 'utf8').trim();
  if (t) cands.push(['ext-bridge-token', t]);
} catch {}

// 也扫一遍 .dsh 下可能存 token 的小文件
for (const name of ['.anonymous-user-id', 'settings.yaml', 'ext-bridge-token']) {
  try {
    const p = path.join(home, name);
    const txt = fs.readFileSync(p, 'utf8');
    for (const m of txt.matchAll(/[?&]token=([A-Za-z0-9_-]{16,})/g)) {
      cands.push([`${name}:url-token`, m[1]]);
    }
  } catch {}
}

console.log('候选 token 数:', cands.length);

for (const [label, token] of cands) {
  const url = `${base}/?token=${token}`;
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    await res.body?.cancel();
    console.log(`\n[${label}] HTTP ${res.status}  set-cookie: ${sc ? sc.split(';')[0].slice(0, 60) + '...' : '(无)'}`);
    if (sc) {
      // 用 cookie 试着调一个 API
      const cookie = sc.split(';')[0];
      const r2 = await fetch(`${base}/api/settings/describe`, { headers: { cookie } });
      const body = await r2.text();
      console.log(`   → cookie 调 /api/settings/describe: HTTP ${r2.status}  ${body.slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`\n[${label}] 请求失败: ${e.message}`);
  }
}
