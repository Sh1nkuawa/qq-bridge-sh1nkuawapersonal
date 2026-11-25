// agy-wait-wake.mjs —— 领一个 AGY 回合，并把 prompt 原样打印到标准输出
//
// 契约见 docs/AGY_CONTRACT.md v1，任务说明见 docs/AGY_WORKER_TASK.md。
// 韧性保障（#7）：
//   - wait 请求带硬超时（timeoutMs + 5 秒），claim 带 10 秒硬超时，并关闭 keep-alive 防止桥接重启后挂死
//   - 遇 ECONNRESET / 超时 / 5xx 退避 2 秒重试；每 N 次失败记一条 error 日志
//   - 外层进程级循环兜底：--loop 模式下任何未捕获异常都会记日志并重启内层循环，绝不僵死
//
// 用法：
//   node scripts/agy-wait-wake.mjs --persona 小鲸鱼
//   node scripts/agy-wait-wake.mjs --persona 小鲸鱼 --timeout-ms 90000
//   node scripts/agy-wait-wake.mjs --persona 小鲸鱼 --loop

import {
  DEFAULT_ERROR_BACKOFF_MS,
  DEFAULT_LOG_ERROR_EVERY,
  DEFAULT_WAIT_GRACE_MS,
  appendWorkerLog,
  argOf,
  formatClaimedTurnStdout,
  hasFlag,
  readConsoleToken,
  resolveBaseUrl,
  resolvePersona,
  resolveWorkerId,
  sleep,
  waitAndClaimOne
} from './agy-lib.mjs';

const persona = resolvePersona(argOf('persona'));
const workerId = resolveWorkerId(persona, argOf('worker-id'));
const baseUrl = resolveBaseUrl(argOf('base-url'));
const timeoutMs = Number(argOf('timeout-ms', '90000')) || 90000;
const fetchGraceMs = argOf('fetch-grace-ms') != null
  ? Number(argOf('fetch-grace-ms'))
  : DEFAULT_WAIT_GRACE_MS;
const afterTurnId = argOf('after-turn-id');
const loop = hasFlag('loop');
const exitOnNotOnDuty = hasFlag('exit-on-not-on-duty');
const notOnDutySleepMs = argOf('not-on-duty-sleep-ms') != null
  ? Number(argOf('not-on-duty-sleep-ms'))
  : 7000;
const errorBackoffMs = argOf('error-backoff-ms') != null
  ? Number(argOf('error-backoff-ms'))
  : DEFAULT_ERROR_BACKOFF_MS;
const maxConsecutiveErrors = argOf('max-errors') != null
  ? Number(argOf('max-errors'))
  : (loop ? 0 : 5);
const logErrorEvery = argOf('log-error-every') != null
  ? Number(argOf('log-error-every'))
  : DEFAULT_LOG_ERROR_EVERY;

let token;
try {
  token = readConsoleToken(argOf('token-file'));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: 'token-unavailable', message: err.message }));
  process.exit(1);
}

// 进程级外层保护：任何未预期异常不让进程静默卡死
async function runSupervisor() {
  while (true) {
    try {
      const result = await waitAndClaimOne({
        baseUrl,
        token,
        persona,
        workerId,
        timeoutMs,
        fetchGraceMs,
        afterTurnId,
        loop,
        exitOnNotOnDuty,
        notOnDutySleepMs,
        errorBackoffMs,
        maxConsecutiveErrors,
        logErrorEvery
      });

      if (result.status === 'idle') {
        if (result.reason && result.reason !== 'timeout') {
          console.log(`IDLE ${result.reason}`);
        } else {
          console.log('IDLE');
        }
        process.exitCode = 0;
        return;
      }

      if (result.status === 'claimed') {
        process.stdout.write(`${formatClaimedTurnStdout({
          turn: result.turn,
          leaseUntil: result.leaseUntil,
          workerId
        })}\n`);
        process.exitCode = 0;
        return;
      }

      // 不可恢复的配置/鉴权错误，或单次模式达到重试上限
      if (!loop || result.error === 'bad-token' || result.error === 'bad-request' || result.error === 'transport-not-agy') {
        console.error(JSON.stringify({
          ok: false,
          where: 'wait-wake',
          http: result.http ?? 0,
          error: result.error ?? 'unknown-error',
          ...(result.consecutiveErrors ? { consecutiveErrors: result.consecutiveErrors } : {})
        }));
        process.exitCode = 1;
        return;
      }

      // loop 模式下退避重启内层循环
      if (errorBackoffMs > 0) await sleep(errorBackoffMs);
    } catch (err) {
      appendWorkerLog({
        workerId,
        persona,
        event: 'error',
        extra: { where: 'supervisor', http: 0, error: err?.name ?? 'uncaught', message: err?.message ?? String(err) },
        secretToken: token
      });
      if (!loop) {
        console.error(JSON.stringify({ ok: false, where: 'supervisor', error: err?.message ?? String(err) }));
        process.exitCode = 1;
        return;
      }
      if (errorBackoffMs > 0) await sleep(errorBackoffMs);
    }
  }
}

await runSupervisor();
