// SnowLuma 链路存活看门狗验收。
//
// 事故（2026-09-29 19:17）：桥接进程活着、WS 没报 close，但群友的「@机器人 …」根本没进桥接
// —— SnowLuma 日志里有 [Event]，桥接活动日志里一个字都没有；几分钟后才 ECONNRESET。
// SDK 的 reconnect 只在显式 close 时触发，半死连接不会触发，于是"桥接活着但收发全废"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideSnowlumaAction, normalizeSnowlumaWatchConfig, SNOWLUMA_PROBE_MIN_INTERVAL_MS } from '../src/snowluma-liveness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
// 允许两种写法：传函数（断言，抛错即失败）或直接传布尔值。
const ok = (name, cond) => {
  let good = false; let extra = '';
  try {
    if (typeof cond === 'function') { cond(); good = true; }
    else { good = Boolean(cond); }
  } catch (e) { extra = ' — ' + (e?.message ?? e); }
  if (good) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + extra); }
};

const T = 1000000; // 基准时间

console.log('## 判定：什么时候该探活/重连');
const base = { lastAliveAt: T, idleProbeMs: 300000, hardReconnectMs: 720000 };
ok('链路活跃 → 什么都不做', () => {
  const d = decideSnowlumaAction({ ...base, now: T + 60000, lastProbeAt: 0 });
  assert.equal(d.action, 'none');
});
ok('静默刚过 idleProbeMs → 探活', () => {
  const d = decideSnowlumaAction({ ...base, now: T + 300001, lastProbeAt: 0 });
  assert.equal(d.action, 'probe');
  assert.match(d.reason, /静默 5 分钟/);
});
ok('探活刚做过 → 不重复探活（最小间隔）', () => {
  const d = decideSnowlumaAction({ ...base, now: T + 300002, lastProbeAt: T + 300000 });
  assert.equal(d.action, 'none');
  assert.equal(SNOWLUMA_PROBE_MIN_INTERVAL_MS, 15000);
});
ok('探活在飞 → 不重复发', () => {
  const d = decideSnowlumaAction({ ...base, now: T + 400000, lastProbeAt: T + 300000, probeInFlight: true });
  assert.equal(d.action, 'none');
});
ok('探活失败 → 立刻重连（不再等）', () => {
  const d = decideSnowlumaAction({ ...base, now: T + 310000, probeFailed: true });
  assert.equal(d.action, 'reconnect');
});
ok('静默超过 hardReconnectMs → 直接重连', () => {
  const d = decideSnowlumaAction({ ...base, now: T + 720001, lastProbeAt: T + 700000 });
  assert.equal(d.action, 'reconnect');
  assert.match(d.reason, /静默 12 分钟/);
});

console.log('\n## 配置归一化（配错也不能把看门狗配成"每轮都重连"）');
ok('默认值合理', () => {
  const c = normalizeSnowlumaWatchConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.idleProbeMs, 300000);
  assert.equal(c.hardReconnectMs, 720000);
  assert.equal(c.tickMs, 30000);
});
ok('可以显式关掉', () => assert.equal(normalizeSnowlumaWatchConfig({ socialV2: { snowluma: { enabled: false } } }).enabled, false));
ok('idleProbeMs=0 之类非法值回落到默认（否则每 tick 都重连）', () => {
  const c = normalizeSnowlumaWatchConfig({ socialV2: { snowluma: { idleProbeMs: 0, tickMs: -5 } } });
  assert.equal(c.idleProbeMs, 300000);
  assert.equal(c.tickMs, 30000);
});
ok('hardReconnectMs 至少是 idleProbeMs 的 2 倍（防止探活与重连抢跑）', () => {
  const c = normalizeSnowlumaWatchConfig({ socialV2: { snowluma: { idleProbeMs: 600000, hardReconnectMs: 1000 } } });
  assert.equal(c.hardReconnectMs, 1200000);
});

console.log('\n## 接线（源码级：这些必须真的挂上）');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
ok('import 了存活判定模块', /from '\.\/snowluma-liveness\.mjs'/.test(bridge));
ok('入站事件会刷新存活水位', (bridge.match(/touchSnowlumaActivity\(\)/g) || []).length >= 4);
ok('连接建立时也会刷新（避免刚连上就被判静默）', /bot\.on\('open', \(\) => \{[\s\S]{0,200}touchSnowlumaActivity\(\);/.test(bridge));
ok('看门狗被启动', /startSnowlumaWatchdog\(\);/.test(bridge));
ok('探活用 getStatus，失败即判死', /bot\.getStatus\(\)/.test(bridge) && /snowlumaProbeFailed = true/.test(bridge));
ok('重连走 close + connect（并先重置水位，避免连续重连）', /bot\.close\(1000, 'stale-link'\)/.test(bridge) && /bot\.connect\(\)/.test(bridge));
ok('默认配置里有 socialV2.snowluma 看门狗参数', /snowluma: \{[\s\S]{0,200}idleProbeMs: 300000/.test(bridge));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
