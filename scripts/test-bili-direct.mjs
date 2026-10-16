// B 站直连通道的离线回归：域名判定 / DoH 解析与缓存 / 回落行为 / 接线守卫
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clearDirectCache, createBiliFetch, dohResolve, isBiliHost, isBiliUrl } from '../src/bili-direct.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const okAsync = async (name, fn) => { await fn(); n++; console.log(`  ✅ ${name}`); };

console.log('域名判定：');

ok('isBiliHost：只认 B 站自家域名（子域算，伪装的不算）', () => {
  for (const h of ['bilibili.com', 'api.bilibili.com', 'www.bilibili.com', 'b23.tv', 'i0.hdslb.com', 'upos-sz-mirror.bilivideo.com']) {
    assert.equal(isBiliHost(h), true, `${h} 应该算`);
  }
  for (const h of ['github.com', 'evil-bilibili.com.evil.com', 'bilibili.com.evil.com', 'notb23.tv', '']) {
    assert.equal(isBiliHost(h), false, `${h} 不该算`);
  }
  assert.equal(isBiliUrl('https://b23.tv/AbCdEf'), true);
  assert.equal(isBiliUrl('https://example.com/bilibili.com'), false);
  assert.equal(isBiliUrl('不是 URL'), false);
});

console.log('\nDoH 解析与缓存：');

await okAsync('dohResolve：解析 A 记录，并命中缓存（第二次不再请求）', async () => {
  clearDirectCache();
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return { json: async () => ({ Answer: [{ type: 1, data: '121.194.11.74' }, { type: 5, data: 'x' }, { type: 1, data: '121.194.11.73' }] }) };
  };
  const ips = await dohResolve('api.bilibili.com', { fetchImpl: fake });
  assert.deepEqual(ips, ['121.194.11.74', '121.194.11.73'], '只取 A 记录(type=1)');
  assert.equal(calls, 1);
  const again = await dohResolve('api.bilibili.com', { fetchImpl: fake });
  assert.deepEqual(again, ips);
  assert.equal(calls, 1, '★ 第二次必须走缓存，不该再发 DoH 请求');
});

await okAsync('dohResolve：端点失败会换下一个；全失败返回空数组（交给回落）', async () => {
  clearDirectCache();
  let calls = 0;
  const flaky = async (url) => {
    calls += 1;
    if (String(url).includes('1.12.12.12')) throw new Error('boom');
    return { json: async () => ({ Answer: [{ type: 1, data: '1.2.3.4' }] }) };
  };
  const ips = await dohResolve('b23.tv', { fetchImpl: flaky, endpoints: ['https://1.12.12.12/resolve', 'https://223.5.5.5/resolve'] });
  assert.deepEqual(ips, ['1.2.3.4']);
  assert.equal(calls, 2, '第一个端点失败后要试第二个');
  clearDirectCache();
  const none = await dohResolve('b23.tv', { fetchImpl: async () => { throw new Error('all down'); }, endpoints: ['https://a/resolve'] });
  assert.deepEqual(none, []);
});

console.log('\n回落行为（"绝不比原来更差"）：');

await okAsync('非 B 站域名：直接交给默认 fetch，不做任何额外动作', async () => {
  clearDirectCache();
  let calls = 0;
  const fallback = async (url) => { calls += 1; return { ok: true, status: 200, text: async () => 'ok:' + url }; };
  const f = createBiliFetch({ fallbackFetch: fallback, log: () => {} });
  const r = await f('https://example.com/x');
  assert.equal(calls, 1);
  assert.equal(await r.text(), 'ok:https://example.com/x');
});

await okAsync('B 站域名但 DoH 全失败：回落到默认 fetch，并且只抱怨一次', async () => {
  clearDirectCache();
  const logs = [];
  let realCalls = 0;
  const fallback = async () => { realCalls += 1; return { ok: true, status: 200 }; };
  const deadDoh = async () => { throw new Error('doh down'); };
  const f = createBiliFetch({ fallbackFetch: fallback, dohFetch: deadDoh, log: (m) => logs.push(m) });
  const r1 = await f('https://api.bilibili.com/x/web-interface/view?bvid=BV1KZ3x6SEBb');
  assert.equal(r1.status, 200);
  assert.equal(realCalls, 1, '必须要回落，不能直接失败');
  assert.equal(logs.length, 1, '要记一条日志说明回落了');
  assert.match(logs[0], /直连失败/);
  // 第二次立刻再来：仍然回落，但 5 分钟内不再重复抱怨（免得刷屏）
  await f('https://api.bilibili.com/x/web-interface/view?bvid=BV1ARp26aEHv');
  assert.equal(realCalls, 2);
  assert.equal(logs.length, 1, '★ 抱怨要节流');
});

console.log('\n接线与证据：');

ok('源码守卫：桥接把直连通道接进了登录态与预取；模块头写明 412 证据', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const mod = fs.readFileSync(path.join(root, 'src', 'bili-direct.js'), 'utf8');
  assert.match(mod, /request was banned/, '要写明 -412 的实测证据');
  assert.match(mod, /servername/, '必须带 SNI');
  assert.match(mod, /DoH/, '要写明 DoH');
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /createBiliFetch/, 'bridge 要建通道');
  assert.match(bridge, /createBiliAuth\(\{[^}]*fetchImpl: biliFetch/, '登录态请求要走直连（字幕靠它）');
  assert.match(bridge, /summarizeBilibili\(url, \{[^}]*fetchImpl: biliFetch/, '元信息预取要走直连');
});

console.log(`\n全部通过：${n} 项断言组`);
