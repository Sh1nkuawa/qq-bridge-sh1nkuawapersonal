// 爱发电凭据自检：验证 token 是否有效 + 拉一页历史订单（订单号脱敏，不回显 token）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAfdianOrder, afdianSign } from '../src/feed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const feed = cfg?.socialV2?.feed ?? {};
const { userId, token, apiBases } = feed.afdian ?? {};
const mask = (s) => (s && s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : String(s ?? ''));

console.log(`凭据：user_id=${userId}  token=${mask(token)}  enabled=${feed.enabled === true}`);
if (!userId || !token) { console.error('config.json 里没有爱发电凭据'); process.exit(1); }

// 1) 用一个肯定不存在的订单号试签名是否被接受
const bogus = '99999999999999999999999999';
const r = await verifyAfdianOrder({ userId, token, orderNo: bogus, apiBases });
console.log(`\n[1] 假订单号探测：ok=${r.ok} exists=${r.exists} err=${r.error ?? '（无，签名被接受）'}`);
if (/no valid token|ec=400/.test(String(r.error))) {
  console.log('    ⚠️ 签名/凭据可能有问题，看上面的 ec 与 em');
} else {
  console.log('    ✅ 签名与凭据被接受（返回的是"订单不存在"而不是"token 无效"）');
}

// 2) 拉一页历史订单，确认真实数据结构与我们的字段解析
const base = (Array.isArray(apiBases) && apiBases[0]) || 'https://afdian.com';
const params = JSON.stringify({ page: 1 });
const ts = Math.floor(Date.now() / 1000);
const sign = afdianSign(token, userId, params, ts);
const res = await fetch(`${base}/api/open/query-order`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: userId, params, ts, sign }),
  signal: AbortSignal.timeout(20000)
});
const body = await res.json().catch(() => null);
console.log(`\n[2] 历史订单页（${base}）：HTTP ${res.status}  ec=${body?.ec}  em=${body?.em ?? ''}`);
const list = Array.isArray(body?.data?.list) ? body.data.list : [];
console.log(`    第 1 页共 ${list.length} 条，total_count=${body?.data?.total_count ?? '?'}`);
for (const o of list.slice(0, 5)) {
  const no = String(o.out_trade_no ?? '');
  console.log(`    - ${no.slice(0, 4)}…${no.slice(-4)}  ¥${o.total_amount ?? o.show_amount ?? '?'}  status=${o.status}  plan=${String(o.plan_id ?? '').slice(0, 8)}…  remark=${String(o.remark ?? '').slice(0, 20)}`);
}
if (!list.length) console.log('    （这个账号还没有任何订单：群友付第一笔之后才会有）');
