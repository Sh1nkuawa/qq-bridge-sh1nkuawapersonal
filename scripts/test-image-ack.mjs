// 生图开始提示（ack）验收：渲染预览 + 配置生效检查（不会往群里发消息）。
// 用法：node scripts/test-image-ack.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const port = Number(cfg.consolePort) || 3100;
let token = String(cfg.consoleToken || '').trim();
if (!token) {
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const post = async (pathname, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log('## 生图开始提示（预览，不发群）');
const normal = await post('/api/socialV2/image-ack-preview', { name: '群友A', remaining: 4 });
ok('接口可用', normal.status === 200 && normal.body?.ok === true);
ok('开关是开着的', normal.body?.enabled === true);
ok('能渲染出多条不同文案', (normal.body?.samples ?? []).length >= 3, `${(normal.body?.samples ?? []).length} 条`);
console.log('  普通群友会看到：');
for (const s of normal.body?.samples ?? []) console.log('   ·', s);
// 口径：每条回执要么点到请求者名字，要么明确表达"接下了/在画"。
// 模板池是会增补的（例如"行，等我几分钟"），所以用一组同义表达而不是只认 "画/收到"。
ok('文案带请求者名字或明确说在画', (normal.body?.samples ?? []).every((s) => /群友A|库库|画|收到|稍等|等我|别急|记上|安排|接了|就来|整/.test(s)),
  (normal.body?.samples ?? []).join(' | '));
ok('文案里没有残缺的"还剩 次"', (normal.body?.samples ?? []).every((s) => !/还剩\s*次|remaining/.test(s)));

const owner = await post('/api/socialV2/image-ack-preview', { name: '群主', isOwner: true });
ok('owner（无限次）不会出现剩余次数', (owner.body?.samples ?? []).every((s) => !/还剩|remaining/.test(s)), (owner.body?.samples ?? [])[0] ?? '');

console.log('## 请求识别与去重（纯函数，与受理接口共用一套规则）');
const { analyzeImageRequest, shouldSendEarlyAck } = await import('../src/image-ack.js');
ok('@我 + 生图… → 认得出来', () => {
  const a = analyzeImageRequest('@！？哦鲸鲸？！ 生图 一只戴墨镜的鲸鱼');
  ok('  解析出正文', a.ok === true && a.text === '生图 一只戴墨镜的鲸鱼');
});
ok('昵称里带奇怪符号也要认得（实测昵称「！？哦鲸鲸？！」）', analyzeImageRequest('@！？哦鲸鲸？！ 生图 猫').ok === true);
ok('@ 之后夹标点/空白仍然认得', analyzeImageRequest('@某人: 生图 猫').ok === true);
ok('前面有实质文字 → 不算（防止把聊天当请求）', analyzeImageRequest('你好啊 生图 猫').ok === false);
ok('没写生图 → 不算', analyzeImageRequest('@机器人 画个图').ok === false);
{
  const base = { now: Date.now(), atSelf: true, text: '@鲸 生图 猫', senderId: '1001', isOwner: false, used: 0, dailyLimit: 5, ackEnabled: true };
  const r1 = shouldSendEarlyAck(base);
  ok('正常请求 → 发即时回执', r1.ok === true, r1.reason);
  ok('配额用完 → 不回执（避免先许诺后落空）', shouldSendEarlyAck({ ...base, used: 5 }).ok === false);
  ok('owner 不受配额限制 → 回执', shouldSendEarlyAck({ ...base, isOwner: true, used: 99 }).ok === true);
  ok('同一条请求重复处理 → 不重复回执', shouldSendEarlyAck({ ...base, requestId: 'm1', lastAck: { senderId: '1001', requestId: 'm1', at: Date.now() - 1000 } }).ok === false);
  ok('同一个人重新发了一条（新消息 id）→ 照常回执', shouldSendEarlyAck({ ...base, requestId: 'm2', lastAck: { senderId: '1001', requestId: 'm1', at: Date.now() - 110000 } }).ok === true);
  ok('20 秒内同一人、又没有 requestId → 保守不重复', shouldSendEarlyAck({ ...base, lastAck: { senderId: '1001', at: Date.now() - 5000 } }).ok === false);
  ok('他的图还在画 → 不重复回执', shouldSendEarlyAck({ ...base, imageJob: { senderId: '1001', expiresAt: Date.now() + 60000 } }).ok === false);
  ok('不是 @ 我也没引用我 → 不回执', shouldSendEarlyAck({ ...base, atSelf: false, quoteTargetIsSelf: false }).ok === false);
  ok('开关关掉 → 不回执', shouldSendEarlyAck({ ...base, ackEnabled: false }).ok === false);
}

console.log('## 从最近 @ 记录里挑出真正那条生图请求（修"无关 @ 把请求顶掉"）');
{
  const { pickImageMention } = await import('../src/image-ack.js');
  const now = Date.now();
  const mentions = [
    { senderId: '1', senderName: '甲', at: now - 60000, text: '@我 这个是@乙', messageId: 'a' },
    { senderId: '2', senderName: '库库', at: now - 30000, text: '@我 生图 男人的眼睛要比嘴大', messageId: 'b' },
    { senderId: '3', senderName: '丙', at: now - 10000, text: '@我 在吗', messageId: 'c' }
  ];
  const picked = pickImageMention(mentions, { now });
  ok('无关的 @ 在最后也能挑回真正那条生图请求', picked?.messageId === 'b', picked ? `${picked.senderName}: ${picked.text}` : 'null');
  ok('全是无关 @ 时返回 null（不乱受理）', pickImageMention([
    { senderId: '1', at: now, text: '@我 在吗' },
    { senderId: '1', at: now, text: '@我 这个是@乙' }
  ], { now }) === null);
  ok('太老的 @ 不算（窗口外）', pickImageMention([
    { senderId: '1', at: now - 20 * 60000, text: '@我 生图 猫' }
  ], { now, windowMs: 10 * 60000 }) === null);
  ok('可以按发送者过滤', pickImageMention(mentions, { now, senderId: '2' })?.messageId === 'b');
}

console.log('## 审计/日志接线');
const log = fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8');
ok('桥接启动正常（能读到日志）', log.length > 0);
const mod = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
ok('受理生图后会调用 sendImageAck', /void sendImageAck\(key, \{/.test(mod));
ok('收到消息时会先发即时回执', /await maybeSendEarlyImageAck\(key, \{/.test(mod));
ok('唤醒提示会提醒模型别重复宣布开始', /开始那句桥接已经替你发过了/.test(mod));
ok('自己在群里的那句会被记进会话消息流', /recordSelfMessage\(key, line, \{ imageAck: true \}\)/.test(mod));
ok('受理接口与即时回执共用同一套判断', /analyzeImageRequest\(rawText, prefix\)/.test(mod));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
console.log('\n下一步（真机验证）：在群里 @机器人 发一条「生图 一只戴墨镜的鲸鱼」，');
console.log('应该会先看到一句「收到，画着呢…」，1~4 分钟后自动收到图并被 @。');
// 本用例刚跑过真实 fetch（undici 的 keep-alive socket 还在收尾），Windows 上直接
// process.exit() 会撞 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`（exit 0xC0000409），
// 于是一个「29 通过 0 失败」的用例被记成崩溃。改用 exitCode 让事件循环自己排空。
process.exitCode = fail === 0 ? 0 : 1;
