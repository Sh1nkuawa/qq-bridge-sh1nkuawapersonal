// 唤醒配额/限流的离线回归（2026-11-28 v1.6）
//
// 这段判定的失败方式很"静"：算错了不会报错，只会表现为
//   · 人在群里 @ 它，它却被额度挡住、几十分钟后才回（契约 §10 的事故）
//   · 或者反过来，它自己找话说的唤醒绕过了额度，一晚上刷屏烧 token
// 所以两类都要钉住 ✓

import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_RATE_LIMIT_DEFER_MS,
  HUMAN_WAKE_REASONS,
  isHumanWakeReason,
  normalizeMaxDeferMs,
  rateLimitDecision,
  wakeReasonBase
} from '../src/wake-quota.js';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✅ ${name}`); };

console.log('谁算"人叫它"（不占小时额度）：');

ok('★★ 显式触发全算：@ / 提问 / 叫名字 / 关键词 / 拍一拍 / 指定群友 / 私聊', () => {
  for (const r of ['atMention', 'question', 'nameMention', 'keyword', 'poke', 'speaker', 'private']) {
    assert.equal(isHumanWakeReason(r), true, r);
  }
  assert.equal(HUMAN_WAKE_REASONS.length, 7);
});

ok('★★ 它自己找话说的不算：热聊 / 回复检查 / 概率 / 主动机会 / 超时', () => {
  for (const r of ['hotChat', 'replyCheck', 'probability', 'proactiveCheck', 'timeout', 'subtitleReady']) {
    assert.equal(isHumanWakeReason(r), false, r);
  }
});

ok('★ 带子类型也能认（keyword:猫娘 / speaker:梅川）', () => {
  assert.equal(wakeReasonBase('keyword:猫娘'), 'keyword');
  assert.equal(isHumanWakeReason('keyword:猫娘'), true);
  assert.equal(isHumanWakeReason('speaker:梅川'), true);
  assert.equal(isHumanWakeReason('hotChat:x'), false);
});

console.log('\n撞限流时等多久：');

ok('★ 没撞限流 ⇒ 什么都不做', () => {
  assert.equal(rateLimitDecision({}).action, 'none');
});

ok('★★ 分钟级短等 ⇒ 允许重试（但不能超过上限）', () => {
  const d = rateLimitDecision({ minuteHit: true, waitMs: 30000 });
  assert.equal(d.action, 'wait');
  assert.equal(d.waitMs, 30000);
});

ok('★★ 撞小时额度要等 46 分钟 ⇒ 直接放弃（不许挂僵尸定时器）', () => {
  const d = rateLimitDecision({ hourHit: true, waitMs: 2783000 });
  assert.equal(d.action, 'drop');
  assert.equal(d.reason, 'defer-too-long');
});

ok('★ 重试次数用完 ⇒ 放弃', () => {
  assert.equal(rateLimitDecision({ minuteHit: true, waitMs: 5000, tries: 2 }).action, 'drop');
  assert.equal(rateLimitDecision({ minuteHit: true, waitMs: 5000, tries: 1 }).action, 'wait');
});

ok('★★ 人的唤醒撞小时额度 ⇒ 放行（人叫它就必须答）', () => {
  const d = rateLimitDecision({ hourHit: true, waitMs: 2783000, humanTriggered: true });
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'human-exempt');
  // 但每分钟限流仍然生效（防连打）
  assert.equal(rateLimitDecision({ minuteHit: true, hourHit: true, waitMs: 30000, humanTriggered: true }).action, 'wait');
});

ok('★ 上限可配，但夹在 5s ~ 1h 之间', () => {
  assert.equal(normalizeMaxDeferMs(0), DEFAULT_MAX_RATE_LIMIT_DEFER_MS);
  assert.equal(normalizeMaxDeferMs('abc'), DEFAULT_MAX_RATE_LIMIT_DEFER_MS);
  assert.equal(normalizeMaxDeferMs(1000), 5000);
  assert.equal(normalizeMaxDeferMs(90000), 90000);
  assert.equal(normalizeMaxDeferMs(99999999), 3600000);
});

console.log(`\n全部通过：${n} 项断言组`);
