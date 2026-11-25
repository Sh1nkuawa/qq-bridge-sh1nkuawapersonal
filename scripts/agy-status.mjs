// agy-status.mjs —— 查询桥接 AGY 传输层健康状态（GET /api/agy/status）
//
// 用法：
//   node scripts/agy-status.mjs
//   node scripts/agy-status.mjs --persona 小鲸鱼 --base-url http://127.0.0.1:3100

import {
  apiGet,
  appendWorkerLog,
  argOf,
  hasFlag,
  readConsoleToken,
  resolveBaseUrl,
  resolvePersona,
  resolveWorkerId
} from './agy-lib.mjs';

const persona = resolvePersona(argOf('persona'));
const workerId = resolveWorkerId(persona, argOf('worker-id'));
const baseUrl = resolveBaseUrl(argOf('base-url'));
const quiet = hasFlag('quiet');
const logFlag = hasFlag('log');

let token;
try {
  token = readConsoleToken(argOf('token-file'));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: 'token-unavailable', message: err.message }));
  process.exit(1);
}

const res = await apiGet({
  baseUrl,
  token,
  pathname: '/api/agy/status',
  timeoutMs: 15000
});

if (logFlag || res.http !== 200) {
  appendWorkerLog({
    workerId,
    persona,
    event: res.http === 200 ? 'status' : 'error',
    extra: res.http === 200
      ? { http: 200, onDuty: res.body?.onDuty ?? null, transport: res.body?.transport ?? null }
      : { where: 'status', http: res.http, error: res.body?.error ?? `http-${res.http}` },
    secretToken: token
  });
}

if (!quiet) {
  console.log(JSON.stringify(res.body ?? { ok: false, http: res.http }, null, 2));
}

process.exitCode = res.http === 200 && res.body?.ok ? 0 : 1;
