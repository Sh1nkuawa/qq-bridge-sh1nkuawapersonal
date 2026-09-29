// 看桥接的挂起队列 / 处理情况，必要时重置卡住的会话
import fs from 'node:fs';

const TOKEN = fs.readFileSync('D:/dsh/qq-bridge/state/console-token', 'utf8').trim();
const BASE = 'http://127.0.0.1:3100';
const ACT = process.argv[2]; // 空=只查看；reset=重置会话

async function api(pathname, method = 'GET', body) {
  const r = await fetch(`${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}token=${TOKEN}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}

const pend = await api('/api/pending');
console.log('=== /api/pending ===');
console.log(JSON.stringify(pend.json ?? pend.text, null, 2).slice(0, 2500));

const sess = await api('/api/sessions');
console.log('\n=== /api/sessions ===');
console.log(JSON.stringify(sess.json ?? sess.text, null, 2).slice(0, 1500));

const sv2 = await api('/api/socialV2/state?key=group:' + (process.env.QQ_GROUP || '123456789'));
console.log('\n=== /api/socialV2/state (group:' + (process.env.QQ_GROUP || '123456789') + ') ===');
console.log(JSON.stringify(sv2.json ?? sv2.text, null, 2).slice(0, 2500));

if (ACT === 'reset') {
  console.log('\n=== 重置会话上下文 ===');
  const r = await api('/api/session/reset', 'POST', { key: 'group:' + (process.env.QQ_GROUP || '123456789') });
  console.log(JSON.stringify(r.json ?? r.text, null, 2));

  // 顺带清掉社交 V2 的卡住状态
  const r2 = await api('/api/socialV2/reset', 'POST', { key: 'group:' + (process.env.QQ_GROUP || '123456789') });
  console.log('\n=== socialV2/reset ===');
  console.log(JSON.stringify(r2.json ?? r2.text, null, 2));
}
