// 串行队列的离线回归：严格按序、失败不阻塞、返回值各自独立
import assert from 'node:assert/strict';
import { createSerialQueue } from '../src/serialize.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await (async () => {
  console.log('串行队列：');

  await ok('★ 三个任务严格按序执行（后一个等前一个）', async () => {
    const q = createSerialQueue();
    const log = [];
    const t1 = q(async () => { log.push('a-start'); await sleep(30); log.push('a-end'); });
    const t2 = q(async () => { log.push('b-start'); await sleep(5); log.push('b-end'); });
    const t3 = q(async () => { log.push('c-start'); log.push('c-end'); });
    await Promise.all([t1, t2, t3]);
    assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  });

  await ok('★ 前一个失败，后一个照常执行', async () => {
    const q = createSerialQueue();
    const log = [];
    await assert.rejects(q(async () => { log.push('a'); throw new Error('boom'); }));
    await q(async () => { log.push('b'); });
    assert.deepEqual(log, ['a', 'b']);
  });

  await ok('返回值互不干扰', async () => {
    const q = createSerialQueue();
    const [x, y] = await Promise.all([q(async () => 1), q(async () => 2)]);
    assert.equal(x, 1);
    assert.equal(y, 2);
  });

  console.log(`\n全部通过：${n} 项断言组`);
})();
