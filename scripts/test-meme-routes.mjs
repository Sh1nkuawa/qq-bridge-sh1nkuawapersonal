// 桥接「本地表情包」路由验收（只读/只做校验路径，不会真发消息到 QQ）。
//
// 用法：node scripts/test-meme-routes.mjs
// 前置：桥接正在运行（控制台端口可达）。
//
// 覆盖：meme-list（正常/缺 tag）、meme-image（正常/目录穿越）、send-meme（缺 token/假 token）、
//       meme-test-send（非法 key / 非白名单目标）。真发送请用控制台「发一张试试」按钮。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = Number(cfg.consolePort) || 3100;
let token = String(cfg.consoleToken || '').trim();
if (!token) {
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); } else { fail += 1; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-console-token': token, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs || 20000)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

console.log('## meme-list');
const list = await api('/api/socialV2/meme-list?key=group:123456789&tag=happy&limit=3');
ok('HTTP 200', list.status === 200, `status=${list.status}`);
ok('返回 3 个候选', list.body?.candidates?.length === 3, `mood=${list.body?.mood} total=${list.body?.total}`);
ok('候选含 path/caption/mood', Boolean(list.body?.candidates?.[0]?.path && list.body?.candidates?.[0]?.mood), JSON.stringify(list.body?.candidates?.[0] ?? {}).slice(0, 120));
const first = list.body?.candidates?.[0];

const noTag = await api('/api/socialV2/meme-list?key=group:123456789&query=完全不相干的词xyz');
ok('无情绪时给出情绪字典提示（不是 500）', noTag.body?.ok === false && typeof noTag.body?.error === 'string', noTag.body?.error ?? '');

console.log('## meme-image');
const img = await api(`/api/socialV2/meme-image?key=group:123456789&path=${encodeURIComponent(first?.path ?? '')}`);
const b64 = img.body?.image?.data ?? '';
const head = Buffer.from(b64.slice(0, 24), 'base64');
const isJpeg = head[0] === 0xFF && head[1] === 0xD8;
ok('HTTP 200 且返回图片字节（jpeg 魔数）', img.status === 200 && isJpeg && b64.length > 1000, `mime=${img.body?.image?.mimeType} bytes≈${Math.round(b64.length * 0.75)}`);
const traversal = await api('/api/socialV2/meme-image?key=group:123456789&path=' + encodeURIComponent('../../../../windows/win.ini'));
ok('目录穿越被拒绝', traversal.body?.ok === false, traversal.body?.error ?? '');

console.log('## send-meme（校验路径，不发消息）');
const noToken = await api('/api/socialV2/send-meme', { method: 'POST', body: JSON.stringify({ key: 'group:123456789', path: first?.path }) });
ok('缺 agent token 被拒', noToken.status === 403 && /agent token/.test(noToken.body?.error ?? ''), noToken.body?.error ?? '');
const badToken = await api('/api/socialV2/send-meme', { method: 'POST', headers: { 'x-agent-token': 'deadbeef' }, body: JSON.stringify({ key: 'group:123456789', path: first?.path }) });
ok('假 agent token 被拒', badToken.status === 403, badToken.body?.error ?? '');
const withText = await api('/api/socialV2/send-meme', { method: 'POST', headers: { 'x-agent-token': 'deadbeef' }, body: JSON.stringify({ key: 'group:123456789', path: first?.path, message: '配一句话' }) });
ok('带文字的图片消息被拒（无论 token 真假先拦）', withText.status === 400 || withText.status === 403, `status=${withText.status} ${withText.body?.error ?? ''}`);

console.log('## meme-test-send（控制台专用，校验目标）');
const badKey = await api('/api/socialV2/meme-test-send', { method: 'POST', body: JSON.stringify({ key: 'nonsense', tag: 'happy' }) });
ok('非法 key 返回 400', badKey.status === 400, badKey.body?.error ?? '');
const notAllowed = await api('/api/socialV2/meme-test-send', { method: 'POST', body: JSON.stringify({ key: 'private:100000001', tag: 'happy' }) });
ok('非白名单私聊被拒 403（说明路由已接线、白名单生效）', notAllowed.status === 403, notAllowed.body?.error ?? '');
const agentCantUseTest = await api('/api/socialV2/meme-test-send', { method: 'POST', headers: { 'x-agent-token': 'deadbeef' }, body: JSON.stringify({ key: 'group:123456789', tag: 'happy' }) });
ok('AI 不能用控制台测试接口', agentCantUseTest.status === 403, agentCantUseTest.body?.error ?? '');

console.log('## 日志');
const logTail = fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8').split('\n').slice(-400).join('\n');
ok('日志里有图库载入记录', /\[meme\] 本地图库已载入 \d+ 张/.test(logTail), (logTail.match(/\[meme\][^\n]*/) ?? ['(无)'])[0]);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
// 本用例刚跑过真实 fetch，Windows 上直接 process.exit() 会撞 libuv 断言
// `!(handle->flags & UV_HANDLE_CLOSING)`（0xC0000409），把「13 通过 0 失败」记成崩溃。
process.exitCode = fail === 0 ? 0 : 1;
