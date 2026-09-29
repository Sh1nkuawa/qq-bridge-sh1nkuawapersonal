// 写入/更新投喂相关配置（config.json 在 .gitignore 里，不入库）
//
// 用法：
//   node scripts/set-afdian-key.mjs <user_id> <token>     # 写爱发电开放平台凭据并启用投喂
//   node scripts/set-afdian-key.mjs --enable              # 只启用（凭据已配好）
//   node scripts/set-afdian-key.mjs --disable             # 关闭投喂接管（消息回到模型处理）
//   node scripts/set-afdian-key.mjs --threshold 20        # 改余额提醒阈值（元）
//   node scripts/set-afdian-key.mjs --daily 5             # 改每人每天第一笔给的好感度
//   node scripts/set-afdian-key.mjs --show                # 只看当前配置（token 打码）
//
// 说明：投喂入口链接**不由机器人发送**（风控考虑），由 owner 人工给要投喂的人。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const file = path.join(ROOT, 'config.json');

let raw = fs.readFileSync(file, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const cfg = JSON.parse(raw);
if (!cfg.socialV2 || typeof cfg.socialV2 !== 'object') cfg.socialV2 = {};
if (!cfg.socialV2.feed || typeof cfg.socialV2.feed !== 'object') cfg.socialV2.feed = {};
const feed = cfg.socialV2.feed;
if (!feed.afdian || typeof feed.afdian !== 'object') feed.afdian = {};

const args = process.argv.slice(2);
const mask = (s) => (s && s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : (s ? '已设置' : '未设置'));

if (!args.length || args[0] === '--show') {
  console.log('当前投喂配置：');
  console.log(`  enabled        = ${feed.enabled === true}`);
  console.log(`  afdian.userId  = ${feed.afdian.userId || '未设置'}`);
  console.log(`  afdian.token   = ${mask(feed.afdian.token)}`);
  console.log(`  dailyAffinity  = ${feed.dailyAffinity ?? '(默认 5)'}`);
  console.log(`  threshold      = ${feed.hungry?.threshold ?? '(默认 20)'}`);
  console.log('  入口链接       = 由你人工发给要投喂的人（机器人不发链接）');
  process.exit(0);
}

let changed = [];
if (args[0] === '--enable') { feed.enabled = true; changed.push('enabled=true'); }
else if (args[0] === '--disable') { feed.enabled = false; changed.push('enabled=false'); }
else if (args[0] === '--threshold') { feed.hungry = { ...(feed.hungry || {}), threshold: Number(args[1]) || 20 }; changed.push(`threshold=${feed.hungry.threshold}`); }
else if (args[0] === '--daily') { feed.dailyAffinity = Math.max(0, Number(args[1]) || 0); changed.push(`dailyAffinity=${feed.dailyAffinity}`); }
else if (args[0] === '--page' || args[0] === '--hint') {
  console.error('入口链接由你人工发给要投喂的人，机器人不发链接，因此不再提供该配置。');
  process.exit(1);
}
else {
  const [userId, token] = args;
  if (!userId || !token) { console.error('用法：node scripts/set-afdian-key.mjs <user_id> <token>'); process.exit(1); }
  feed.afdian.userId = String(userId).trim();
  feed.afdian.token = String(token).trim();
  feed.enabled = true;
  changed.push(`afdian.userId=${feed.afdian.userId}`, `afdian.token=${mask(feed.afdian.token)}`, 'enabled=true');
}

fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('已写入 config.json：' + changed.join('，'));
console.log('config.json 在 .gitignore 中，不会入库。重启桥接后生效。');
