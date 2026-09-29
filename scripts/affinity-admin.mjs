// 用 Node 调好感度接口（原生 UTF-8，避免 PowerShell 5.1 的 -Body 编码坑）
// 用法：node scripts/affinity-admin.mjs list
//       node scripts/affinity-admin.mjs set <userId> <name> <score>
//       node scripts/affinity-admin.mjs remove <userId>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY = process.env.QQ_GROUP ? `group:${process.env.QQ_GROUP}` : 'group:123456789'; // 真实群号用 QQ_GROUP=xxx 传入

function consoleToken() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (c.consoleToken) return String(c.consoleToken);
  } catch { /* 落到文件 */ }
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

const base = 'http://127.0.0.1:3100';
const headers = { 'content-type': 'application/json', 'x-console-token': consoleToken() };
const [action, ...rest] = process.argv.slice(2);

if (action === 'list' || !action) {
  const res = await fetch(`${base}/api/socialV2/affinity?key=${encodeURIComponent(KEY)}`, { headers });
  const data = await res.json();
  if (!data.ok) { console.log('查询失败:', data.error); process.exit(1); }
  console.log(`配置：起始 ${data.config.start}  范围 ${data.config.min}~${data.config.max}  日涨跌上限 ±${data.config.dailyUp}/${data.config.dailyDown}  衰减 闲置${data.config.decayAfterDays}天→${data.config.decayTo}`);
  console.log(`成员 ${data.members.length} 人：`);
  for (const m of data.members) {
    const idle = m.idleHours == null ? '从未互动' : `${m.idleHours}h 前`;
    console.log(`  ${String(m.score).padStart(4)}  ${m.tier.padEnd(5)} 语气档${m.tone}  ${m.name}(${m.userId})  今日${m.todayDelta >= 0 ? '+' : ''}${m.todayDelta}  ${idle}${m.nickname ? `  外号:${m.nickname}` : ''}`);
  }
  process.exit(0);
}

if (action === 'set') {
  const [userId, name, score] = rest;
  const res = await fetch(`${base}/api/socialV2/affinity`, { method: 'POST', headers, body: JSON.stringify({ key: KEY, userId, name, score: Number(score) }) });
  console.log(JSON.stringify(await res.json()));
  process.exit(0);
}

if (action === 'remove') {
  const [userId] = rest;
  if (!userId) { console.error('用法：remove <QQ>'); process.exit(1); }
  const res = await fetch(`${base}/api/socialV2/affinity`, { method: 'POST', headers, body: JSON.stringify({ key: KEY, userId, action: 'remove' }) });
  console.log(JSON.stringify(await res.json()));
  process.exit(0);
}

if (action === 'reset') {
  // 全部重置回起始分（默认 40）：分数 + 今日额度 + 计数器 + 事件记录一起清
  if (!rest.includes('--yes') && !rest.includes('-y')) {
    console.error('这会把【所有群友】的好感度重置回起始分，并清空今日额度与计数器。');
    console.error('确认请加 --yes：node scripts/affinity-admin.mjs reset --yes');
    process.exit(1);
  }
  const res = await fetch(`${base}/api/socialV2/affinity`, { method: 'POST', headers, body: JSON.stringify({ key: KEY, action: 'reset-all' }) });
  console.log(JSON.stringify(await res.json()));
  process.exit(0);
}

console.log('用法：list | set <QQ> "<名字>" <分数> | remove <QQ> | reset --yes');
