// 只读探活：只验证"禁言动作能不能被 QQ 侧正确理解"，不会禁言任何真人。
// 手法：对一个**不在群里**的 QQ 号发禁言请求 —— QQ 会回"成员不存在"之类的业务错误，
// 说明动作名/参数格式是对的（如果动作名写错，返回的是 unknown action / 参数校验错）。
// 用法：node scripts/probe-ban-plumbing.mjs [群号]
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

const FAKE = 99999999;
console.log(`目标是"不在群里的 QQ ${FAKE}"，不可能真的禁言到谁。`);
const r = await call('set_group_ban', { group_id: groupId, user_id: FAKE, duration: 60 });
console.log(`set_group_ban → HTTP ${r.status}, status=${r.body?.status}, retcode=${r.body?.retcode}, wording=${String(r.body?.wording ?? '').slice(0, 160)}`);
const retcode = Number(r.body?.retcode);
if (retcode === 1404 || /unknown action/i.test(String(r.body?.wording ?? ''))) {
  console.log('❌ 动作名不被识别（网关不认识 set_group_ban）');
  process.exit(1);
}
if (retcode === 1400) {
  console.log('⚠️ 参数校验失败（1400）——参数格式可能不对，需要检查');
  process.exit(1);
}
console.log('✅ 动作被 QQ 侧理解（业务级失败＝权限/成员不存在等），说明禁言链路可用');
