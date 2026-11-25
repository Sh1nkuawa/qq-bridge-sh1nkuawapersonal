// AGY 传输层的离线回归：队列、长轮询、租约、重排上限、persona 分区、丢弃
import assert from 'node:assert/strict';
import { AGY_ERRORS, createAgyTransport } from '../src/agy-transport.js';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✅ ${name}`); };
const acount = async (name, fn) => { await fn(); n += 1; console.log(`  ✅ ${name}`); };

const mk = (over = {}) => createAgyTransport({ leaseMs: 1000, maxAttempts: 2, ...over });

console.log('入队与取活：');

await acount('★ 入队后能被 wait 立刻取到（返回队首）', async () => {
  const t = mk();
  const turn = t.enqueue({ persona: '小鲸鱼', key: 'group:1', prompt: 'P1' });
  assert.equal(turn.persona, '小鲸鱼');
  assert.equal(turn.prompt, 'P1');
  assert.equal(turn.attempts, 0);
  const got = await t.wait({ persona: '小鲸鱼', timeoutMs: 1000 });
  assert.equal(got.turnId, turn.turnId);
});

await acount('★ 空队列的 wait 会挂起到超时并返回 null（不是错误）', async () => {
  const t = mk();
  const t0 = Date.now();
  const got = await t.wait({ persona: '小鲸鱼', timeoutMs: 60 });
  assert.equal(got, null);
  assert.ok(Date.now() - t0 >= 40, '应该真的等了一下');
});

await acount('★★ 非值班者的 wait 立刻返回 idle（不占队列、不阻塞）', async () => {
  const t = mk();
  t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'x' });
  const got = await t.wait({ persona: '猫娘侍从', onDuty: '小鲸鱼', timeoutMs: 5000 });
  assert.equal(got.idle, true);
  assert.equal(got.reason, AGY_ERRORS.NOT_ON_DUTY);
});

await acount('新入队会唤醒正在挂起的 worker（长轮询语义）', async () => {
  const t = mk();
  const p = t.wait({ persona: '小鲸鱼', timeoutMs: 5000 });
  setTimeout(() => t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'late' }), 30);
  const got = await p;
  assert.ok(got && got.prompt === 'late');
});

console.log('\n认领与租约：');

ok('★ claim 后从队列移除并给租约', () => {
  const t = mk();
  const turn = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'x' });
  const r = t.claim({ turnId: turn.turnId, persona: '小鲸鱼', workerId: 'w1' });
  assert.equal(r.ok, true);
  assert.ok(r.leaseUntil > Date.now());
  assert.equal(t.pending('小鲸鱼'), 0);
});

ok('★ 重复 claim → already-claimed（幂等保护）', () => {
  const t = mk();
  const turn = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'x' });
  t.claim({ turnId: turn.turnId, workerId: 'w1' });
  const r2 = t.claim({ turnId: turn.turnId, workerId: 'w2' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, AGY_ERRORS.ALREADY_CLAIMED);
  assert.equal(r2.http, 409);
});

ok('★ 不存在的 turnId → turn-not-found（404）', () => {
  const t = mk();
  const r = t.claim({ turnId: 't-nope', workerId: 'w1' });
  assert.equal(r.http, 404);
  assert.equal(r.error, AGY_ERRORS.TURN_NOT_FOUND);
});

ok('★ 非值班者 claim → 403 not-on-duty', () => {
  const t = mk();
  const turn = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'x' });
  const r = t.claim({ turnId: turn.turnId, persona: '猫娘侍从', onDuty: '小鲸鱼' });
  assert.equal(r.http, 403);
  assert.equal(r.error, AGY_ERRORS.NOT_ON_DUTY);
});

ok('★ touch 能续租；没认领就 touch → turn-not-claimed', () => {
  let clock = 1000;
  const t = createAgyTransport({ leaseMs: 500, now: () => clock });
  const turn = t.enqueue({ persona: 'p', key: 'g', prompt: 'x' });
  const bad = t.touch({ turnId: turn.turnId });
  assert.equal(bad.error, AGY_ERRORS.TURN_NOT_CLAIMED);
  t.claim({ turnId: turn.turnId, workerId: 'w1' });
  clock += 400;
  const r = t.touch({ turnId: turn.turnId, workerId: 'w1' });
  assert.equal(r.ok, true);
  assert.equal(r.leaseUntil, clock + 500);
});

console.log('\n完成、重排、回收：');

ok('★ complete 出队', () => {
  const t = mk();
  const turn = t.enqueue({ persona: 'p', key: 'g', prompt: 'x' });
  t.claim({ turnId: turn.turnId, workerId: 'w1' });
  const r = t.complete({ turnId: turn.turnId, workerId: 'w1' });
  assert.equal(r.ok, true);
  assert.equal(t.pending('p'), 0);
});

ok('★ 没认领就 complete → turn-not-claimed', () => {
  const t = mk();
  const turn = t.enqueue({ persona: 'p', key: 'g', prompt: 'x' });
  const r = t.complete({ turnId: turn.turnId });
  assert.equal(r.error, AGY_ERRORS.TURN_NOT_CLAIMED);
});

ok('★ requeue 回队首，attempts+1', () => {
  const t = mk();
  const turn = t.enqueue({ persona: 'p', key: 'g', prompt: 'x' });
  t.claim({ turnId: turn.turnId, workerId: 'w1' });
  const r = t.requeue({ turnId: turn.turnId, reason: 'refusal' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(t.pending('p'), 1);
});

ok('★★ 超过 maxAttempts 就丢弃（绝不无限重试）', () => {
  const t = mk();
  const turn = t.enqueue({ persona: 'p', key: 'g', prompt: 'x' });
  for (let i = 0; i < 2; i += 1) {
    t.claim({ turnId: turn.turnId, workerId: 'w1' });
    t.requeue({ turnId: turn.turnId, reason: 'refusal' });
  }
  t.claim({ turnId: turn.turnId, workerId: 'w1' });
  const r = t.requeue({ turnId: turn.turnId, reason: 'refusal' });
  assert.equal(r.ok, false);
  assert.equal(r.error, AGY_ERRORS.REQUEUED_TOO_MANY);
  assert.equal(t.pending('p'), 0, '丢弃后不该还在队列里');
});

ok('★★ 租约超时 → sweep 自动重排（且 attempts 递增）', () => {
  let clock = 10_000;
  const t = createAgyTransport({ leaseMs: 1000, now: () => clock });
  const turn = t.enqueue({ persona: 'p', key: 'g', prompt: 'x' });
  t.claim({ turnId: turn.turnId, workerId: 'w1' });
  clock += 1500;                     // 越过租约
  const swept = t.sweep();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].requeued, true);
  assert.equal(t.pending('p'), 1, '应该回到队列等下一个 worker');
  const again = t.claim({ turnId: turn.turnId, workerId: 'w2' });
  assert.equal(again.ok, true);
  assert.equal(again.turn.attempts, 1);
});

console.log('\n边界：');

ok('队列超长丢最旧（maxQueue）', () => {
  const t = createAgyTransport({ maxQueue: 3 });
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(t.enqueue({ persona: 'p', key: 'g', prompt: `p${i}` }).turnId);
  assert.equal(t.pending('p'), 3);
  const st = t.status();
  assert.equal(st.stats.dropped, 2);
});

ok('status 给出队列/租约/统计', () => {
  const t = mk();
  t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'x' });
  t.enqueue({ persona: '猫娘侍从', key: 'g', prompt: 'y' });
  const st = t.status({ onDuty: '小鲸鱼' });
  assert.equal(st.transport, 'agy');
  assert.equal(st.onDuty, '小鲸鱼');
  assert.equal(st.queue['小鲸鱼'], 1);
  assert.equal(st.queue['猫娘侍从'], 1);
  assert.equal(st.leaseSec, 1);
  assert.equal(st.version, 1);
});

ok('persona 分区互不串（小鲸鱼的活不会被猫娘取走）', async () => {
  const t = mk();
  t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'A' });
  const got = await t.wait({ persona: '猫娘侍从', timeoutMs: 50 });
  assert.equal(got, null, '猫娘不该拿到小鲸鱼的活');
  assert.equal(t.pending('小鲸鱼'), 1);
});

console.log(`\n全部通过：${n} 项断言组`);
