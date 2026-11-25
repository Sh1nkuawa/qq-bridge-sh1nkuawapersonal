// agy-touch.mjs —— 续租正在处理的回合（POST /api/agy/touch）
//
// 用途：长任务（看图/生图/复杂推理超过几分钟）每 2~3 分钟续租一次，防止 10 分钟租约过期被重排。
// 用法：
//   node scripts/agy-touch.mjs --turn-id t-20261125-05-0001 --persona 小鲸鱼
//   node scripts/agy-touch.mjs --turn-id t-20261125-05-0001 --persona 小鲸鱼 --worker-id agy-小鲸鱼

import {
  apiPost,
  appendWorkerLog,
  argOf,
  readConsoleToken,
  resolveBaseUrl,
  resolvePersona,
  resolveWorkerId
} from './agy-lib.mjs';

const turnId = String(argOf('turn-id') ?? '').trim();
const persona = resolvePersona(argOf('persona'));
const workerId = resolveWorkerId(persona, argOf('worker-id'));
const baseUrl = resolveBaseUrl(argOf('base-url'));

if (!turnId) {
  console.error(JSON.stringify({ ok: false, error: 'bad-request', message: '缺少 --turn-id' }));
  process.exit(1);
}

let token;
try {
  token = readConsoleToken(argOf('token-file'));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: 'token-unavailable', message: err.message }));
  process.exit(1);
}

const res = await apiPost({
  baseUrl,
  token,
  pathname: '/api/agy/touch',
  payload: { turnId, workerId }
});

if (res.http === 200 && res.body?.ok) {
  appendWorkerLog({
    workerId,
    persona,
    event: 'touch',
    extra: { turnId, leaseUntil: res.body.leaseUntil ?? null, ok: true },
    secretToken: token
  });
  console.log(JSON.stringify({ ok: true, turnId, leaseUntil: res.body.leaseUntil ?? null }));
  process.exitCode = 0;
} else {
  const errCode = String(res.body?.error ?? `http-${res.http}`);
  appendWorkerLog({
    workerId,
    persona,
    event: 'error',
    extra: { where: 'touch', turnId, http: res.http, error: errCode },
    secretToken: token
  });
  console.log(JSON.stringify({ ok: false, turnId, http: res.http, error: errCode }));
  process.exitCode = res.http === 404 || res.http === 409 ? 0 : 1;
}
