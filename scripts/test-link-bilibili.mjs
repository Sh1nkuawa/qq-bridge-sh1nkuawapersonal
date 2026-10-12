// B 站元信息摘要的离线回归（纯函数 + 不触网的早退路径）。
// 真实联网验证（可选）：node scripts/test-link-bilibili.mjs --live
import assert from 'node:assert/strict';
import { clearBilibiliCache, formatDuration, formatVideoSummary, humanCount, summarizeBilibili } from '../src/link-bilibili.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const okAsync = async (name, fn) => { await fn(); n++; console.log(`  ✅ ${name}`); };
const okCond = (name, cond) => { if (cond) { n++; console.log(`  ✅ ${name}`); } else { console.log(`  ⏭️ ${name}（跳过）`); } };

console.log('B 站元信息摘要：');

ok('humanCount：万/亿 口径', () => {
  assert.equal(humanCount(0), '0');
  assert.equal(humanCount(9999), '9999');
  assert.equal(humanCount(12345), '1.2万');
  assert.equal(humanCount(123456789), '1.2亿');
  assert.equal(humanCount('bad'), '?');
});

ok('formatDuration：12:34 / 1:02:03', () => {
  assert.equal(formatDuration(754), '12:34');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(0), '0:00');
});

const VIEW = {
  bvid: 'BV1GJ411x7h7',
  title: '【测试】一个视频标题',
  desc: '这是一段简介。'.repeat(60),          // 超长，测试截断
  duration: 754,
  tname: '日常',
  pubdate: 1712345678,
  owner: { name: '某UP主' },
  stat: { view: 123456, danmaku: 234, like: 12345, favorite: 3456, coin: 789 },
  pages: [{ part: 'P1 开场' }, { part: 'P2 正片' }]
};

ok('formatVideoSummary：标题/UP/时长/分区/统计/分P/简介/链接 都在，简介按字数截断', () => {
  const text = formatVideoSummary(VIEW, { descChars: 40, url: 'https://www.bilibili.com/video/BV1GJ411x7h7' });
  assert.match(text, /【B站视频】一个视频标题|【B站视频】.*一个视频标题/);
  assert.match(text, /UP：某UP主/);
  assert.match(text, /时长：12:34/);
  assert.match(text, /分区：日常/);
  assert.match(text, /播放 12\.3万 · 弹幕 234 · 点赞 1\.2万 · 收藏 3456 · 投币 789/);
  assert.match(text, /分P（共 2）：1\.P1 开场；2\.P2 正片/);
  assert.match(text, /简介：.{40}…/);
  assert.match(text, /链接：https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7/);
});

ok('formatVideoSummary：单P 不显示分P行；缺字段也不崩', () => {
  const one = formatVideoSummary({ title: 'T', pages: [{ part: 'P1' }], owner: {}, stat: {} });
  assert.ok(!/分P/.test(one), '单P 不该有分P行');
  const empty = formatVideoSummary(null);
  assert.match(empty, /【B站视频】（无标题）/);
});

await okAsync('summarizeBilibili：空链接 / 非 B 站链接 / 番剧链接都走早退（不发请求）', async () => {
  clearBilibiliCache();
  let called = 0;
  const fakeFetch = async () => { called++; return { ok: true, url: 'https://x/', json: async () => ({}), body: { cancel() {} } }; };
  const a = await summarizeBilibili('', { fetchImpl: fakeFetch });
  const b = await summarizeBilibili('https://example.com/post/1', { fetchImpl: fakeFetch });
  const c = await summarizeBilibili('https://www.bilibili.com/bangumi/play/ep123456', { fetchImpl: fakeFetch });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.match(b.reason, /不是 B 站视频链接/);
  assert.match(c.reason, /番剧/);
  assert.equal(called, 0, '早退路径不该真的发请求');
});

await okAsync('summarizeBilibili：结果会进缓存（第二次标 cached）', async () => {
  clearBilibiliCache();
  const fakeFetch = async () => { throw new Error('不该被调用'); };
  await summarizeBilibili('https://example.com/cache-me', { fetchImpl: fakeFetch });
  const second = await summarizeBilibili('https://example.com/cache-me', { fetchImpl: fakeFetch });
  assert.equal(second.cached, true);
});

if (process.argv.includes('--live')) {
  console.log('\n—— 联网实测（--live）——');
  const r = await summarizeBilibili('https://www.bilibili.com/video/BV1GJ411x7h7', { timeoutMs: 10000 });
  console.log(r.ok ? `  ✅ 抓到：\n${r.text.split('\n').map((l) => '     ' + l).join('\n')}` : `  ✗ 失败：${r.reason}`);
  okCond('联网实测通过', r.ok);
} else {
  console.log('\n（想真连一次 B 站：node scripts/test-link-bilibili.mjs --live）');
}

console.log(`\n全部通过：${n} 项断言组`);
