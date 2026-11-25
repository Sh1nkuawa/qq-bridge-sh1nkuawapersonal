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

await acount('persona 分区互不串（小鲸鱼的活不会被猫娘取走）', async () => {
  const t = mk();
  t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'A' });
  const got = await t.wait({ persona: '猫娘侍从', timeoutMs: 50 });
  assert.equal(got, null, '猫娘不该拿到小鲸鱼的活');
  assert.equal(t.pending('小鲸鱼'), 1);
});

console.log('\n长 prompt 落盘与换班清理（2026-11-25 新增）：');

await acount('★ setPrompt 能改未认领回合的 prompt（落盘后用）', async () => {
  const t = mk();
  const turn = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: '长'.repeat(20000) });
  const r = t.setPrompt({ turnId: turn.turnId, prompt: '短提示 + 文件路径' });
  assert.equal(r.ok, true);
  assert.equal(r.turn.prompt, '短提示 + 文件路径');
  // worker 取到的必须是改过的版本（否则落盘等于白做）
  const got = await t.wait({ persona: '小鲸鱼', timeoutMs: 100 });
  assert.equal(got.prompt, '短提示 + 文件路径');
});

ok('★★ setPrompt 不能改已认领的回合（worker 手里已经是旧 prompt）', () => {
  const t = mk();
  const turn = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'x' });
  t.claim({ turnId: turn.turnId, workerId: 'w1' });
  const r = t.setPrompt({ turnId: turn.turnId, prompt: 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.http, 409);
  assert.equal(r.error, AGY_ERRORS.ALREADY_CLAIMED);
});

ok('★ setPrompt 不存在的回合 → 404', () => {
  const t = mk();
  const r = t.setPrompt({ turnId: 't-nope', prompt: 'y' });
  assert.equal(r.http, 404);
  assert.equal(r.error, AGY_ERRORS.TURN_NOT_FOUND);
});

ok('★★ 换班：dropUnclaimed 只丢指定人格的未认领回合（已认领/别人不动）', () => {
  const t = mk();
  const old1 = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'a' });
  const old2 = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'b' });
  const other = t.enqueue({ persona: '猫娘侍从', key: 'g', prompt: 'c' });
  const claimed = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'd' });
  t.claim({ turnId: claimed.turnId, workerId: 'w1' });
  const dropped = t.dropUnclaimed({ persona: '小鲸鱼' });
  const ids = dropped.map((x) => x.turnId).sort();
  assert.deepEqual(ids, [old1.turnId, old2.turnId].sort());
  assert.equal(t.pending('小鲸鱼'), 0, '旧人格的待办应该清空');
  assert.equal(t.pending('猫娘侍从'), 1, '别的人格不能被误伤');
  assert.equal(t.claim({ turnId: other.turnId, persona: '猫娘侍从', workerId: 'w2' }).ok, true, '别的人格的回合应仍可认领');
  // 被认领的那条仍在（worker 手里还有活，让它自然地 complete/超时）
  assert.equal(t.touch({ turnId: claimed.turnId, workerId: 'w1' }).ok, true);
});

ok('★★ 值班者掉线：dropUnclaimed 只丢"老于阈值"的回合', () => {
  let clock = 100_000;
  const t = createAgyTransport({ now: () => clock });
  const oldTurn = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'old' });
  clock += 60_000;
  const fresh = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'fresh' });
  const dropped = t.dropUnclaimed({ persona: '小鲸鱼', olderThanMs: 30_000 });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].turnId, oldTurn.turnId);
  assert.equal(t.pending('小鲸鱼'), 1, '新鲜的回合不能被误丢');
  assert.ok(fresh.turnId);
});

await acount('★★ enqueue({notify:false}) 不叫醒 worker；改写后再 wake 拿到的是**改写后**的 prompt', async () => {
  const t = mk();
  // worker 已经挂在长轮询上（真实 worker 常态）
  const pending = t.wait({ persona: '小鲸鱼', timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 10));
  const turn = t.enqueue({ persona: '小鲸鱼', key: 'g', prompt: 'X'.repeat(20000), notify: false });
  // 改写（模拟桥接落盘后换成短提示）
  t.setPrompt({ turnId: turn.turnId, prompt: '短提示：请读 state/agy-context-xxx.md' });
  assert.equal(t.pending('小鲸鱼'), 1, '入队了但还没叫醒');
  t.wake('小鲸鱼');
  const got = await pending;
  assert.equal(got.turnId, turn.turnId);
  assert.equal(got.prompt, '短提示：请读 state/agy-context-xxx.md', 'worker 必须拿到改写后的短提示，而不是 20KB 原文 ✗');
});

console.log(`\n全部通过：${n} 项断言组`);
