// tts-service 的离线回归：按需拉起、并发只拉一次、空闲 30 分钟自动关
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTtsService } from '../src/tts-service.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tts-svc-'));

// 假时钟 + 可控探针
function harness({ up = false, startupAfterMs = 3000, startupTimeoutMs = 60000, idleMinutes = 30 } = {}) {
  let clock = 1_000_000;
  let upNow = up;
  let spawned = 0;
  let killed = [];
  let startedAt = 0;
  let readyAt = Infinity;
  const stateDir = home();
  fs.mkdirSync(path.join(stateDir), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tts.json'), JSON.stringify({ idleMinutes, service: { startupTimeoutMs } }), 'utf8');

  const svc = createTtsService({
    stateDir,
    now: () => clock,
    probe: async () => upNow,
    spawner: () => {
      spawned += 1;
      startedAt = clock;
      // 模拟"启动后过 startupAfterMs 才就绪"：把就绪点记下来，由 sleeper 推进时判定
      readyAt = clock + startupAfterMs;
      return { pid: 4242 };
    },
    // 关键：拉起轮询里的 sleep 也推进假时钟（否则 now() 永远到不了 deadline ⇒ 死循环 ✗）
    sleeper: async (ms) => { clock += ms; if (clock >= readyAt) upNow = true; },
    killer: async (pid) => { killed.push(pid); upNow = false; },
    log: () => {}
  });
  return {
    svc,
    advance: (ms) => { clock += ms; },
    setNow: (t) => { clock = t; },
    get spawned() { return spawned; },
    get killed() { return killed; },
    setUp: (v) => { upNow = v; }
  };
}

console.log('按需拉起：');

ok('已在跑 → 直接复用，不重复拉起', async () => {
  const h = harness({ up: true });
  const r = await h.svc.ensureRunning();
  assert.equal(r.ok, true);
  assert.equal(r.started, false);
  assert.equal(h.spawned, 0);
});

ok('★ 没在跑 → 拉起来并等到就绪', async () => {
  const h = harness({ up: false, startupAfterMs: 1000 });
  const r = await h.svc.ensureRunning();
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(h.spawned, 1);
});

ok('★ 并发调用只拉起一次', async () => {
  const h = harness({ up: false, startupAfterMs: 2000 });
  const [a, b, c] = await Promise.all([h.svc.ensureRunning(), h.svc.ensureRunning(), h.svc.ensureRunning()]);
  assert.equal(a.ok && b.ok && c.ok, true);
  assert.equal(h.spawned, 1, '只该拉起一次');
});

console.log('\n空闲自动关：');

ok('★ 刚用过（<30 分钟）不关', async () => {
  const h = harness({ up: true });
  await h.svc.ensureRunning();       // touch
  h.advance(10 * 60 * 1000);         // 10 分钟
  const r = await h.svc.checkIdle();
  assert.equal(r.stopped, false);
  assert.equal(h.killed.length, 0);
});

ok('★ 空闲超过 30 分钟 → 关闭（释放显存）', async () => {
  const h = harness({ up: true });
  await h.svc.ensureRunning();
  h.advance(31 * 60 * 1000);
  const r = await h.svc.checkIdle();
  assert.equal(r.stopped, true);
  assert.equal(h.killed.length, 1);
});

ok('从没用过 → 不主动去关（可能是别人起的）', async () => {
  const h = harness({ up: true });
  const r = await h.svc.checkIdle();
  assert.equal(r.stopped, false);
  assert.equal(r.reason, 'never-used');
});

ok('空闲但服务已经不在 → 只清状态，不杀', async () => {
  const h = harness({ up: true });
  await h.svc.ensureRunning();
  h.setUp(false);
  h.advance(40 * 60 * 1000);
  const r = await h.svc.checkIdle();
  assert.equal(r.reason, 'already-down');
  assert.equal(h.killed.length, 0);
});

ok('idleMinutes 可从 state/tts.json 覆盖', async () => {
  const h = harness({ up: true, idleMinutes: 5 });
  await h.svc.ensureRunning();
  h.advance(6 * 60 * 1000);
  const r = await h.svc.checkIdle();
  assert.equal(r.stopped, true);
});

console.log(`\n全部通过：${n} 项断言组`);
