// 引用消息里的链接必须完整 —— 事故现场回归
// 2026-10-16：群友**引用**了一张旧 B 站卡片，卡片正文超过 60 字 ⇒ buildQuoteText 的
// `.slice(0, 60)` 把 https://b23.tv/BT9EUTI 切成 https://b23.tv/B ✗ ⇒ 预取报
// "不是 B 站视频链接" ⇒ 白引用一次（机器人只能说"只有标题"）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildQuoteText, parseQuotedRefs } from '../src/quote-ref.js';
import { linksInText } from '../src/card-link.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

console.log('引用段里的链接：');

ok('★ 正文超长时，URL 必须原样保留（事故原文回归）', () => {
  const text = '[B站卡片：哔哩哔哩｜[QQ小程序]大肥鱼宕机了，GPT没额度了，奶黄包...算了吧] https://b23.tv/BT9EUTI';
  const q = buildQuoteText({ sender: '某人', text, messageId: '-1003003063', maxText: 60 });
  assert.ok(q.includes('https://b23.tv/BT9EUTI'), '完整链接必须在：' + q);
  assert.deepEqual(linksInText(q), ['https://b23.tv/BT9EUTI'], 'linksInText 要能抠出完整链接');
  assert.equal(parseQuotedRefs(q)[0]?.messageId, '-1003003063', 'quotedId 仍要能解析出来');
  assert.equal(parseQuotedRefs(q)[0]?.sender, '某人', '发件人仍要能解析出来');
});

ok('正文仍然截断（链接不许把正文挤出预算，但截断规则不变）', () => {
  const long = '一二三四五六七八九十'.repeat(8);
  const q = buildQuoteText({ sender: '甲', text: long, messageId: '1', maxText: 20 });
  const body = parseQuotedRefs(q)[0]?.text ?? '';
  assert.equal(body.length, 20, '无链接时正文照旧截到 maxText');
});

ok('多个链接：默认最多带 2 个，且都完整；不新增 ｜ 段（否则会破坏解析）', () => {
  const q = buildQuoteText({
    sender: '乙',
    text: '看这两个 https://b23.tv/AAAAAAA 和 https://b23.tv/BBBBBBB 还有 https://b23.tv/CCCCCCC',
    messageId: '2',
    maxText: 10
  });
  const links = linksInText(q);
  assert.equal(links.length, 2, '默认最多 2 个：' + JSON.stringify(links));
  assert.ok(links.every((u) => /^https:\/\/b23\.tv\/[A-Z]{7}$/.test(u)), '每个都要完整：' + JSON.stringify(links));
  const segs = q.replace(/^\[引用 |\]$/g, '').split('｜');
  assert.equal(segs.length, 2, '只应有 正文/quotedId 两段（链接并入正文）');
  assert.ok(parseQuotedRefs(q).length === 1, '解析不能被破坏');
});

ok('链接末尾的标点要修掉（中文句读不算 URL 的一部分）', () => {
  const q = buildQuoteText({ sender: '丙', text: '见 https://b23.tv/DDDDDDD。', messageId: '3' });
  assert.deepEqual(linksInText(q), ['https://b23.tv/DDDDDDD']);
});

ok('源码守卫：注释里写明这是 2026-10-16 那次事故', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const mod = fs.readFileSync(path.join(root, 'src', 'quote-ref.js'), 'utf8');
  assert.match(mod, /链接绝不能切一半/, '要写明理由');
  assert.match(mod, /BT9EUTI/, '带上事故里的真实样本，方便后来人对号');
});

console.log(`\n全部通过：${n} 项断言组`);
