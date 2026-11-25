// agy-lib.mjs —— AGY worker 共享工具（认证、HTTP、日志脱敏、CLI 参数解析）
//
// 契约见 docs/AGY_CONTRACT.md v1。
// 约束：
//   - 绝不修改 src/**、config.json、state/*.json（仅追加 state/agy-worker.log）
//   - 日志严禁写入 console token、完整 prompt、群友 QQ 号（仅可记录 key）

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
  const p = String(cliPersona ?? process.env.AGY_PERSONA ?? '小鲸鱼').trim();
  return p || '小鲸鱼';
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

export async function apiGet({ baseUrl, token, pathname, query = {}, timeoutMs = 135000 }) {
  const url = buildApiUrl(baseUrl, pathname, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'x-console-token': token,
        accept: 'application/json'
      },
      signal: controller.signal
    });
    return await parseResponse(resp);
  } catch (err) {
    return {
      http: 0,
      body: { ok: false, error: 'network-error', message: err?.message ?? String(err) }
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function apiPost({ baseUrl, token, pathname, payload = {}, timeoutMs = 60000 }) {
  const url = buildApiUrl(baseUrl, pathname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'x-console-token': token,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return await parseResponse(resp);
  } catch (err) {
    return {
      http: 0,
      body: { ok: false, error: 'network-error', message: err?.message ?? String(err) }
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
 * 执行一次 wait -> claim 流程（契约 §3.1, §3.2, §6）：
 *   - 204：正常空闲，立即返回 { status: 'idle', reason: 'timeout' }（loop=true 时立即再 wait）
 *   - 200 idle/not-on-duty：休眠 notOnDutySleepMs（默认 7000ms），返回 idle（loop=true 时继续 wait）
 *   - claim 409 already-claimed / 404 turn-not-found / 409 requeued-too-many：自动重新 wait
 *   - 500 / 网络错误：退避 5 秒重试，连续 5 次失败后报错返回
 *   - 400 / 403 bad-token / 409 transport-not-agy：立刻报错返回（不盲目重试）
 */
export async function waitAndClaimOne({
  baseUrl,
  token,
  persona,
  workerId,
  timeoutMs = 90000,
  afterTurnId = null,
  loop = false,
  notOnDutySleepMs = 7000,
  errorBackoffMs = 5000,
  maxConsecutiveErrors = 5,
  maxClaimRetries = 10,
  logPath = process.env.AGY_LOG_PATH || DEFAULT_LOG_PATH
}) {
  const cappedTimeout = Math.min(Math.max(Number(timeoutMs) || 90000, 1000), 120000);
  let consecutiveErrors = 0;
  let claimRetries = 0;

  while (true) {
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
      timeoutMs: cappedTimeout + 15000
    });
    const elapsedMs = Date.now() - t0;

    if (w.http === 204) {
      consecutiveErrors = 0;
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
      consecutiveErrors = 0;
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
          payload: { turnId: turn.turnId, persona, workerId }
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

        // 可恢复冲突：重新 wait（契约 §3.2 / §6）
        if (
          c.http === 409 ||
          c.http === 404 ||
          (c.http === 403 && errCode === 'not-on-duty')
        ) {
          if (errCode === 'transport-not-agy') {
            return { status: 'error', http: c.http, error: errCode };
          }
          if (c.http === 403 && errCode === 'not-on-duty' && notOnDutySleepMs > 0) {
            await sleep(notOnDutySleepMs);
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
    appendWorkerLog({
      workerId,
      persona,
      event: 'error',
      extra: { where: 'wait', http: w.http, ms: elapsedMs, error: errCode },
      logPath,
      secretToken: token
    });

    // 不可重试的配置/参数/认证错误
    if (
      w.http === 400 ||
      w.http === 401 ||
      (w.http === 403 && errCode !== 'not-on-duty') ||
      (w.http === 409 && errCode === 'transport-not-agy')
    ) {
      return { status: 'error', http: w.http, error: errCode };
    }

    if (w.http === 403 && errCode === 'not-on-duty') {
      if (notOnDutySleepMs > 0) await sleep(notOnDutySleepMs);
      if (!loop) return { status: 'idle', reason: 'not-on-duty', http: 403 };
      continue;
    }

    // 500 或网络错误：退避 5 秒重试，连续 5 次记录清楚并退出
    consecutiveErrors += 1;
    if (consecutiveErrors >= maxConsecutiveErrors) {
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
