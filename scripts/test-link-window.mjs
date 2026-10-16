// 链接窗口必须读 v2 存储 —— 事故回归
// 2026-10-16：linkLine 读的是 social.recentMessages（v1 老 Map，reserved2 下基本空），
// 而卡片记在 st.recentMessages（v2）⇒ uniq 永远为空 ⇒ 全部 B 站提示（别 web_fetch /
// 别裸抓字幕接口 / 摘要可能是 null / 以字幕为准）**从未被注入** ✗
// 日志铁证：每次都是 `注入提示：0 条链接` ✓（而卡片明明在 v2 窗口里）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

console.log('linkLine 的消息窗口：');

ok('★ 必须读 v2 的 recentMessages（卡片记在那里）', () => {
  assert.match(bridge, /const stForLinks = getSocialV2State\(key\);/, '要先取 v2 状态');
  assert.match(bridge, /Array\.isArray\(stForLinks\?\.recentMessages\)/, '要用 v2 的 recentMessages');
  assert.ok(!/const recent = \(social\.recentMessages\.get\(key\) \?\? \[\]\)\.slice\(-15\);/.test(bridge),
    '★ 不许再直接读 v1 的 social.recentMessages（这就是 bug 本体）');
});

ok('★ B 站提示不能只看 uniq（它可能为空），要看"有没有 B 站链接/预取结果"', () => {
  assert.match(bridge, /uniq\.some\(\(u\) => bilibiliRef\(u\)\) \|\| summaries\.some\(\(x\) => bilibiliRef\(x\.url\)\)/,
    '门禁条件要带上 summaries');
});

ok('提示文案要与我们现在的行为一致（会附字幕，且以字幕为准）', () => {
  assert.match(bridge, /以字幕为准/, '要写明以字幕为准');
  assert.ok(!/没有字幕或转写/.test(bridge), '★ 删掉"没有字幕或转写"那句 —— 它和我们现在会附字幕的行为冲突');
  assert.match(bridge, /没有 `\[字幕…\]` 段时/, '要给出"确实没字幕时"的说法');
});

ok('原有的几条关键约束都还在', () => {
  for (const t of ['B 站链接不要用 web_fetch', '短链（b23.tv/xxx）也算 B 站', '字段直接是 null', '不要自己去抓 B 站的字幕接口']) {
    assert.ok(bridge.includes(t), `缺少约束：${t}`);
  }
});

console.log(`\n全部通过：${n} 项断言组`);
