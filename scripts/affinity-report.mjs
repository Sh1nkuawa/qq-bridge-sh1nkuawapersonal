// 群友好感度报表（只读）：从运行中的桥接拉当前分数，附今日变动与最近原因。
// 用法：node scripts/affinity-report.mjs [group:群号]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
const cfg = readJson(path.join(ROOT, 'config.json'));
const port = Number(cfg.consolePort) || 3100;
let token = String(cfg.consoleToken || '').trim();
if (!token) {
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}
const state = readJson(path.join(ROOT, 'state', 'social-v2.json'));
const key = process.argv[2] || Object.keys(state.conversations ?? {})[0] || 'group:123456789';

const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/affinity?key=${encodeURIComponent(key)}`, {
  headers: { 'x-console-token': token },
  signal: AbortSignal.timeout(15000)
});
const data = await res.json().catch(() => null);
if (!data?.ok) {
  console.error('查询失败：', data?.error ?? res.status, '（桥接没开？可改用 node scripts/affinity-file-admin.mjs show 读状态文件）');
  process.exit(1);
}

const c = data.config ?? {};
const members = [...(data.members ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
const pad = (s, n) => {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
};
const padL = (s, n) => ' '.repeat(Math.max(0, n - pad(s, 0).length + String(s).length)) + String(s);

console.log(`会话 ${key} | 起始 ${c.start} 分，范围 ${c.min}~${c.max}，日上限 ±${c.dailyUp}/${c.dailyDown}，闲置 ${c.decayAfterDays} 天衰减到 ${c.decayTo}`);
console.log(`成员 ${members.length} 人\n`);
console.log(`${padL('分数', 6)} ${pad('档位', 10)} ${pad('语气', 6)} ${pad('今日', 6)} ${pad('闲置', 6)} ${pad('昵称', 6)} ${pad('群名片/昵称', 22)} QQ`);
console.log('-'.repeat(88));
for (const m of members) {
  const score = String(m.score ?? '?');
  const tone = `档${m.tone ?? '?'}`;
  const today = `${(m.todayDelta ?? 0) >= 0 ? '+' : ''}${m.todayDelta ?? 0}`;
  const idle = `${m.idleHours ?? 0}h`;
  const name = m.nickname || m.name || '(未记录)';
  console.log(`${padL(score, 6)} ${pad(m.tier ?? '', 10)} ${pad(tone, 6)} ${pad(today, 6)} ${pad(idle, 6)} ${pad(m.nickname ? '有' : '—', 6)} ${pad(name, 22)} ${m.userId}`);
}

const stateFile = path.join(ROOT, 'state', 'social-v2.json');
const stateSrc = readJson(stateFile);
const stateMembers = stateSrc?.conversations?.[key]?.affinity?.members ?? {};
const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();

// 今日明细按 counters 还原（events 只保留最近 20 条，会被普通发言挤掉，不能当"今天"的依据）。
const todayKeyStr = members[0] && stateMembers?.[members[0].userId]?.dailyDate ? stateMembers[members[0].userId].dailyDate : null;
console.log(`\n今日（${todayKeyStr ?? '今天'}）计分明细：`);
for (const m of members) {
  const sm = stateMembers?.[m.userId] ?? {};
  const day = sm.dailyDate;
  const cnt = (kind) => Number(sm.counters?.[`${day}:${kind}`] ?? 0);
  const parts = [];
  if (cnt('first')) parts.push(`首次互动 +2`);
  if (cnt('attention')) parts.push(`主动找我 +${Math.min(cnt('attention'), 4)}${cnt('attention') > 4 ? `（触发${cnt('attention')}次，封顶4）` : ''}`);
  if (cnt('share')) parts.push(`发图/表情 +${Math.min(cnt('share'), 2)}${cnt('share') > 2 ? `（触发${cnt('share')}次，封顶2）` : ''}`);
  if (cnt('rude')) parts.push(`踩雷 -${Math.min(cnt('rude'), 2) * 2}${cnt('rude') > 2 ? `（触发${cnt('rude')}次，封顶2）` : ''}`);
  if (cnt('spam')) parts.push(`刷屏/复读 -${Math.min(cnt('spam'), 2) * 2}${cnt('spam') > 2 ? `（触发${cnt('spam')}次，封顶2）` : ''}`);
  const events = Array.isArray(sm.events) ? sm.events : [];
  const msgs = events.filter((e) => e.kind === 'message').length;
  const head = `${padL(m.score, 4)}  ${pad(m.nickname || m.name || m.userId, 22)}`;
  const today = `${(m.todayDelta ?? 0) >= 0 ? '+' : ''}${m.todayDelta ?? 0}`;
  console.log(`  ${head} 今日${pad(today, 4)}${parts.length ? '：' + parts.join('，') : '：（今天还没有计分事件）'}`);
}

const owner = cfg.ownerQQ ? members.find((m) => String(m.userId) === String(cfg.ownerQQ)) : null;
console.log(`\n汇总：自己人 ${members.filter((m) => m.tier === '自己人').length} / 熟人 ${members.filter((m) => m.tier === '熟人').length} / 普通群友 ${members.filter((m) => m.tier === '普通群友').length} / 眼熟 ${members.filter((m) => m.tier === '眼熟').length} / 有点烦 ${members.filter((m) => m.tier === '有点烦').length} / 梁子 ${members.filter((m) => m.tier === '梁子').length}`);
if (owner) console.log(`owner(${owner.userId}) 当前 ${owner.score} 分（${owner.tier}，语气档 ${owner.tone}）`);
