// 卡片链接解析的离线回归：各种真实形态的 QQ 卡片 JSON + 兜底路径。
// 用法：node scripts/test-card-link.mjs
import assert from 'node:assert/strict';
import { bilibiliRef, cardSegmentText, describeCard, linksInText, normalizeUrl, parseCard, siteLabel } from '../src/card-link.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

// —— 真实形态样本（按 QQ 分享卡的常见结构手写）——
const CARD_NEWS = JSON.stringify({
  app: 'com.tencent.structmsg',
  desc: '哔哩哔哩',
  view: 'news',
  meta: {
    news: {
      title: '【测试】这个视频很好看',
      desc: '某UP主',
      jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?share_source=qq&share_medium=ipad&vd_source=deadbeef'
    }
  },
  prompt: '[分享]这个视频很好看'
});
const CARD_MINIAPP = JSON.stringify({
  app: 'com.tencent.structmsg',
  meta: {
    detail_1: {
      title: '【动态】今天更新了',
      qqdocurl: 'https://b23.tv/AbCdEf?share_source=qq&share_medium=android&bbid=xxx&ts=1712345678',
      preview: 'https://i0.hdslb.com/bfs/archive/cover.jpg'
    }
  }
});
const CARD_NO_LINK = JSON.stringify({
  app: 'com.tencent.structmsg',
  meta: { detail_1: { title: '只有封面没链接', preview: 'https://multimedia.nt.qq.com.cn/xxx/preview.jpg' } }
});

console.log('卡片链接解析：');

ok('分享卡（meta.news.jumpUrl）能抠出 B 站链接与标题', () => {
  const r = describeCard(CARD_NEWS);
  assert.match(r.url, /^https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD/);
  assert.equal(r.site, 'B站');
  assert.equal(r.title, '【测试】这个视频很好看');
  assert.deepEqual(r.ref, { kind: 'video', bvid: 'BV1xx411c7mD' });
});

ok('小程序卡（detail_1.qqdocurl）优先于封面图，且跟踪参数被剥掉', () => {
  const r = describeCard(CARD_MINIAPP);
  assert.equal(r.url, 'https://b23.tv/AbCdEf');
  assert.equal(r.ref.kind, 'short', 'b23.tv 应识别为短链');
  assert.ok(!/share_source|bbid|ts=/.test(r.url), '跟踪参数必须清掉');
});

ok('没有链接的卡片仍然回退成 [卡片消息]（不改变旧行为）', () => {
  assert.equal(cardSegmentText({ type: 'json', data: { data: CARD_NO_LINK } }), '[卡片消息]');
  assert.equal(cardSegmentText({ type: 'json', data: { data: '{坏掉的 JSON' } }), '[卡片消息]');
  assert.equal(cardSegmentText({}), '[卡片消息]');
  assert.equal(cardSegmentText(undefined), '[卡片消息]');
});

ok('卡片文本形状：[来源卡片：标题｜摘要] URL，且标题截断到 30 字', () => {
  const text = cardSegmentText({ type: 'json', data: { data: CARD_NEWS } });
  // 2026-10-15 起：卡片自带的摘要（desc/summary）也要带上 —— 对没有字幕的视频，它常是唯一内容线索
  // （夹具里还有个 desc='某UP主'，只有 3 字，被"至少 8 字"的规则滤掉了 ✓）
  assert.match(text, /^\[B站卡片：【测试】这个视频很好看｜\[分享\]这个视频很好看\] https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD$/);
  const long = JSON.stringify({ meta: { detail_1: { title: 'x'.repeat(80), qqdocurl: 'https://zhihu.com/question/1' } } });
  const t2 = cardSegmentText({ type: 'json', data: { data: long } });
  assert.match(t2, /^\[知乎卡片：x{30}\] https:\/\/zhihu\.com\/question\/1$/, '没有摘要时不能多出分隔符');
});

ok('normalizeUrl：反转义、剥跟踪参数、拒非法', () => {
  assert.equal(normalizeUrl('https:\\/\\/b23.tv\\/AbC?share_source=qq'), 'https://b23.tv/AbC');
  assert.equal(normalizeUrl('https://a.com/p?utm_source=x&b=1'), 'https://a.com/p?b=1');
  assert.equal(normalizeUrl('ftp://a.com/x'), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl('   '), '');
});

ok('linksInText：URL 遇到 ] / 】 就停（QQ 卡片后面常紧跟"@某人"，别吞进去）', () => {
  // 真实事故样本：卡片文本 + @段 拼在一起后抓成了 https://b23.tv/Oqt2Dxd]@你这辈子…
  assert.deepEqual(linksInText('[B站卡片：标题] https://b23.tv/Oqt2Dxd]@你这辈子就是被红眼睛小女孩毁了'), ['https://b23.tv/Oqt2Dxd']);
  assert.deepEqual(linksInText('[卡片：x] https://b23.tv/AbC】@某人'), ['https://b23.tv/AbC']);
});

ok('linksInText：多链接去重、滤掉图片直链与 QQ 缩略图', () => {
  const text = '看这个 https://b23.tv/AbC 还有 https://b23.tv/AbC?share_source=qq 和 https://i0.hdslb.com/a.jpg 以及 https://multimedia.nt.qq.com.cn/b.png';
  assert.deepEqual(linksInText(text), ['https://b23.tv/AbC']);
});

ok('bilibiliRef：BV / av / 番剧 / 专栏 / 动态 / 短链 都能分类', () => {
  assert.deepEqual(bilibiliRef('https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333'), { kind: 'video', bvid: 'BV1GJ411x7h7' });
  assert.deepEqual(bilibiliRef('https://www.bilibili.com/video/av170001'), { kind: 'video', aid: 170001 });
  assert.equal(bilibiliRef('https://www.bilibili.com/bangumi/play/ep123456').kind, 'bangumi');
  assert.equal(bilibiliRef('https://www.bilibili.com/read/cv123456').kind, 'article');
  assert.equal(bilibiliRef('https://www.bilibili.com/opus/123456789').kind, 'opus');
  assert.equal(bilibiliRef('https://b23.tv/xyz').kind, 'short');
  assert.equal(bilibiliRef('https://www.bilibili.com/').kind, 'other');
  assert.equal(bilibiliRef('https://example.com/x'), null);
});

ok('siteLabel：常见站点认得出，认不出就留空', () => {
  assert.equal(siteLabel('https://b23.tv/x'), 'B站');
  assert.equal(siteLabel('https://www.xiaohongshu.com/x'), '小红书');
  assert.equal(siteLabel('https://mp.weixin.qq.com/s/x'), '公众号');
  assert.equal(siteLabel('https://unknown-site.example/x'), '');
});

ok('parseCard 容错：字符串 / 嵌套 data 字符串 / 对象 三种入参都能解析', () => {
  assert.match(parseCard(CARD_NEWS).url, /bilibili\.com/);
  assert.match(parseCard({ data: CARD_NEWS }).url, /bilibili\.com/);
  assert.match(parseCard({ meta: { news: { jumpUrl: 'https://b23.tv/zzz' } } }).url, /b23\.tv/);
});

console.log(`\n全部通过：${n} 项断言组`);
