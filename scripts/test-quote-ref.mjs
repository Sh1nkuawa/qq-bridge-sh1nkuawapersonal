// 引用消息"身份证"的离线回归（纯函数 + 源码接线守卫）。
// 事故背景：2026-10-11 引用图片时，引用段只有「[引用 某人]」→ 模型对 5 个 id 挨个猜。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildQuoteText, describeMediaList, parseQuotedRefs, quoteMediaHint } from '../src/quote-ref.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

console.log('引用消息身份证：');

ok('describeMediaList：数附件类型', () => {
  assert.equal(describeMediaList([{ kind: 'image' }]), '图片');
  assert.equal(describeMediaList([{ kind: 'image' }, { kind: 'image' }]), '图片×2');
  assert.equal(describeMediaList([{ kind: 'image' }, { kind: 'face' }, { kind: 'face' }]), '图片、表情×2');
  assert.equal(describeMediaList([]), '');
  assert.equal(describeMediaList(null), '');
  assert.equal(describeMediaList([{ kind: 'weird' }]), 'weird');
  assert.equal(describeMediaList([{ kind: 'face' }, { kind: 'video' }], { max: 1 }), '表情');
});

ok('buildQuoteText：★图片消息（无文字）也要带上 quotedId 与附件类型 —— 这就是本次修的核心', () => {
  const t = buildQuoteText({ sender: '你这辈子就是被红眼睛小女孩毁了', text: '', messageId: '-1370457565', media: [{ kind: 'image' }] });
  assert.equal(t, '[引用 你这辈子就是被红眼睛小女孩毁了｜附件：图片｜quotedId=-1370457565]');
});

ok('buildQuoteText：有文字时保持可读；没有附件也带 id', () => {
  assert.equal(
    buildQuoteText({ sender: '张三', text: '看这个', messageId: '123', media: [] }),
    '[引用 张三：看这个｜quotedId=123]'
  );
  assert.equal(
    buildQuoteText({ sender: '张三', text: '这个表情啥意思', messageId: '456', media: [{ kind: 'face' }] }),
    '[引用 张三：这个表情啥意思｜附件：表情｜quotedId=456]'
  );
});

ok('buildQuoteText：长文本截断、危险字符被清掉、全空回退', () => {
  const long = buildQuoteText({ sender: 'a', text: 'x'.repeat(100), messageId: '1' });
  assert.ok(long.length < 90, '不该超长');
  assert.match(long, /x{60}/);
  const dirty = buildQuoteText({ sender: 'a｜b', text: 'c]d', messageId: '1' });
  assert.ok(dirty.includes('a b'), '发件人里的 ｜ 要被清成空格');
  assert.ok(dirty.includes('c d'), '正文里的 ] 要被清成空格');
  assert.match(dirty, /quotedId=1\]$/, '结尾结构仍然完整');
  assert.equal(buildQuoteText({}), '[引用消息]');
});

ok('parseQuotedRefs：能把自己拼的文本原样读回来；老格式（无 id）不算引用', () => {
  const built = buildQuoteText({ sender: '张三', text: '', messageId: '999', media: [{ kind: 'image' }, { kind: 'face' }] });
  const refs = parseQuotedRefs(`前面的话 ${built} 后面的话`);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].messageId, '999');
  assert.equal(refs[0].media, '图片、表情');
  assert.equal(refs[0].sender, '张三');
  assert.deepEqual(parseQuotedRefs('[引用 某人]'), [], '老格式没有 id/附件 → 不产生引用信息');
  assert.deepEqual(parseQuotedRefs(''), []);
});

ok('quoteMediaHint：给模型的话必须点名 quotedId，并禁止瞎猜', () => {
  const hint = quoteMediaHint({ sender: '张三', messageId: '-1370457565', media: '图片' });
  assert.match(hint, /quotedId=-1370457565/);
  assert.match(hint, /qq_get_message_images/);
  assert.match(hint, /不要.*挨个试|不要.*猜/);
  assert.equal(quoteMediaHint({ messageId: '1', media: '' }), '', '没有附件就不该插话');
  const noId = quoteMediaHint({ sender: '张三', media: '图片' });
  assert.match(noId, /如实说看不到/, '没 id 时要诚实，而不是瞎猜');
});

ok('源码守卫：bridge 两处调用都传了 lookupMedia，提示里接上了 quotedLine', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.equal((src.match(/lookupMedia: lookupQuotedMedia/g) ?? []).length, 2, 'textContent 与 plainContent 都要传');
  assert.match(src, /const lookupQuotedMedia = \(ref\) => messageMediaStore\.get\(key\)\?\.get\(String\(ref\)\)/);
  assert.match(src, /buildQuoteText\(\{/, '引用段要用 buildQuoteText');
  assert.match(src, /const quotedLine = \(\(\) => \{/);
  assert.match(src, /wakeLine \+ quotedLine \+ linkLine/, 'quotedLine 必须接进提示');
});

console.log(`\n全部通过：${n} 项断言组`);
