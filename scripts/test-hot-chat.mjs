// 热聊窗口的离线回归（owner 2026-11-26 要求：回复后 5 分钟滑动窗口）
import assert from 'node:assert/strict';
import {
  DEFAULT_HOT_CHAT_WINDOW_MS,
  DEFAULT_HOT_CHAT_MAX_WAKE_PER_MINUTE,
  effectiveMaxWakePerMinute,
  isHotChat,
  nextHotChatUntil,
  normalizeHotChatWindowMs
} from '../src/hot-chat.js';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✅ ${name}`); };

console.log('窗口时长：');

ok('★ 默认 5 分钟；配 0 表示关闭；负数/垃圾值回落默认', () => {
  assert.equal(DEFAULT_HOT_CHAT_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(normalizeHotChatWindowMs(undefined), DEFAULT_HOT_CHAT_WINDOW_MS);
  assert.equal(normalizeHotChatWindowMs('abc'), DEFAULT_HOT_CHAT_WINDOW_MS);
  assert.equal(normalizeHotChatWindowMs(-1), DEFAULT_HOT_CHAT_WINDOW_MS);
  assert.equal(normalizeHotChatWindowMs(0), 0, '0 = 关闭热聊');
  assert.equal(normalizeHotChatWindowMs(60000), 60000);
});

console.log('\n窗口判定：');

ok('★★ 说过话 ⇒ 窗口滑到 now+5min；窗口外的老时间戳不算', () => {
  const now = 1_000_000;
  const until = nextHotChatUntil(now, DEFAULT_HOT_CHAT_WINDOW_MS);
  assert.equal(until, now + DEFAULT_HOT_CHAT_WINDOW_MS);
  assert.equal(isHotChat(until, now + 1000), true);
  assert.equal(isHotChat(until, until), false, '到点即失效（不等下一秒）');
  assert.equal(isHotChat(until, now + DEFAULT_HOT_CHAT_WINDOW_MS + 1), false);
  assert.equal(isHotChat(0, now), false, '从没说过话 ⇒ 不在窗口内');
});

ok('★ 关掉热聊（窗口 0）时永远不在窗口内', () => {
  assert.equal(nextHotChatUntil(1_000_000, 0), 0);
  assert.equal(isHotChat(nextHotChatUntil(1_000_000, 0), 1_000_000), false);
});

ok('★★ 每说一句就往后滑（滑动窗口，不是固定 5 分钟）', () => {
  let now = 1_000_000;
  let until = nextHotChatUntil(now, 300000);
  now += 240000;                      // 4 分钟后又说了一句
  until = nextHotChatUntil(now, 300000);
  assert.equal(isHotChat(until, now + 60000), true, '第 5 分钟时仍在窗口内');
  assert.equal(isHotChat(until, now + 300001), false);
});

console.log('\n热聊期内的限流：');

ok('★★ 热聊期默认放宽到 3/分钟（基础是 1）', () => {
  assert.equal(DEFAULT_HOT_CHAT_MAX_WAKE_PER_MINUTE, 3);
  assert.equal(effectiveMaxWakePerMinute({ hotChat: true, base: 1 }), 3);
  assert.equal(effectiveMaxWakePerMinute({ hotChat: false, base: 1 }), 1, '不在热聊就按原上限');
});

ok('★ 配了 hotChatMaxWakePerMinute 就听配置；0/垃圾值回落默认', () => {
  assert.equal(effectiveMaxWakePerMinute({ hotChat: true, base: 1, hot: 5 }), 5);
  assert.equal(effectiveMaxWakePerMinute({ hotChat: true, base: 1, hot: 0 }), 3);
  assert.equal(effectiveMaxWakePerMinute({ hotChat: true, base: 1, hot: 'x' }), 3);
  assert.equal(effectiveMaxWakePerMinute({ hotChat: true, base: 10 }), 10, '基础值本来就更高就保持');
});

ok('★ 基础值为 0（不限制）时，热聊不会把它变成限制', () => {
  assert.equal(effectiveMaxWakePerMinute({ hotChat: true, base: 0 }), 3);
});

console.log(`\n全部通过：${n} 项断言组`);
