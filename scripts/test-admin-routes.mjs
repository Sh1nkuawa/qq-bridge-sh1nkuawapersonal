// 群管理路由验收（不会真的禁言；公告只走"起草→校验→作废"，不发布）。
// 用法：node scripts/test-admin-routes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const port = Number(cfg.consolePort) || 3100;
let token = String(cfg.consoleToken || '').trim();
if (!token) {
  try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
}
const base = `http://127.0.0.1:${port}`;
const KEY = Object.keys(state.conversations ?? {})[0] || 'group:123456789';
const agentToken = state.conversations?.[KEY]?.agentToken ?? '';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
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

console.log('## admin-status（控制台 + AI 都能读）');
const st = await api('/api/socialV2/admin-status?key=' + encodeURIComponent(KEY));
ok('HTTP 200', st.status === 200, `status=${st.status}`);
ok('报告机器人在群里的身份', typeof st.body?.botRole === 'string', `botRole=${st.body?.botRole} canManage=${st.body?.canManage}`);
ok('当前是干跑模式', st.body?.dryRun === true);
ok('能读到当前群公告', st.body?.currentNotice?.ok === true, `共 ${st.body?.currentNotice?.count ?? 0} 条，最新 ${String(st.body?.currentNotice?.text ?? '').slice(0, 40).replace(/\n/g, ' ')}`);

console.log('## 非管理员时必须拒绝执行');
if (st.body?.botRole !== 'admin') {
  const mute = await api('/api/socialV2/mute', { method: 'POST', body: JSON.stringify({ key: KEY, userId: '99999999', minutes: 1 }) });
  ok('手动禁言被拒（机器人不是管理员）', mute.status === 409 || mute.body?.ok === false, mute.body?.error ?? '');
} else {
  console.log('  （跳过：机器人已是管理员，交给人工用控制台按钮做真测）');
}

console.log('## mute-request：模型提议必须过证据核验');
const noToken = await api('/api/socialV2/mute-request', { method: 'POST', body: JSON.stringify({ key: KEY, userId: '99999999', reason: '测试' }) });
ok('不带 agent token 的提议被拒', noToken.status === 403, noToken.body?.error ?? '');
if (agentToken) {
  const badEvidence = await api('/api/socialV2/mute-request', { method: 'POST', headers: { 'x-agent-token': agentToken }, body: JSON.stringify({ key: KEY, userId: '99999999', reason: '我看他不爽' }) });
  ok('证据不足被拒（403 + 说明）', badEvidence.status === 403 && /证据不足/.test(badEvidence.body?.error ?? ''), badEvidence.body?.error ?? '');
}

console.log('## 公告：校验 + 待审 + 作废（不发布）');
const empty = await api('/api/socialV2/announcement/propose', { method: 'POST', body: JSON.stringify({ content: '   ' }) });
ok('空正文被拒', empty.status === 400, empty.body?.error ?? '');
const withLink = await api('/api/socialV2/announcement/propose', { method: 'POST', body: JSON.stringify({ content: '更新啦，详见 https://example.com' }) });
ok('默认禁链接', withLink.status === 400 && /链接/.test(withLink.body?.error ?? ''), withLink.body?.error ?? '');
const atAll = await api('/api/socialV2/announcement/propose', { method: 'POST', body: JSON.stringify({ content: '@全体成员 上线了' }) });
ok('禁止 @全体', atAll.status === 400 && /全体/.test(atAll.body?.error ?? ''), atAll.body?.error ?? '');
// 注意：这里只能动"本脚本自己创建的草稿"。已有真实待审草稿（比如 owner 正在审的那份）时，
// 绝不 propose / reject，只做只读检查 —— 免得把别人等着批的公告作废掉。
const pre = await api('/api/socialV2/announcement');
const realPending = pre.body?.pending ?? null;
if (realPending) {
  console.log(`  ⚠️ 已有一份待审草稿（id=${realPending.id}，来源 ${realPending.source}）→ 跳过"创建/作废"，只做只读检查`);
  ok('已有待审草稿可查（含正文）', typeof realPending.content === 'string' && realPending.content.length > 0, `${realPending.content.length} 字`);
  ok('已有待审草稿时其它接口照常', st.status === 200);
} else {
  const good = await api('/api/socialV2/announcement/propose', { method: 'POST', body: JSON.stringify({ content: '【测试草稿·请忽略】\n这是一条路由自检用的公告草稿，不会发布。' }) });
  ok('合法草稿进入待审', good.body?.ok === true && Boolean(good.body?.pending?.id), good.body?.diff ?? good.body?.error ?? '');
  const createdId = good.body?.pending?.id ?? null;
  const list = await api('/api/socialV2/announcement');
  ok('待审草稿可查', list.body?.pending?.id === createdId);
  if (!createdId) {
    ok('可以作废草稿', false, '没有拿到待审 id');
  } else if (list.body?.pending?.id !== createdId) {
    console.log('  ⚠️ 期间待审草稿被替换，跳过作废（不碰别人的草稿）');
  } else {
    const rejected = await api('/api/socialV2/announcement/reject', { method: 'POST', body: JSON.stringify({ reason: '路由自检' }) });
    ok('可以作废草稿', rejected.body?.ok === true);
    const after = await api('/api/socialV2/announcement');
    ok('作废后没有待审', after.body?.pending === null);
  }
}

console.log('## 审计日志');
const log = await api('/api/socialV2/moderation-log?limit=10');
ok('HTTP 200 且有记录结构', log.status === 200 && Array.isArray(log.body?.records), `共 ${log.body?.total ?? 0} 条`);
ok('审计里能看到刚才的拒绝/跳过记录', (log.body?.records ?? []).some((r) => r.action === 'announce' || r.action === 'skip'));

console.log('## qq_get_prompt 里的群管理信息');
if (agentToken) {
  const res = await fetch(`${base}/api/socialV2/prompt?key=${encodeURIComponent(KEY)}`, {
    headers: { 'x-agent-token': agentToken, 'x-console-token': token },
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(() => null);
  ok('prompt 里带 admin 段', body?.ok === true && body?.admin && typeof body.admin === 'object', JSON.stringify({ role: body?.admin?.botRole, dryRun: body?.admin?.dryRun }) );
  ok('enabledTools 含三个群管理工具', ['qq_group_admin_info', 'qq_request_mute', 'qq_propose_announcement'].every((n) => (body?.enabledTools ?? []).includes(n)), (body?.enabledTools ?? []).filter((n) => n.includes('admin') || n.includes('mute') || n.includes('announce')).join(', '));
  ok('prompt 明确列出"绝对不许"的能力', Array.isArray(body?.admin?.neverAllowed) && body.admin.neverAllowed.length >= 4, (body?.admin?.neverAllowed ?? []).join('/'));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
