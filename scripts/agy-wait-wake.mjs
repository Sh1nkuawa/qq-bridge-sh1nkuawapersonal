// agy-wait-wake.mjs —— 领一个 AGY 回合，并把 prompt 原样打印到标准输出
//
// 契约见 docs/AGY_CONTRACT.md v1，任务说明见 docs/AGY_WORKER_TASK.md。
// 用法：
//   node scripts/agy-wait-wake.mjs --persona 小鲸鱼
//   node scripts/agy-wait-wake.mjs --persona 小鲸鱼 --timeout-ms 90000
//   node scripts/agy-wait-wake.mjs --persona 小鲸鱼 --loop
//
// 输出约定：
//   - 无活（204）或非值班（not-on-duty）：打印 IDLE（或 IDLE not-on-duty）并退出 0
//   - 领到回合：打印 AGY_TURN_META JSON 与原样未改写的 AGY_PROMPT_BEGIN .. AGY_PROMPT_END，退出 0
//   - 不可恢复错误（bad-token / transport-not-agy / 连续 5 次 500）：打印错误到 stderr，退出 1

import {
  argOf,
  formatClaimedTurnStdout,
  hasFlag,
  readConsoleToken,
  resolveBaseUrl,
  resolvePersona,
  resolveWorkerId,
  waitAndClaimOne
} from './agy-lib.mjs';

const persona = resolvePersona(argOf('persona'));
const workerId = resolveWorkerId(persona, argOf('worker-id'));
const baseUrl = resolveBaseUrl(argOf('base-url'));
const timeoutMs = Number(argOf('timeout-ms', '90000')) || 90000;
const afterTurnId = argOf('after-turn-id');
const loop = hasFlag('loop');
const notOnDutySleepMs = argOf('not-on-duty-sleep-ms') != null
  ? Number(argOf('not-on-duty-sleep-ms'))
  : 7000;
const errorBackoffMs = argOf('error-backoff-ms') != null
  ? Number(argOf('error-backoff-ms'))
  : 5000;

let token;
try {
  token = readConsoleToken(argOf('token-file'));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: 'token-unavailable', message: err.message }));
  process.exit(1);
}

const result = await waitAndClaimOne({
  baseUrl,
  token,
  persona,
  workerId,
  timeoutMs,
  afterTurnId,
  loop,
  notOnDutySleepMs,
  errorBackoffMs
});

if (result.status === 'idle') {
  if (result.reason && result.reason !== 'timeout') {
    console.log(`IDLE ${result.reason}`);
  } else {
    console.log('IDLE');
  }
  process.exitCode = 0;
} else if (result.status === 'claimed') {
  process.stdout.write(`${formatClaimedTurnStdout({
    turn: result.turn,
    leaseUntil: result.leaseUntil,
    workerId
  })}\n`);
  process.exitCode = 0;
} else {
  console.error(JSON.stringify({
    ok: false,
    where: 'wait-wake',
    http: result.http ?? 0,
    error: result.error ?? 'unknown-error',
    ...(result.consecutiveErrors ? { consecutiveErrors: result.consecutiveErrors } : {})
  }));
  process.exitCode = 1;
}
