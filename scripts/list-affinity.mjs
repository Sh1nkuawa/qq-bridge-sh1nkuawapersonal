// list-affinity.mjs —— 只读列出某个会话的**全员好感度**（owner 巡检 / 回答"现在大家多少分"用）
//
// 用途
//   1) owner 想看当前所有群友的好感度排名（不必去控制台翻面板，也不用让 AI 说话）；
//   2) 排查"某人是不是被扣分了 / 今天涨了多少"这类问题。
//
// 数据源（**只读**，绝不写状态）
//   state/social-v2.json → conversations[<key>].affinity.members
//   档位判定复用 src/affinity.js 的 tierOf()，与唤醒提示词、控制台里的口径完全一致，
//   不另写一套阈值（否则改了分档线这里会悄悄说谎）。
//
// 用法
//   node scripts/list-affinity.mjs                    # 默认取 config.json 白名单里的第一个群
//   node scripts/list-affinity.mjs group:123456789    # 指定会话
//
// 输出列
//   分数     当前的印象分（起始 40，可负）
//   档位     自己人 ≥300 / 熟人 ≥100 / 普通群友 ≥40 / 眼熟 ≥0 / 有点烦 <0 / 梁子 ≤-50
//   今天     当日净变动（state 里的 dailyDelta，受每日上限约束，所以通常只有 ±2~6）
//   最近互动 lastInteractAt（最后一次说话/被记分的时间）
//   末尾另附"印象备注"（memberImpressions）与档位人数统计。
//
// 注意
//   · 好感度是**内部状态**：机器人任何情况下都不在群里公布分数或排名（见群公告"相处方式"一节）。
//     这个脚本是给 owner 看的，输出别直接贴到群里。
//   · 名字取自成员自身的 name，缺失时回落到最近消息里的 senderName；两者都没有就显示 (未知)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierOf, mergeAffinityConfig } from '../src/affinity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const key = process.argv[2] || `group:${(cfg.allow?.groups ?? [])[0] ?? ''}`;

const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const conv = state?.conversations?.[key] ?? {};
const members = conv.affinity?.members ?? {};
const ac = mergeAffinityConfig(cfg.socialV2?.affinity);

// 名字来源：最近消息里的 senderName（affinity 里多数只存 userId）
const nameOf = new Map();
for (const m of conv.recentMessages ?? []) {
  if (m?.isSelf) continue;
  const id = String(m?.userId ?? '');
  if (id && m?.senderName && !nameOf.has(id)) nameOf.set(id, String(m.senderName));
}
const noteOf = new Map();
for (const [id, imp] of Object.entries(conv.memberImpressions ?? {})) {
  const t = typeof imp === 'string' ? imp : (imp?.content ?? imp?.text ?? '');
  if (t) noteOf.set(String(id), String(t));
}

const rows = Object.entries(members).map(([userId, m]) => {
  const score = Number(m?.score ?? 0);
  return {
    userId,
    score,
    tier: tierOf(score, ac),
    name: m?.name || nameOf.get(userId) || '',
    lastAt: Number(m?.lastInteractAt ?? 0),
    lastScoreAt: Number(m?.lastScoreAt ?? 0),
    today: Number(m?.dailyDelta ?? 0),
    day: String(m?.dailyDate ?? ''),
    note: noteOf.get(userId) ?? '',
  };
}).sort((a, b) => b.score - a.score);

const when = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
console.log(`会话 ${key}　共 ${rows.length} 人　起始 ${ac.start}　量程 ${ac.min} ~ ${ac.max}`);
console.log(`今天（${rows[0]?.day || '-'}）的变动已计入 dailyDelta 一列\n`);
console.log('＃  分数  档位      今天   群友                  用户ID             最近互动');
console.log('─'.repeat(96));
rows.forEach((r, i) => {
  const tier = (r.tier.label + '　'.repeat(3)).slice(0, 9);
  const name = (r.name || '(未知)').padEnd(18, '　').slice(0, 18);
  const today = (r.today > 0 ? '+' : '') + String(r.today);
  console.log(`${String(i + 1).padStart(2)}  ${String(r.score).padStart(4)}  ${tier}  ${today.padStart(4)}  ${name}  ${String(r.userId).padEnd(15)}  ${when(r.lastAt)}`);
});

const withNote = rows.filter((r) => r.note);
if (withNote.length) {
  console.log('\n印象备注（仅 owner 可见）：');
  for (const r of withNote) console.log(`  · ${r.name || r.userId}：${r.note.slice(0, 120)}`);
}
const LABELS = { inner: '自己人', close: '熟人', normal: '普通群友', familiar: '眼熟', bother: '有点烦', grudge: '梁子' };
console.log('\n统计：' + Object.entries(LABELS)
  .map(([k, label]) => `${label} ${rows.filter((r) => r.tier.key === k).length}`)
  .join('　｜　'));
