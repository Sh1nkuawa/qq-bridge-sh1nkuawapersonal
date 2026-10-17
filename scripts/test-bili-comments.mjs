// B 站热评（辅助理解）的离线回归：清洗 / 挑选 / 注入文案 / 接线
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanComment, fetchTopComments, formatCommentsBlock, pickComments } from '../src/bili-comments.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const okAsync = async (name, fn) => { await fn(); n++; console.log(`  ✅ ${name}`); };

console.log('清洗：');

ok('去掉表情标记 / 链接 / @某人，压缩空白', () => {
  const out = cleanComment('  200个关羽[笑哭]  搁那争 https://b23.tv/abc @张三 谁最强  ');
  assert.equal(out, '200个关羽 搁那争 谁最强');
});

ok('超长截断，且带省略号', () => {
  const out = cleanComment('啊'.repeat(200), 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('…'));
});

console.log('\n挑选：');

ok('★ 丢掉太短的、纯符号的、重复的，并按赞数降序', () => {
  const raw = [
    { member: { uname: 'A' }, content: { message: '短' }, like: 999 },                     // 太短
    { member: { uname: 'B' }, content: { message: '😂😂😂😂' }, like: 999 },               // 纯符号
    { member: { uname: 'C' }, content: { message: '这条不错，说到点子上了' }, like: 5 },
    { member: { uname: 'D' }, content: { message: '这条不错，说到点子上了' }, like: 50 },   // 重复
    { member: { uname: 'E' }, content: { message: '高赞的那条评论在这里' }, like: 300 }
  ];
  const picked = pickComments(raw, { limit: 3 });
  assert.equal(picked.length, 2, '去重 + 过滤后只剩 2 条');
  assert.equal(picked[0].user, 'E', '赞多的排前面');
  assert.equal(picked[0].likes, 300);
  assert.equal(picked[1].user, 'C');
});

ok('limit 生效，且字段带 user/text/likes/replies', () => {
  const raw = Array.from({ length: 10 }, (_, i) => ({
    member: { uname: `u${i}` }, content: { message: `第${i}条评论内容够长了吧` }, like: i, rcount: i
  }));
  const picked = pickComments(raw, { limit: 3 });
  assert.equal(picked.length, 3);
  assert.deepEqual(Object.keys(picked[0]).sort(), ['likes', 'replies', 'text', 'user']);
});

console.log('\n注入文案：');

ok('空列表返回空字符串（调用方直接跳过，不留空标题）', () => {
  assert.equal(formatCommentsBlock([]), '');
  assert.equal(formatCommentsBlock(null), '');
});

ok('★ 必须自带"观众观点、不是视频内容"的警示（否则模型会把评论当视频内容）', () => {
  const block = formatCommentsBlock([{ user: '甲', text: '说得对，我也这么想', likes: 12 }], { title: 'T' });
  assert.match(block, /\[评论·仅供参考\]/);
  assert.match(block, /不是视频内容/);
  assert.match(block, /以字幕为准/);
  assert.match(block, /👍12/);
  assert.match(block, /甲：「说得对，我也这么想」/);
});

console.log('\n接口与接线：');

await okAsync('aid 不合法时直接返回 no-aid（不发请求）', async () => {
  const r = await fetchTopComments('not-an-aid', { auth: { request: async () => { throw new Error('不该被调用'); } } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-aid');
});

await okAsync('接口 code!=-412/-403 时给出 api-<code>，不抛异常', async () => {
  const fakeAuth = { request: async () => ({ text: async () => JSON.stringify({ code: -404, message: '啥都木有' }) }) };
  const r = await fetchTopComments('123456', { auth: fakeAuth, bvid: 'BV1xx411c7mD' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'api--404');
});

ok('源码守卫：用旧版 x/v2/reply（不需要 WBI 签名），不用 wbi/main；桥接已接线', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const mod = fs.readFileSync(path.join(root, 'src', 'bili-comments.js'), 'utf8');
  assert.match(mod, /x\/v2\/reply\?type=1&oid=/, '要用旧版 reply 接口');
  assert.ok(!/x\/v2\/reply\/wbi\/main\?/.test(mod), '★ 别用 wbi/main（不签名会 -403）');
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /fetchTopComments\(r\.aid/, '预取里要取热评');
  assert.match(bridge, /formatCommentsBlock\(cm\.items/, '要用带警示的格式化');
  assert.match(bridge, /biliAuthRef = biliAuth/, '要把登录态探针注册给模块级预取');
});

console.log(`\n全部通过：${n} 项断言组`);
