// QQ 内置表情（face）取图回落：faceImageUrlCandidates 的单元测试 + bridge 接线检查
//
// 背景（2026-09-30）：群里发 QQ 内置表情时，模型只拿到文字描述、看不到图。
// 原因是 SnowLuma 给的 face.url 有一部分已 404（返回 HTML），而同一表情的
// 「400 前缀」写法还在：
//   https://qzonestyle.gtimg.cn/qzone/em/e498.gif     → 404 text/html  ✗
//   https://qzonestyle.gtimg.cn/qzone/em/e400498.gif  → 200 image/png  ✓
// 这个测试把「候选顺序 / 去重 / 不越界到别的主机」和「bridge 真的按候选依次取、
// 且仍然走 safeFetchBuffer 校验」钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { faceImageUrlCandidates } from '../src/safe-fetch.js';

let count = 0;
function ok(name, fn) {
  fn();
  count += 1;
  console.log(`  ✅ ${name}`);
}

const QZ = 'https://qzonestyle.gtimg.cn/qzone/em/';
const bridge = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8');

console.log('face 取图回落：');

ok('原 URL 排第一，随后补 400 前缀变体，最后是规范写法', () => {
  const got = faceImageUrlCandidates(`${QZ}e498.gif`, 498);
  assert.deepEqual(got, [
    'https://qzonestyle.gtimg.cn/qzone/em/e498.gif',
    'https://qzonestyle.gtimg.cn/qzone/em/e400498.gif',
    'https://qzonestyle.gtimg.cn/qzone/em/e400498.gif'
  ].filter((v, i, a) => a.indexOf(v) === i));
});

ok('已经是 400 写法时，额外试去掉 400 的变体（并在前面保留原 URL）', () => {
  const got = faceImageUrlCandidates(`${QZ}e400498.gif`, 498);
  assert.equal(got[0], 'https://qzonestyle.gtimg.cn/qzone/em/e400498.gif');
  assert.ok(got.includes('https://qzonestyle.gtimg.cn/qzone/em/e498.gif'), '应包含非 400 变体');
});

ok('没有可用 url 时，按 faceId 生成规范写法', () => {
  const got = faceImageUrlCandidates('', 100);
  assert.deepEqual(got, ['https://qzonestyle.gtimg.cn/qzone/em/e400100.gif']);
});

ok('faceId 非法且没有 url 时不产生候选（不会瞎猜地址）', () => {
  assert.deepEqual(faceImageUrlCandidates('', NaN), []);
  assert.deepEqual(faceImageUrlCandidates('', 0), []);
});

ok('去重：同一个地址不会重复出现', () => {
  const got = faceImageUrlCandidates(`${QZ}e400400.gif`, 400);
  assert.equal(new Set(got).size, got.length, JSON.stringify(got));
});

ok('不越界：候选仍然只落在原 URL 的主机上（或固定可信的腾讯表情 CDN）', () => {
  const got = faceImageUrlCandidates('https://example.com/em/e498.gif', 498);
  for (const u of got) {
    const host = new URL(u).host;
    assert.ok(host === 'example.com' || host === 'qzonestyle.gtimg.cn', `不该出现别的主机：${u}`);
  }
});

ok('bridge 的 fetchFaceMedia 按候选依次取，且每次都过 safeFetchBuffer（防护不绕过）', () => {
  assert.match(bridge, /const candidates = faceImageUrlCandidates\(face\.url, faceId\);/);
  assert.match(bridge, /for \(const url of candidates\) \{[\s\S]{0,400}?await safeFetchBuffer\(url, MAX_MEDIA_BYTES\)/);
  assert.match(bridge, /表情图片改用备选 URL 成功（faceId=/);
  // 失败时也要把试过的 URL 记下来（这次就是因为日志里没有 URL 才排查慢）
  assert.match(bridge, /表情图片抓取失败（\$\{url\}）/);
});

console.log(`\n全部通过：${count} 项断言组`);
