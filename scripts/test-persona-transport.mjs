// 按人格分流传输层（小鲸鱼→DSH，猫娘→AGY）的离线回归
//
// 这段判定决定"这一轮花不花 API 钱"。错了**不会报错**：要么默默多花钱（该走 AGY 的走了 DSH），
// 要么默默不生效（配了 dsh 却还在 enqueue turn）。所以要钉住 ✓

import assert from 'node:assert/strict';
import {
  AGY_DEGRADE_MS,
  AGY_INFRA_REQUEUE_REASONS,
  TRANSPORTS,
  isDegraded,
  normalizePersonaTransport,
  personaRoutingTable,
  resolvePersonaTransport,
  shouldDegradeToDsh
} from '../src/persona-transport.js';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✅ ${name}`); };

const PERSONAS = {
  小鲸鱼: { provider: 'deepseek-official', model: 'deepseek-flash', transport: 'dsh' },
  猫娘侍从: { provider: 'google', model: 'gemini-4-hydrogen', transport: 'agy' }
};

console.log('规范化：');

ok('只认 dsh / agy，大小写与空白都容忍', () => {
  assert.deepEqual(TRANSPORTS, ['dsh', 'agy']);
  assert.equal(normalizePersonaTransport('DSH'), 'dsh');
  assert.equal(normalizePersonaTransport(' agy '), 'agy');
  assert.equal(normalizePersonaTransport('worker'), '');
  assert.equal(normalizePersonaTransport(undefined), '');
  assert.equal(normalizePersonaTransport({}), '');
});

console.log('\n解析：');

ok('★★ 全局 agy + persona 写 dsh ⇒ 走 DSH（这就是"小鲸鱼交给 DSH"）', () => {
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: PERSONAS, persona: '小鲸鱼' }), 'dsh');
});

ok('★★ 全局 agy + persona 写 agy ⇒ 走 AGY（猫娘）', () => {
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: PERSONAS, persona: '猫娘侍从' }), 'agy');
});

ok('★ 全局 dsh ⇒ 一律 DSH（persona 写 agy 也不越过全局开关）', () => {
  assert.equal(resolvePersonaTransport({ globalTransport: 'dsh', personas: PERSONAS, persona: '猫娘侍从' }), 'dsh');
  assert.equal(resolvePersonaTransport({ globalTransport: 'dsh', personas: null, persona: '小鲸鱼' }), 'dsh');
});

ok('★ 没配 persona / persona 没写 transport ⇒ 跟随全局', () => {
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: null, persona: '小鲸鱼' }), 'agy');
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: { 小鲸鱼: { model: 'x' } }, persona: '小鲸鱼' }), 'agy');
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: PERSONAS, persona: '没这个人' }), 'agy');
});

ok('★ 配置垃圾值不许污染判定（写错 = 没配 = 跟随全局）', () => {
  const weird = { 小鲸鱼: { transport: 'DSH ' }, 猫娘侍从: { transport: 'worker' } };
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: weird, persona: '小鲸鱼' }), 'dsh');
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: weird, persona: '猫娘侍从' }), 'agy');
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: { 小鲸鱼: 'dsh' }, persona: '小鲸鱼' }), 'agy', '卡片不是对象时当没配');
});

ok('★ 空 persona 名不会意外匹配到别人', () => {
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: { '': { transport: 'dsh' } }, persona: '' }), 'agy');
  assert.equal(resolvePersonaTransport({ globalTransport: 'agy', personas: PERSONAS, persona: null }), 'agy');
});

console.log('\n路由表（status / 日志用）：');

ok('★ 表里按 rotation 顺序给出每个人格的去向', () => {
  const table = personaRoutingTable({ globalTransport: 'agy', personas: PERSONAS, rotation: ['小鲸鱼', '猫娘侍从'] });
  assert.deepEqual(table, { 小鲸鱼: 'dsh', 猫娘侍从: 'agy' });
});

ok('★ persona 表里有但 rotation 没写的，也要出现在路由表里（配置漂移看得见）', () => {
  const table = personaRoutingTable({ globalTransport: 'agy', personas: PERSONAS, rotation: ['小鲸鱼'] });
  assert.deepEqual(table, { 小鲸鱼: 'dsh', 猫娘侍从: 'agy' });
});

ok('★ 全局 dsh 时路由表全是 dsh', () => {
  const table = personaRoutingTable({ globalTransport: 'dsh', personas: PERSONAS, rotation: ['小鲸鱼', '猫娘侍从'] });
  assert.deepEqual(table, { 小鲸鱼: 'dsh', 猫娘侍从: 'dsh' });
});

console.log('\nAGY 降级（心跳还在但链路坏了 ⇒ 回落 DSH）：');

ok('★★ 只有"真的丢了回合"才降级；普通重排不降级（那是慢，不是坏）', () => {
  assert.equal(shouldDegradeToDsh({ dropped: false, reason: 'lease-expired' }), false);
  assert.equal(shouldDegradeToDsh({ dropped: true, reason: 'lease-expired' }), true);
  assert.equal(shouldDegradeToDsh({ dropped: true, reason: 'tool-error' }), true);
  assert.equal(shouldDegradeToDsh({ dropped: true, reason: 'timeout' }), true);
});

ok('★ 模型自己拒答 / 人手动退回 不降级（不是基础设施问题）', () => {
  assert.equal(shouldDegradeToDsh({ dropped: true, reason: 'refusal' }), false);
  assert.equal(shouldDegradeToDsh({ dropped: true, reason: 'manual' }), false);
});

ok('★ 不知道原因时按故障处理（宁可回落 DSH，也别在群里哑火）', () => {
  assert.equal(shouldDegradeToDsh({ dropped: true }), true);
  assert.equal(shouldDegradeToDsh({ dropped: true, reason: '' }), true);
});

ok('★ 降级 10 分钟；到点自动恢复，避免一次抖动就永久切走', () => {
  assert.equal(AGY_DEGRADE_MS, 10 * 60 * 1000);
  const now = 1_000_000;
  assert.equal(isDegraded(now + AGY_DEGRADE_MS, now), true);
  assert.equal(isDegraded(now + AGY_DEGRADE_MS, now + AGY_DEGRADE_MS), false, '到点即恢复');
  assert.equal(isDegraded(0, now), false, '没降级');
  assert.equal(AGY_INFRA_REQUEUE_REASONS.length, 3);
});

console.log(`\n全部通过：${n} 项断言组`);