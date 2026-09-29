// 投喂账本命令行（HTTP 调桥接接口，UTF-8 安全，别用 PowerShell 发中文）
// 用法：
//   node scripts/feed-admin.mjs list                 # 汇总 + 最近订单（订单号脱敏）
//   node scripts/feed-admin.mjs csv > feed.csv       # 导出完整 CSV（含完整订单号，给对账用）
//   node scripts/feed-admin.mjs add <QQ> "<昵称>" <金额> [订单号]   # 手工补录（如微信直转）
//   node scripts/feed-admin.mjs remove <订单号>       # 撤销一笔（退款/误记）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:3100';

function consoleToken() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (c.consoleToken) return String(c.consoleToken);
  } catch { /* 落到文件 */ }
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}
const headers = { 'content-type': 'application/json', 'x-console-token': consoleToken() };
const [action, ...rest] = process.argv.slice(2);

if (!action || action === 'list') {
  const res = await fetch(`${base}/api/socialV2/feed`, { headers });
  const j = await res.json();
  if (!j.ok) { console.error('查询失败:', j.error); process.exit(1); }
  console.log(`投喂通道：${j.enabled ? '已启用' : '未启用（需配 config.json → socialV2.feed）'}   爱发电凭据：${j.config.afdianConfigured ? '已配置' : '未配置'}`);
  console.log(`权益：每人每天第一笔 +${j.config.dailyAffinity} 好感度（绕过日封顶）   余额提醒阈值：¥${j.config.threshold}`);
  console.log(`累计：${j.totals.count} 笔 / ¥${j.totals.amount}`);
  if (j.members?.length) {
    console.log('\n按人汇总：');
    for (const m of j.members) {
      console.log(`  ¥${String(m.amount).padStart(7)}  ${String(m.count)} 笔  ${m.name || m.userId}(${m.userId})  最近 ${m.lastAtText}`);
    }
  }
  if (j.orders?.length) {
    console.log('\n最近订单（订单号已脱敏，完整号用 csv 导出）：');
    for (const o of j.orders.slice(0, 20)) {
      console.log(`  ${o.atText}  ¥${String(o.amount).padStart(6)}  ${o.name || o.userId}  ${o.orderNo}  status=${o.status ?? '-'}`);
    }
  }
  if (j.alerts?.hungryAt) console.log(`\n上次余额提醒：${new Date(j.alerts.hungryAt).toLocaleString('sv')}`);
  process.exit(0);
}

if (action === 'csv') {
  const res = await fetch(`${base}/api/socialV2/feed?csv=1`, { headers });
  process.stdout.write(await res.text());
  process.exit(0);
}

if (action === 'add') {
  const [userId, name, amount, orderNo] = rest;
  if (!userId || !amount) { console.error('用法：add <QQ> "<昵称>" <金额> [订单号]'); process.exit(1); }
  const res = await fetch(`${base}/api/socialV2/feed`, { method: 'POST', headers, body: JSON.stringify({ action: 'add', userId, name, amount: Number(amount), orderNo }) });
  console.log(JSON.stringify(await res.json(), null, 2));
  process.exit(0);
}

if (action === 'remove') {
  const [orderNo] = rest;
  if (!orderNo) { console.error('用法：remove <订单号>'); process.exit(1); }
  const res = await fetch(`${base}/api/socialV2/feed`, { method: 'POST', headers, body: JSON.stringify({ action: 'remove', orderNo }) });
  console.log(JSON.stringify(await res.json(), null, 2));
  process.exit(0);
}

console.log('用法：list | csv | add <QQ> "<昵称>" <金额> [订单号] | remove <订单号>');
