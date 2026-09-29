// 只读探活：机器人在群里的身份（能否禁言/发公告）+ 群管理结构 + SnowLuma 相关动作可用性。
// 用法：node scripts/probe-group-admin.mjs [群号]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const groupId = Number(process.argv[2] || cfg.allow?.groups?.[0] || 123456789);
const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = cfg.snowluma?.httpToken || cfg.snowluma?.accessToken || '';

async function call(action, params = {}) {
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000)
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

const login = await call('get_login_info');
const selfId = Number(login.body?.data?.user_id ?? 0);
console.log('机器人:', login.body?.data?.nickname, selfId);

const info = await call('get_group_member_info', { group_id: groupId, user_id: selfId, no_cache: true });
console.log(`\nget_group_member_info(${groupId}, ${selfId}) → HTTP ${info.status}`);
if (info.body?.status === 'ok') {
  const d = info.body.data ?? {};
  console.log(JSON.stringify({ user_id: d.user_id, nickname: d.nickname, card: d.card, role: d.role, level: d.level, title: d.title }, null, 1));
  console.log(d.role === 'owner' || d.role === 'admin' ? '✅ 机器人是管理员/群主 → 禁言与公告能力可用' : '⚠️ 机器人是普通成员 → 禁言/发公告会失败，需要先给管理员');
} else {
  console.log('调用失败:', JSON.stringify(info.body).slice(0, 300));
}

const list = await call('get_group_member_list', { group_id: groupId });
if (list.body?.status === 'ok' && Array.isArray(list.body.data)) {
  const members = list.body.data;
  const byRole = { owner: [], admin: [], member: [] };
  for (const m of members) (byRole[m.role] ?? byRole.member).push(`${m.card || m.nickname}(${m.user_id})`);
  console.log(`\n群成员 ${members.length} 人：群主 ${byRole.owner.length}、管理员 ${byRole.admin.length}、普通 ${byRole.member.length}`);
  console.log('群主:', byRole.owner.join('、'));
  console.log('管理员:', byRole.admin.join('、'));
} else {
  console.log('\nget_group_member_list 调用失败:', JSON.stringify(list.body).slice(0, 200));
}

// 只探活"命令是否被网关认识"：故意用非法参数触发校验错误（user_id=0 / 空正文），不会真的禁言或发公告。
const banProbe = await call('set_group_ban', { group_id: groupId, user_id: 0, duration: 60 });
console.log('\nset_group_ban 参数校验探测（user_id=0，不会真的禁言）→', banProbe.body?.retcode, String(banProbe.body?.wording ?? '').slice(0, 120));
const noticeProbe = await call('_send_group_notice', { group_id: groupId, content: '' });
console.log('_send_group_notice 参数校验探测 →', noticeProbe.body?.retcode, String(noticeProbe.body?.wording ?? '').slice(0, 120));
const getNotice = await call('_get_group_notice', { group_id: groupId });
console.log('_get_group_notice →', getNotice.body?.status, Array.isArray(getNotice.body?.data) ? `现有 ${getNotice.body.data.length} 条公告` : JSON.stringify(getNotice.body).slice(0, 160));
