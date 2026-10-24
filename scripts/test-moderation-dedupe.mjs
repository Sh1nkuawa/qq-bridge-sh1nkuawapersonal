// 2026-10-20 事故回归：同一条消息被重复投递 100 次 ⇒ 刷屏判定数到 50 次 ⇒ 误禁言群友
// 修复两层：① 判定器按 messageId 去重后再计数；② 入库/加载时按 messageId 去重。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectRepeat } from '../src/moderation.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

const now = Date.now();
const mk = (over = {}) => ({
  messageId: 'm1', seq: 1, userId: '2361801929', sender: '梅川 卿头',
  text: '你只是怕了', plain: '你只是怕了', time: now - 5000, isSelf: false, ...over
});

console.log('判定器（治标但关键）：');

ok('★ 同一条消息被记 100 遍 ⇒ 只算 1 次，不触发刷屏', () => {
  // 复刻事故现场：100 条记录，messageId 全一样，seq 各不相同
  const dup = Array.from({ length: 100 }, (_, i) => mk({ seq: i + 1 }));
  const r = detectRepeat(dup, { now, cfg: { windowMs: 120000, sameTextCount: 5, sameImageCount: 3, minTextChars: 1 } });
  assert.equal(r.hit, false, '★ 不能因为重复投递而误判刷屏');
});

ok('真人真的连发 5 条（不同 messageId）⇒ 仍然要命中', () => {
  const real = Array.from({ length: 5 }, (_, i) => mk({ messageId: `real-${i}`, seq: i + 1, time: now - 3000 + i }));
  const r = detectRepeat(real, { now, cfg: { windowMs: 120000, sameTextCount: 5, sameImageCount: 3, minTextChars: 1 } });
  assert.equal(r.hit, true, '真的刷屏必须还能抓到');
  assert.equal(r.kind, 'text');
  assert.equal(r.count, 5);
  assert.equal(r.senderId, '2361801929');
});

ok('图片同理：同一张图重复记录只算 1 次', () => {
  const sameImage = Array.from({ length: 50 }, (_, i) => ({
    ...mk({ messageId: 'img-1', seq: i + 1 }),
    text: '[图片]', plain: '[图片]', media: [{ kind: 'image', url: 'https://gchat.qpic.cn/x.jpg', file: 'x.jpg' }]
  }));
  const r = detectRepeat(sameImage, { now, cfg: { windowMs: 120000, sameTextCount: 5, sameImageCount: 3, minTextChars: 1 } });
  assert.equal(r.hit, false, '同一张图被记 50 遍不能算刷屏');
});

console.log('\n入库/加载去重（治因）：');

ok('★ recordIncomingV2 与状态加载都按 messageId 去重（源码守卫）', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /function dedupeRecentByMessageId\(list\)/, '要有去重函数');
  assert.match(bridge, /recentMessages: dedupeRecentByMessageId\(/, '加载时要自愈 recentMessages');
  assert.match(bridge, /unread: dedupeRecentByMessageId\(/, '加载时要自愈 unread');
  assert.match(bridge, /忽略重复投递（messageId=/, '入库时要跳过重复投递');
  assert.match(bridge, /seq 是每次入库自增的，拿它去重没用/, '注释要写明"不能用 seq 去重"这个坑');
});

ok('去重语义：保留第一条，无 messageId 的保留，顺序不变', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  // 这段是纯函数，直接 eval 出来测（避免为它导出一个内部函数）
  const m = bridge.match(/function dedupeRecentByMessageId\(list\) \{[\s\S]*?\n\}/);
  assert.ok(m, '找不到函数体');
  const fn = new Function(`${m[0]}; return dedupeRecentByMessageId;`)();
  const out = fn([
    { messageId: 'a', v: 1 }, { messageId: 'b', v: 2 }, { messageId: 'a', v: 3 },
    { v: 4 }, { v: 5 }
  ]);
  assert.deepEqual(out.map((x) => x.v), [1, 2, 4, 5]);
});


console.log('\n语音 vs 图片（2026-10-24 误禁言事故）：');

ok('★ 5 条内容不同的语音不能被判"同图/同文本"', () => {
  const now = Date.now();
  const msgs = Array.from({ length: 5 }, (_, i) => ({
    messageId: 9000 + i, userId: 'u1', sender: '甲', time: now - i * 1000,
    plain: '[语音]', text: '[语音]', hasMedia: true, media: [{ type: 'voice' }]
  }));
  const r = detectRepeat(msgs, { now });
  assert.equal(r.hit, false, '语音不该被当成重复刷屏');
});

ok('★ 5 张相同图片仍然要判"同图"（原功能不能丢）', () => {
  const now = Date.now();
  const msgs = Array.from({ length: 5 }, (_, i) => ({
    messageId: 9100 + i, userId: 'u2', sender: '乙', time: now - i * 1000,
    plain: '[图片]', text: '[图片]', hasMedia: true, media: [{ type: 'image' }]
  }));
  const r = detectRepeat(msgs, { now });
  assert.equal(r.hit, true, '5 张同图应该命中');
});

ok('★ 5 条内容不同的语音转录（有文字）也不该命中', () => {
  const now = Date.now();
  const msgs = Array.from({ length: 5 }, (_, i) => ({
    messageId: 9200 + i, userId: 'u3', sender: '丙', time: now - i * 1000,
    plain: ['今天好热', '吃了没', '我在路上了', '晚上打游戏吗', '先睡了我'][i], hasMedia: true, media: [{ type: 'voice' }]
  }));
  const r = detectRepeat(msgs, { now });
  assert.equal(r.hit, false);
});

console.log(`\n全部通过：${n} 项断言组`);
