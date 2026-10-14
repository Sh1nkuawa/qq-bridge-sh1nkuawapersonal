// 积压唤醒的离线回归：过期丢弃 + 只补最新（纯函数）+ bridge 接线守卫。
// 事故：2026-10-14 18:35:51 的消息被暂存，18:44:32 才补发，且补的是最早那条。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_BACKLOG_TTL_MS, pickBacklogWake } from '../src/wake-backlog.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

const now = 1_700_000_000_000;
const fresh = (seq, agoMs) => ({ reason: `speaker:某人`, seq, at: now - agoMs });

console.log('积压唤醒的挑选策略：');

ok('空队列 → 不补发', () => {
  assert.deepEqual(pickBacklogWake([], { now }), { pick: null, expired: 0, dropped: 0, total: 0 });
  assert.equal(pickBacklogWake(null, { now }).pick, null);
});

ok('只有一条且没过期 → 补它', () => {
  const r = pickBacklogWake([fresh(8807, 30_000)], { now });
  assert.equal(r.pick.seq, 8807);
  assert.equal(r.dropped, 0);
  assert.equal(r.expired, 0);
});

ok('★多条未过期 → 只补【最新】那条（不再接最旧的话）', () => {
  // 真实事故队列：8807 / 8808 / 8809 三条都在 20 秒内
  const r = pickBacklogWake([fresh(8807, 20_000), fresh(8808, 15_000), fresh(8809, 10_000)], { now });
  assert.equal(r.pick.seq, 8809, '必须挑最新那条');
  assert.equal(r.dropped, 2);
  assert.equal(r.expired, 0);
});

ok('★超过 TTL 的一律丢弃（18:35 的话不该在 18:44 补）', () => {
  // 521 秒 ≈ 8 分 41 秒，正是事故里的延迟
  const r = pickBacklogWake([fresh(8807, 521_000), fresh(8808, 60_000)], { now });
  assert.equal(r.pick.seq, 8808, '过期那条不能补');
  assert.equal(r.expired, 1);
  assert.equal(r.dropped, 0);
});

ok('全部过期 → 一条都不补', () => {
  const r = pickBacklogWake([fresh(1, 999_999), fresh(2, 500_000)], { now });
  assert.equal(r.pick, null);
  assert.equal(r.expired, 2);
});

ok('缺时间戳的老结构按"未过期"兼容处理；坏数据被忽略', () => {
  const r = pickBacklogWake([{ reason: 'old', seq: 10 }, null, 'x', fresh(11, 10_000)], { now });
  assert.equal(r.total, 2, 'null / 字符串被过滤');
  assert.equal(r.pick.seq, 11);
  assert.equal(r.expired, 0, '没有 at 视为未过期');
});

ok('TTL 可配置，且非法值回落默认', () => {
  assert.equal(DEFAULT_BACKLOG_TTL_MS, 120000);
  assert.equal(pickBacklogWake([fresh(1, 40_000)], { now, ttlMs: 10_000 }).pick, null, '自定义 10s → 40s 前那条算过期');
  assert.equal(pickBacklogWake([fresh(1, 40_000)], { now, ttlMs: 0 }).pick?.seq, 1, '非法 ttlMs 回落默认');
});

ok('源码守卫：④⑤①② 四处接线都在，且旧写法已消失', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  // ① 入队带时间戳（两处）
  assert.equal((src.match(/pendingWakeReasons\.push\(\{ reason, seq, at: Date\.now\(\) \}\)/g) ?? []).length, 2);
  // ⑤ 已撤销：等待 baseline 必须保持原样（改它会破坏 qq_wait 契约 / in-flight wait 复检）
  assert.match(src, /const baseline = replyWait && \(v2ToolEnabled\('getUnread'\) \|\| v2ToolEnabled\('getRecent'\)\) \? readThroughSeqV2\(st\) : requestSeq;/);
  assert.ok(!/seenBaseline/.test(src), '⑤ 的 seenBaseline 不应残留');
  // ④ 等待中把积压交给当前回合并清空
  assert.match(src, /等待中交付 \$\{backlogN\} 条积压唤醒给当前回合/);
  assert.match(src, /pendingWakeDelivered: backlogDelivered,/);
  // ①+② 回放走纯函数、不再 shift()
  assert.match(src, /pickBacklogWake\(stEnd\.pendingWakeReasons, \{ ttlMs \}\)/);
  assert.match(src, /DEFAULT_BACKLOG_TTL_MS/);
  assert.ok(!/stEnd\.pendingWakeReasons\.shift\(\)/.test(src), '旧的 shift() 取最早那条必须消失');
});

console.log(`\n全部通过：${n} 项断言组`);
