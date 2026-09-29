// 只读：把最近 N 条群消息按时间正序打出来（谁说的、内容、是否引用/带图、是否 @ 机器人）。
// 用法：node scripts/show-recent.mjs [条数] [会话key]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const limit = Math.min(200, Math.max(5, Number(process.argv[2]) || 40));
const key = process.argv[3] || Object.keys(state.conversations ?? {})[0];
const c = state.conversations?.[key];
if (!c) { console.error('没有会话', key); process.exit(1); }
const msgs = (c.recentMessages ?? []).slice(-limit);
console.log(`会话 ${key}｜最近 ${msgs.length} 条（共 ${(c.recentMessages ?? []).length}）｜当前时间 ${new Date().toLocaleString('zh-CN')}\n`);
for (const m of msgs) {
  const t = new Date(Number(m.time) || 0).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const who = m.isSelf ? '【我】' : '[' + (m.sender || m.userId || '?') + ']';
  const tags = [
    m.atSelf ? '@我' : '',
    m.quoteTargetIsSelf ? '引用我' : '',
    m.hasMedia ? `图×${(m.media ?? []).length}` : '',
    m.hasForward ? '转发' : '',
    m.imageAck ? '（生图回执）' : '',
    m.meme ? '（表情包）' : '',
    m.sticker ? '（收藏表情）' : ''
  ].filter(Boolean).join(' ');
  const text = String(m.text ?? m.plain ?? '').replace(/\n/g, ' ⏎ ');
  console.log(`${t} ${who}${tags ? ' <' + tags + '>' : ''} ${text.slice(0, 220)}`);
}
