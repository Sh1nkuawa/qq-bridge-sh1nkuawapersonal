// agy-lib.mjs —— AGY worker 共享工具（认证、HTTP 超时、断线重连、日志脱敏、CLI 参数解析）
//
// 契约见 docs/AGY_CONTRACT.md v1。
// 约束：
//   - 绝不修改 src/**、config.json、state/*.json（仅追加 state/agy-worker.log）
//   - 日志严禁写入 console token、完整 prompt、群友 QQ 号（仅可记录 key）
//   - 所有 fetch 必须带硬超时：wait = timeoutMs + 5000ms，其它接口 = 10000ms
//   - wait 遇 ECONNRESET / 超时 / 5xx ⇒ 退避 2 秒后重新 wait，不退出、不僵死

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, '..');
export const STATE_DIR = path.join(ROOT, 'state');
export const DEFAULT_LOG_PATH = path.join(STATE_DIR, 'agy-worker.log');
export const DEFAULT_TOKEN_PATH = path.join(STATE_DIR, 'console-token');
export const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config.json');
export const DEFAULT_RPC_TIMEOUT_MS = 10000;
export const DEFAULT_WAIT_GRACE_MS = 5000;
export const DEFAULT_ERROR_BACKOFF_MS = 2000;
export const DEFAULT_LOG_ERROR_EVERY = 5;

export function argOf(name, dflt = null, argv = process.argv.slice(2)) {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) {
      const next = argv[i + 1];
      return next != null && !next.startsWith('--') ? next : dflt;
    }
    if (a.startsWith(`${flag}=`)) {
      return a.slice(flag.length + 1);
    }
  }
  return dflt;
}

export function manyOf(name, argv = process.argv.slice(2)) {
  const flag = `--${name}`;
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag && argv[i + 1] != null) {
      out.push(argv[i + 1]);
      i += 1;
    } else if (a.startsWith(`${flag}=`)) {
      out.push(a.slice(flag.length + 1));
    }
  }
  return out;
}

export function hasFlag(name, argv = process.argv.slice(2)) {
  const flag = `--${name}`;
  return argv.includes(flag);
}

export function readConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveBaseUrl(cliBaseUrl = null) {
  const raw = cliBaseUrl || process.env.AGY_BRIDGE_URL;
  if (raw) return String(raw).replace(/\/+$/, '');
  const cfg = readConfigSafe();
  const port = Number(cfg?.consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

export function readConsoleToken(tokenPath = null) {
  const envTok = String(process.env.AGY_CONSOLE_TOKEN ?? '').trim();
  if (envTok) return envTok;
  const target = tokenPath || DEFAULT_TOKEN_PATH;
  try {
    const fileTok = fs.readFileSync(target, 'utf8').trim();
    if (fileTok) return fileTok;
  } catch {
    // fall through to config.json read-only check
  }
  const cfg = readConfigSafe();
  const cfgTok = String(cfg?.consoleToken ?? '').trim();
  if (cfgTok) return cfgTok;
  throw new Error(`无法读取控制台令牌（已检查 AGY_CONSOLE_TOKEN、${target} 与 config.json）`);
}

export function resolvePersona(cliPersona = null) {
  const p = String(cliPersona ?? process.env.AGY_PERSONA ?? '猫娘侍从').trim();
  return p || '猫娘侍从';
}

export function resolveWorkerId(persona, cliWorkerId = null) {
  const explicit = String(cliWorkerId ?? process.env.AGY_WORKER_ID ?? '').trim();
  if (explicit) return explicit;
  // 默认按人格生成稳定 workerId，保证 wait-wake 与 reply-and-wait 跨进程调用时一致，避免 complete 报 409 already-claimed
  return `agy-${persona}`;
}

const FORBIDDEN_LOG_KEYS = new Set([
  'token',
  'consoletoken',
  'x-console-token',
  'prompt',
  'qq',
  'qqid',
  'userid',
  'senderid',
  'senderqq',
  'targetqq'
]);

function sanitizeValue(val, secretToken = '') {
  if (val == null) return val;
  if (typeof val === 'string') {
    let s = val;
    if (secretToken) s = s.split(secretToken).join('[REDACTED]');
    if (s.length > 500) s = `${s.slice(0, 500)}…[truncated]`;
    return s;
  }
  if (Array.isArray(val)) {
    return val.slice(0, 20).map((item) => sanitizeValue(item, secretToken));
  }
  if (typeof val === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_LOG_KEYS.has(k.toLowerCase())) continue;
      clean[k] = sanitizeValue(v, secretToken);
    }
    return clean;
  }
  return val;
}

export function appendWorkerLog({
  workerId,
  persona,
  event,
  extra = {},
  logPath = process.env.AGY_LOG_PATH || DEFAULT_LOG_PATH,
  secretToken = ''
}) {
  const cleanExtra = sanitizeValue(extra, secretToken);
  const entry = {
    at: Date.now(),
    workerId: String(workerId ?? ''),
    persona: String(persona ?? ''),
    event: String(event ?? 'info'),
    ...(cleanExtra && typeof cleanExtra === 'object' ? cleanExtra : {})
  };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, { encoding: 'utf8' });
  } catch {
    // 日志写失败不阻塞主流程
  }
  return entry;
}

export function buildApiUrl(baseUrl, pathname, query = {}) {
  const u = new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') u.searchParams.set(k, String(v));
  }
  return u;
}

function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code || '';
  if (code) return String(code);
  if (err?.name === 'AbortError' || /timeout|aborted/i.test(String(err?.message ?? ''))) {
    return 'fetch-timeout';
  }
  return 'network-error';
}

async function parseResponse(resp) {
  if (resp.status === 204) return { http: 204, body: null };
  const text = await resp.text();
  if (!text) return { http: resp.status, body: null };
  try {
    return { http: resp.status, body: JSON.parse(text) };
  } catch {
    return { http: resp.status, body: text };
  }
}

export async function apiGet({ baseUrl, token, pathname, query = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS }) {
  const url = buildApiUrl(baseUrl, pathname, query);
  const hardTimeout = Math.max(1000, Number(timeoutMs) || DEFAULT_RPC_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${hardTimeout}ms`)), hardTimeout);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'x-console-token': token,
        accept: 'application/json',
        connection: 'close'
      },
      signal: controller.signal
    });
    return await parseResponse(resp);
  } catch (err) {
    return {
      http: 0,
      body: {
        ok: false,
        error: classifyNetworkError(err),
        message: err?.cause?.message ?? err?.message ?? String(err)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function apiPost({ baseUrl, token, pathname, payload = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS }) {
  const url = buildApiUrl(baseUrl, pathname);
  const hardTimeout = Math.max(1000, Number(timeoutMs) || DEFAULT_RPC_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${hardTimeout}ms`)), hardTimeout);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'x-console-token': token,
        'content-type': 'application/json',
        accept: 'application/json',
        connection: 'close'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return await parseResponse(resp);
  } catch (err) {
    return {
      http: 0,
      body: {
        ok: false,
        error: classifyNetworkError(err),
        message: err?.cause?.message ?? err?.message ?? String(err)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readStdinUtf8() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * 执行一次 wait -> claim 流程（契约 §3.1, §3.2, §6 + #7 韧性要求）：
 *   - wait fetch 硬超时 = timeoutMs + fetchGraceMs（默认 +5000ms）；claim 等 RPC 硬超时 = 10000ms
 *   - 204：正常空闲，立即返回 { status: 'idle', reason: 'timeout' }（loop=true 时立即再 wait）
 *   - 200 idle/not-on-duty：休眠 notOnDutySleepMs（默认 7000ms），返回 idle（loop=true 时继续 wait）
 *   - claim 409 already-claimed / 404 turn-not-found / 409 requeued-too-many：自动重新 wait
 *   - wait 抛异常（ECONNRESET / fetch-timeout / 5xx）：退避 2 秒后重新 wait，每 N 次失败打一条 error 日志；
 *     maxConsecutiveErrors <= 0（默认 --loop 模式）时永不退出，持续重连直到桥接恢复
 *   - 400 / 403 bad-token / 409 transport-not-agy：立刻报错返回（非 loop 模式）或按退避重试（loop 模式不僵死）
 */
export async function waitAndClaimOne({
  baseUrl,
  token,
  persona,
  workerId,
  timeoutMs = 90000,
  fetchGraceMs = DEFAULT_WAIT_GRACE_MS,
  afterTurnId = null,
  loop = false,
  notOnDutySleepMs = 7000,
  errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
  maxConsecutiveErrors = loop ? 0 : 5,
  logErrorEvery = DEFAULT_LOG_ERROR_EVERY,
  maxClaimRetries = 10,
  logPath = process.env.AGY_LOG_PATH || DEFAULT_LOG_PATH
}) {
  const cappedTimeout = Math.min(Math.max(Number(timeoutMs) || 90000, 1000), 120000);
  const graceMs = Math.max(200, Number(fetchGraceMs) || DEFAULT_WAIT_GRACE_MS);
  const errEvery = Math.max(1, Number(logErrorEvery) || DEFAULT_LOG_ERROR_EVERY);
  let consecutiveErrors = 0;
  let lastErrSig = '';
  let claimRetries = 0;

  const markRecoveredIfNeeded = () => {
    if (consecutiveErrors > 0) {
      appendWorkerLog({
        workerId,
        persona,
        event: 'recovered',
        extra: { where: 'wait', afterErrors: consecutiveErrors },
        logPath,
        secretToken: token
      });
      consecutiveErrors = 0;
      lastErrSig = '';
    }
  };

  while (true) {
    try {
      const t0 = Date.now();
      const w = await apiGet({
        baseUrl,
        token,
        pathname: '/api/agy/wait',
        query: {
          persona,
          workerId,
          timeoutMs: cappedTimeout,
          afterTurnId: afterTurnId || undefined
        },
        timeoutMs: cappedTimeout + graceMs
      });
      const elapsedMs = Date.now() - t0;

      if (w.http === 204) {
        markRecoveredIfNeeded();
        appendWorkerLog({
          workerId,
          persona,
          event: 'wait',
          extra: { http: 204, ms: elapsedMs, idle: true },
          logPath,
          secretToken: token
        });
        if (!loop) return { status: 'idle', reason: 'timeout', http: 204 };
        continue;
      }

      if (w.http === 200 && w.body && typeof w.body === 'object') {
        markRecoveredIfNeeded();
        if (w.body.idle) {
          const reason = String(w.body.reason ?? 'idle');
          appendWorkerLog({
            workerId,
            persona,
            event: 'wait',
            extra: { http: 200, ms: elapsedMs, idle: true, reason },
            logPath,
            secretToken: token
          });
          // persona-on-dsh：该人格已被分流给 DSH，绝不死等（AGY_SIDE_TASKS §2.5 / §4.8）
          if (reason === 'persona-on-dsh') {
            return { status: 'idle', reason, http: 200, transport: w.body.transport ?? 'dsh' };
          }
          // 避免非值班时高频刷屏（契约 §3.1 / §8.2：5~10 秒后再 wait）
          if (notOnDutySleepMs > 0) await sleep(notOnDutySleepMs);
          if (!loop) return { status: 'idle', reason, http: 200, onDuty: w.body.onDuty ?? null };
          continue;
        }

        if (w.body.turnId) {
          const turn = w.body;
          appendWorkerLog({
            workerId,
            persona,
            event: 'wait',
            extra: { http: 200, ms: elapsedMs, turnId: turn.turnId, key: turn.key, reason: turn.reason },
            logPath,
            secretToken: token
          });

          const c = await apiPost({
            baseUrl,
            token,
            pathname: '/api/agy/claim',
            payload: { turnId: turn.turnId, persona, workerId },
            timeoutMs: DEFAULT_RPC_TIMEOUT_MS
          });

          if (c.http === 200 && c.body?.ok) {
            const claimedTurn = c.body.turn ?? turn;
            appendWorkerLog({
              workerId,
              persona,
              event: 'claim',
              extra: {
                turnId: claimedTurn.turnId,
                key: claimedTurn.key,
                attempts: claimedTurn.attempts ?? 0,
                ok: true
              },
              logPath,
              secretToken: token
            });
            return {
              status: 'claimed',
              turn: claimedTurn,
              leaseUntil: c.body.leaseUntil ?? null
            };
          }

          const errCode = String(c.body?.error ?? `http-${c.http}`);
          appendWorkerLog({
            workerId,
            persona,
            event: 'error',
            extra: { where: 'claim', turnId: turn.turnId, http: c.http, error: errCode },
            logPath,
            secretToken: token
          });

          // 可恢复冲突或瞬态断连：重新 wait（契约 §3.2 / §6 / #7）
          if (
            c.http === 409 ||
            c.http === 404 ||
            c.http === 0 ||
            c.http >= 500 ||
            (c.http === 403 && errCode === 'not-on-duty')
          ) {
            if (errCode === 'transport-not-agy') {
              return { status: 'error', http: c.http, error: errCode };
            }
            if (c.http === 403 && errCode === 'not-on-duty' && notOnDutySleepMs > 0) {
              await sleep(notOnDutySleepMs);
            } else if ((c.http === 0 || c.http >= 500) && errorBackoffMs > 0) {
              await sleep(errorBackoffMs);
            }
            claimRetries += 1;
            if (!loop && claimRetries >= maxClaimRetries) {
              return { status: 'idle', reason: errCode, http: c.http };
            }
            continue;
          }

          return { status: 'error', http: c.http, error: errCode };
        }
      }

      // 处理非 200/204 错误
      const errCode = String(w.body?.error ?? `http-${w.http}`);
      if (w.http === 403 && errCode === 'not-on-duty') {
        markRecoveredIfNeeded();
        appendWorkerLog({
          workerId,
          persona,
          event: 'wait',
          extra: { http: 403, ms: elapsedMs, idle: true, reason: 'not-on-duty' },
          logPath,
          secretToken: token
        });
        if (notOnDutySleepMs > 0) await sleep(notOnDutySleepMs);
        if (!loop) return { status: 'idle', reason: 'not-on-duty', http: 403 };
        continue;
      }

      // 不可重试的参数/鉴权/模式错误
      if (
        w.http === 400 ||
        w.http === 401 ||
        (w.http === 403 && errCode !== 'not-on-duty') ||
        (w.http === 409 && errCode === 'transport-not-agy')
      ) {
        appendWorkerLog({
          workerId,
          persona,
          event: 'error',
          extra: { where: 'wait', http: w.http, ms: elapsedMs, error: errCode },
          logPath,
          secretToken: token
        });
        return { status: 'error', http: w.http, error: errCode };
      }

      // ECONNRESET / 超时 / 5xx：退避 2 秒重试；首错、错因变化或每 N 次失败记一条 error 日志
      consecutiveErrors += 1;
      const errSig = `${w.http}:${errCode}`;
      const shouldLogErr =
        consecutiveErrors === 1 ||
        errSig !== lastErrSig ||
        consecutiveErrors % errEvery === 0;
      lastErrSig = errSig;

      if (shouldLogErr) {
        appendWorkerLog({
          workerId,
          persona,
          event: 'error',
          extra: {
            where: 'wait',
            http: w.http,
            ms: elapsedMs,
            error: errCode,
            consecutiveErrors
          },
          logPath,
          secretToken: token
        });
      }

      if (maxConsecutiveErrors > 0 && consecutiveErrors >= maxConsecutiveErrors) {
        appendWorkerLog({
          workerId,
          persona,
          event: 'error',
          extra: {
            where: 'wait',
            http: w.http,
            error: errCode,
            consecutiveErrors,
            fatal: true
          },
          logPath,
          secretToken: token
        });
        return { status: 'error', http: w.http, error: errCode, consecutiveErrors };
      }

      if (errorBackoffMs > 0) await sleep(errorBackoffMs);
    } catch (unexpected) {
      // 内层兜底：任何未预期异常均记日志、退避 2 秒并重启内层循环，绝不让进程僵死
      consecutiveErrors += 1;
      appendWorkerLog({
        workerId,
        persona,
        event: 'error',
        extra: {
          where: 'wait-loop',
          http: 0,
          error: classifyNetworkError(unexpected),
          message: unexpected?.message ?? String(unexpected),
          consecutiveErrors
        },
        logPath,
        secretToken: token
      });
      if (maxConsecutiveErrors > 0 && consecutiveErrors >= maxConsecutiveErrors) {
        return { status: 'error', http: 0, error: 'unexpected-loop-error', consecutiveErrors };
      }
      if (errorBackoffMs > 0) await sleep(errorBackoffMs);
    }
  }
}

export function formatClaimedTurnStdout({ turn, leaseUntil, workerId }) {
  const meta = {
    turnId: turn.turnId,
    persona: turn.persona,
    workerId,
    key: turn.key,
    reason: turn.reason,
    createdAt: turn.createdAt,
    attempts: turn.attempts ?? 0,
    leaseUntil: leaseUntil ?? null,
    readThroughSeq: turn.readThroughSeq ?? null
  };
  // 原样输出 prompt，不做任何改写或截断（契约 §4 / §9.1）
  return [
    '=== AGY_TURN_META ===',
    JSON.stringify(meta),
    '=== AGY_PROMPT_BEGIN ===',
    String(turn.prompt ?? ''),
    '=== AGY_PROMPT_END ==='
  ].join('\n');
}
