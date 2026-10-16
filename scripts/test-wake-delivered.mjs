// "交付给当前回合的积压唤醒没被接住 → 回合结束要重排" 的源码守卫
// 事故（2026-10-16 15:06，群里）：群友发卡片并 @ 机器人，字幕其实已经取好并缓存 ✓，
// 但那一轮是在卡片到达**之前**就开始的（15:05:29 probability 唤醒），提示里没有字幕 ✗；
// 随后 @ 唤醒被"交付给当前回合"，而那个回合正在收尾 ⇒ 交付后它一句话都没再说 ⇒ @ 被丢掉 ✗。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

console.log('交付 ≠ 被处理：');
ok('交付积压唤醒时要记下"交付时刻"（否则无从判断有没有被接住）', () => {
  assert.match(bridge, /st\.deliveredBacklog = \{/, '交付时必须落 deliveredBacklog');
  assert.match(bridge, /at: Date\.now\(\)/, '要记交付时刻');
});

ok('回合结束要按"此后有没有新发言"判断，没接住就重排一次唤醒', () => {
  assert.match(bridge, /stEnd\.deliveredBacklog/, '回合结束要检查它');
  assert.match(bridge, /lastAiReplyAt\) >= Number\(db\.at\)/, '判据是"交付之后有没有新发言"');
  assert.match(bridge, /没被接住.*重新排一次/s, '没接住要重排');
  assert.match(bridge, /scheduleWakeV2\(key, db\.reason/, '重排要用当时那条唤醒原因');
});

ok('与原有"积压队列回放"不能互相打架（同一回合不要排两次唤醒）', () => {
  assert.match(bridge, /let scheduled = false;/, '要有互斥标记');
  assert.match(bridge, /if \(!scheduled && Array\.isArray\(stEnd\.pendingWakeReasons\)/, '原回放要受它约束');
  assert.match(bridge, /pickBacklogWake\(stEnd\.pendingWakeReasons/, '原有回放逻辑仍在');
});

ok('★ 字幕来得太晚（本轮已开始）→ 无条件补一轮，不能用"有没有发言"来判断', () => {
  // 2026-10-16 实测：15:13:58 卡片到、字幕同一秒备好，那一轮却回"没拿到字幕"；
  // 而"交付后有没有新发言"会误判成"接住了"（它说话了，但说的是"没拿到"）。
  assert.match(bridge, /pendingSubtitleWake/, '要记录"字幕来得太晚"');
  assert.match(bridge, /biliTurnActive\?\.\(key\)/, '判据必须走"有没有在途回合"的探针');
  assert.match(bridge, /需要补一轮，重新排唤醒/, '回合结束要无条件补一轮');
  assert.match(bridge, /if \(pendingSubtitleWake\.has\(key\)\) \{/, '补一轮要在回合结束处执行');
});

ok('★ 模块级函数里不许裸用闭包变量（pendingWakeKeys 那次就是这么炸的）', () => {
  // 2026-10-16：先写了 `if (pendingWakeKeys.has(key))` —— pendingWakeKeys 声明在闭包内，
  // 模块级的 prefetchBilibiliLinks 拿不到 ⇒ ReferenceError ⇒ 被那里的 try/catch 吞成
  // "B 站字幕异常"（字幕进没进得去先不说，"字幕来得太晚"的标记压根没记上 ⇒ 补一轮永不触发）。
  assert.ok(!/pendingSubtitleWake[\s\S]{0,200}pendingWakeKeys\.has/.test(bridge),
    '★ 不许在模块级函数里直接引用闭包里的 pendingWakeKeys');
  assert.match(bridge, /let biliTurnActive = null;/, '要有模块级探针');
  assert.match(bridge, /biliTurnActive = \(k\) => pendingWakeKeys\.has\(k\)/, '主闭包里注册探针');
});

console.log(`\n全部通过：${n} 项断言组`);
