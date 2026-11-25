// agy-api.mjs —— AGY worker 通用桥接 API CLI（补齐 docs/AGY_FEATURE_GAPS.md 全部 🟡 能力与原生看图）
//
// 鉴权规则（严格遵守 AGY_FEATURE_GAPS.md §0）：
//   1. /api/agy/*：只带 x-console-token，绝不带 x-agent-token（带上会 403）
//   2. /api/socialV2/*、/api/images/*、/api/bili/*：带 x-console-token，传入 --session 时同时带 x-agent-token + x-agent-call: 1
//   3. 绝不把 consoleToken、sessionToken、完整 prompt 或群友 QQ 号写进日志
//   4. 写操作（POST）绝不自动重试；所有请求带硬超时 + Connection: close
//
// 常用子命令：
//   行为闭环：wake-config | wait-reply | wait-sleep
//   读消息/认人：unread | recent | prompt | message-detail | active-members | my-recent | social-state | status
//   OneBot只读：onebot | group-list | group-members | group-history
//   记忆管理：memory-remove | memory-clear（list/add 见 agy-tools.mjs）
//   表达工具：meme-list | meme-image | send-meme | send-poke | voices | send-voice | sticker-list | sticker-note | collect-sticker | image-request | slang-query | slang-submit | feedback
//   群管理：admin-status | mute-request | announcement
//   看图/转发/字幕：message-images | sticker-image | self-image | cleanup-frames | forward-message | bili-subtitle
//   额度/通用：agy-quota | get | call

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_RPC_TIMEOUT_MS,
  STATE_DIR,
  appendWorkerLog,
  argOf,
  buildApiUrl,
  hasFlag,
  readConsoleToken,
  readStdinUtf8,
  resolveBaseUrl,
  resolvePersona,
  resolveWorkerId
} from './agy-lib.mjs';

const cmd = String(process.argv[2] ?? 'help').trim();
const argv = process.argv.slice(3);

const persona = resolvePersona(argOf('persona', null, argv));
const workerId = resolveWorkerId(persona, argOf('worker-id', null, argv));
const baseUrl = resolveBaseUrl(argOf('base-url', null, argv));
const key = String(argOf('key', '', argv) ?? '').trim();
const sessionToken = String(argOf('session', process.env.AGY_SESSION_TOKEN ?? '', argv) ?? '').trim();

function printHelp() {
  console.log([
    '用法：node scripts/agy-api.mjs <subcommand> [options]',
    '',
    '公共参数：',
    '  --key <group:ID|private:ID>    会话 key',
    '  --session <会话令牌>            prompt 里的【会话令牌】（也可设 AGY_SESSION_TOKEN）',
    '  --persona <人格名>              默认 猫娘侍从',
    '  --body-stdin | --body-file <p> | --body <json>',
    '',
    '子命令：',
    '  [行为闭环]   wake-config (--dive | --mode diving --infinite true --sleep-ms N --through-seq N)',
    '               wait-reply  (--quiet-ms 10000 --timeout-ms 30000)',
    '               wait-sleep  (--timeout-ms 300000 --quiet-ms 10000 --min-new 1)',
    '  [消息/上下文] unread (--after-seq N --limit 30) | recent (--limit 20 --offset 0) | status',
    '               prompt | message-detail (--message-id) | active-members | my-recent | social-state',
    '  [OneBot只读] onebot (--action get_group_list|get_group_member_list|get_group_msg_history --group-id --message-seq)',
    '               group-list | group-members (--group-id) | group-history (--group-id --message-seq)',
    '  [记忆管理]   memory-remove (--category --content --target) | memory-clear (--category)',
    '  [表达工具]   meme-list (--tag --query --limit) | meme-image (--path) | send-meme (--path)',
    '               send-poke (--target-user-id) | voices | send-voice (--voice)',
    '               sticker-list | sticker-note | collect-sticker | image-request (--prompt)',
    '               slang-query (--q) | slang-submit (--content --context) | feedback (--level --message)',
    '  [群管理]     admin-status | mute-request (--user-id --reason) | announcement (--content)',
    '  [看图/视频]  message-images (--message-id) | sticker-image (--sticker-id) | self-image',
    '               cleanup-frames | forward-message (--id) | bili-subtitle (--bvid --from-sec --max-chars)',
    '  [AGY 额度]   agy-quota（直接查本机 Antigravity 各模型池 5 小时与每周剩余额度及重置时间）',
    '  [通用]       get --path <...> | call --method <GET|POST> --path <...>'
  ].join('\n'));
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp();
  process.exitCode = 0;
} else if (cmd === 'cleanup-frames') {
  let removed = 0;
  try {
    const entries = fs.readdirSync(STATE_DIR);
    for (const name of entries) {
      if (name.startsWith('agy-frame-')) {
        try {
          fs.unlinkSync(path.join(STATE_DIR, name));
          removed += 1;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  console.log(JSON.stringify({ ok: true, removed }));
  process.exitCode = 0;
} else if (cmd === 'agy-quota') {
  const lsAddr = String(argOf('ls-address', process.env.ANTIGRAVITY_LS_ADDRESS ?? '', argv) ?? '').trim();
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN ?? '').trim();
  if (!lsAddr || !csrf) {
    console.log(JSON.stringify({
      ok: false,
      error: 'missing-ls-env',
      message: '未检测到 ANTIGRAVITY_LS_ADDRESS 或 ANTIGRAVITY_CSRF_TOKEN（需在 Antigravity 会话内执行）'
    }, null, 2));
    process.exitCode = 1;
  } else {
    const formatDurationZh = (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return '即将重置';
      const totalMin = Math.floor(ms / 60000);
      const days = Math.floor(totalMin / 1440);
      const hours = Math.floor((totalMin % 1440) / 60);
      const mins = totalMin % 60;
      if (days > 0) return `${days}天${hours}小时`;
      if (hours > 0) return `${hours}小时${mins}分`;
      return `${Math.max(1, mins)}分钟`;
    };
    const formatBeijingTime = (iso) => {
      const t = Date.parse(String(iso ?? ''));
      if (!Number.isFinite(t)) return null;
      return new Date(t + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    };
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout after 8000ms')), 8000);
    try {
      const resp = await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeium-csrf-token': csrf,
          connection: 'close'
        },
        body: '{}',
        signal: controller.signal
      });
      const text = await resp.text();
      let raw = null;
      try { raw = text ? JSON.parse(text) : null; } catch { raw = text; }
      const rawGroups = Array.isArray(raw?.response?.groups)
        ? raw.response.groups
        : (Array.isArray(raw?.groups) ? raw.groups : []);
      const now = Date.now();
      const groups = rawGroups.map((g) => {
        const buckets = (Array.isArray(g.buckets) ? g.buckets : []).map((b) => {
          const frac = Number(b.remainingFraction);
          const remainingPct = Number.isFinite(frac) ? Math.round(frac * 1000) / 10 : null;
          const resetMs = Date.parse(String(b.resetTime ?? ''));
          return {
            id: b.bucketId ?? null,
            window: b.window ?? b.displayName ?? null,
            remainingPct,
            resetTime: b.resetTime ?? null,
            resetAtBeijing: formatBeijingTime(b.resetTime),
            resetIn: Number.isFinite(resetMs) ? formatDurationZh(resetMs - now) : null
          };
        });
        return {
          name: g.displayName ?? 'Unknown',
          models: g.description ?? '',
          buckets
        };
      });
      const summary = groups.map((g) => {
        const parts = g.buckets.map((b) => {
          const win = b.window === '5h' ? '5小时' : (b.window === 'weekly' ? '每周' : (b.window || '额度'));
          const pct = b.remainingPct != null ? `${b.remainingPct.toFixed(1)}%` : '未知';
          return b.resetIn ? `${win}剩余 ${pct}（${b.resetIn}后重置）` : `${win}剩余 ${pct}`;
        });
        return `${g.name}：${parts.join('，')}`;
      }).join(' | ');
      appendWorkerLog({
        workerId,
        persona,
        event: 'api',
        extra: { cmd: 'agy-quota', http: resp.status, ok: resp.ok, ms: Date.now() - t0, groupCount: groups.length },
        secretToken: csrf
      });
      console.log(JSON.stringify({ ok: resp.ok, source: 'antigravity-ls', groups, summary }, null, 2));
      process.exitCode = resp.ok ? 0 : 1;
    } catch (err) {
      appendWorkerLog({
        workerId,
        persona,
        event: 'error',
        extra: { where: 'api:agy-quota', http: 0, ms: Date.now() - t0, error: err?.cause?.code || err?.name || 'network-error' },
        secretToken: csrf
      });
      console.log(JSON.stringify({ ok: false, error: err?.cause?.code || err?.name || 'network-error', message: err?.message ?? String(err) }, null, 2));
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  }
} else {
  let consoleToken;
  try {
    consoleToken = readConsoleToken(argOf('token-file', null, argv));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: 'token-unavailable', message: err.message }));
    process.exit(1);
  }

  async function loadBodyJson() {
    if (hasFlag('body-stdin', argv)) {
      const raw = (await readStdinUtf8()).trim();
      if (!raw) return {};
      return JSON.parse(raw);
    }
    const bf = argOf('body-file', null, argv);
    if (bf) {
      return JSON.parse(fs.readFileSync(bf, 'utf8').replace(/^\uFEFF/, ''));
    }
    const bi = argOf('body', null, argv);
    if (bi != null) {
      return JSON.parse(bi);
    }
    return null;
  }

  function extFromMime(mime) {
    const m = String(mime ?? '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    return 'jpg';
  }

  function decodeBase64Payload(raw, fallbackMime = 'image/png') {
    if (!raw || typeof raw !== 'string') return null;
    const dataUrl = /^data:([^;]+);base64,(.+)$/s.exec(raw.trim());
    if (dataUrl) {
      return { mimeType: dataUrl[1], buffer: Buffer.from(dataUrl[2], 'base64') };
    }
    return { mimeType: fallbackMime, buffer: Buffer.from(raw.trim(), 'base64') };
  }

  function saveImageObject(imgObj, prefix, idx = 0) {
    if (!imgObj || typeof imgObj !== 'object') return null;
    const rawB64 = imgObj.data ?? imgObj.base64 ?? imgObj.content ?? null;
    const decoded = decodeBase64Payload(rawB64, imgObj.mimeType ?? imgObj.mime ?? 'image/png');
    if (!decoded || !decoded.buffer.length) return null;
    const ext = extFromMime(decoded.mimeType);
    const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
    const filename = `agy-frame-${safePrefix}-${idx}.${ext}`;
    const absPath = path.join(STATE_DIR, filename);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(absPath, decoded.buffer);
    return {
      path: absPath,
      mimeType: decoded.mimeType,
      bytes: decoded.buffer.length,
      kind: imgObj.kind ?? 'image',
      ...(imgObj.text ? { text: imgObj.text } : {})
    };
  }

  async function requestApi({ method, pathname, query = {}, payload = undefined, timeoutMs = 15000 }) {
    const url = buildApiUrl(baseUrl, pathname, query);
    const hardTimeout = Math.max(1000, Number(timeoutMs) || DEFAULT_RPC_TIMEOUT_MS);
    const headers = {
      'x-console-token': consoleToken,
      accept: 'application/json',
      connection: 'close'
    };
    if (method !== 'GET') headers['content-type'] = 'application/json';
    // 严格遵守 §0：/api/agy/* 绝不带 x-agent-token（带上会 403）
    if (!pathname.startsWith('/api/agy/') && sessionToken) {
      headers['x-agent-token'] = sessionToken;
      headers['x-agent-call'] = '1';
    }

    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${hardTimeout}ms`)), hardTimeout);
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
        signal: controller.signal
      });
      const elapsedMs = Date.now() - t0;
      const contentType = String(resp.headers.get('content-type') ?? '');
      let body = null;
      if (contentType.startsWith('image/')) {
        const buf = Buffer.from(await resp.arrayBuffer());
        body = { ok: resp.ok, image: { mimeType: contentType.split(';')[0], data: buf.toString('base64') } };
      } else {
        const text = await resp.text();
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      }
      appendWorkerLog({
        workerId,
        persona,
        event: 'api',
        extra: {
          cmd,
          method,
          path: pathname,
          ...(key ? { key } : {}),
          http: resp.status,
          ok: resp.ok,
          ms: elapsedMs
        },
        secretToken: consoleToken
      });
      return { http: resp.status, ok: resp.ok, body };
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      const errCode = err?.cause?.code || (err?.name === 'AbortError' ? 'fetch-timeout' : 'network-error');
      appendWorkerLog({
        workerId,
        persona,
        event: 'error',
        extra: {
          where: `api:${cmd}`,
          method,
          path: pathname,
          ...(key ? { key } : {}),
          http: 0,
          ms: elapsedMs,
          error: errCode
        },
        secretToken: consoleToken
      });
      return { http: 0, ok: false, body: { ok: false, error: errCode, message: err?.message ?? String(err) } };
    } finally {
      clearTimeout(timer);
    }
  }

  function requireKey() {
    if (!key) {
      console.error(JSON.stringify({ ok: false, error: 'bad-request', message: `子命令 ${cmd} 需要 --key` }));
      process.exit(2);
    }
  }

  let bodyOverride = null;
  try {
    bodyOverride = await loadBodyJson();
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: 'bad-request', message: `JSON 解析失败: ${err.message}` }));
    process.exit(2);
  }

  let res;
  let postProcessImagesPrefix = null;

  switch (cmd) {
    // ── §2.1 行为闭环 ────────────────────────────────────────────────────────
    case 'wake-config': {
      requireKey();
      let payload;
      if (bodyOverride) {
        payload = { key, ...bodyOverride };
      } else {
        const mode = hasFlag('dive', argv) ? 'diving' : String(argOf('mode', 'diving', argv));
        const infRaw = argOf('infinite', null, argv);
        const infinite = infRaw != null ? infRaw !== 'false' && infRaw !== '0' : (argOf('sleep-ms', null, argv) == null);
        const sleepMsRaw = argOf('sleep-ms', null, argv);
        const throughSeqRaw = argOf('through-seq', null, argv);
        const config = {
          mode,
          infinite,
          ...(sleepMsRaw != null ? { sleepMs: Number(sleepMsRaw) } : {})
        };
        payload = {
          key,
          config,
          ...(throughSeqRaw != null ? { throughSeq: Number(throughSeqRaw) } : {})
        };
      }
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/wake-config', payload, timeoutMs: 15000 });
      break;
    }

    case 'wait-reply': {
      requireKey();
      const quietMs = Number(argOf('quiet-ms', '10000', argv)) || 10000;
      const waitTimeoutMs = Number(argOf('timeout-ms', '30000', argv)) || 30000;
      const payload = bodyOverride
        ? { key, purpose: 'reply', ...bodyOverride }
        : { key, purpose: 'reply', quietMs, timeoutMs: waitTimeoutMs };
      const hardTimeout = Math.min(725000, (Number(payload.timeoutMs) || 30000) + Math.max(Number(payload.quietMs) || 0, 10000) + 25000);
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/wait', payload, timeoutMs: hardTimeout });
      break;
    }

    case 'wait-sleep': {
      requireKey();
      const waitTimeoutMs = Number(argOf('timeout-ms', '300000', argv)) || 300000;
      const quietMs = Number(argOf('quiet-ms', '10000', argv)) || 10000;
      const minNewMessages = Number(argOf('min-new', '1', argv)) || 1;
      const payload = bodyOverride
        ? { key, purpose: 'messages', ...bodyOverride }
        : { key, purpose: 'messages', timeoutMs: waitTimeoutMs, quietMs, minNewMessages };
      const hardTimeout = Math.min(725000, (Number(payload.timeoutMs) || 300000) + Math.max(Number(payload.quietMs) || 0, 10000) + 25000);
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/wait', payload, timeoutMs: hardTimeout });
      break;
    }

    // ── §2.2 读未读 / 历史 / 认人 / 完整角色卡 / 状态 ────────────────────────
    case 'unread': {
      requireKey();
      const afterSeq = argOf('after-seq', null, argv);
      const limit = argOf('limit', '30', argv);
      res = await requestApi({
        method: 'GET',
        pathname: '/api/socialV2/unread',
        query: {
          key,
          ...(afterSeq != null && afterSeq !== '' ? { afterSeq } : {}),
          ...(limit != null && limit !== '' ? { limit } : {})
        }
      });
      break;
    }

    case 'recent': {
      requireKey();
      res = await requestApi({
        method: 'GET',
        pathname: '/api/socialV2/recent',
        query: {
          key,
          limit: argOf('limit', '20', argv),
          offset: argOf('offset', '0', argv)
        }
      });
      break;
    }

    case 'status':
      res = await requestApi({ method: 'GET', pathname: '/api/status' });
      break;

    // ── §3.7 OneBot 只读白名单（/api/agy/onebot，绝不带 x-agent-token） ───────
    case 'onebot':
    case 'group-list':
    case 'group-members':
    case 'group-history': {
      const actionMap = {
        'group-list': 'get_group_list',
        'group-members': 'get_group_member_list',
        'group-history': 'get_group_msg_history'
      };
      const action = actionMap[cmd] ?? String(argOf('action', '', argv) ?? '').trim();
      if (!action) {
        console.error(JSON.stringify({ ok: false, error: 'bad-request', message: '缺少 --action (get_group_list|get_group_member_list|get_group_msg_history)' }));
        process.exit(2);
      }
      const keyGroupId = key.startsWith('group:') ? key.slice('group:'.length) : '';
      const groupId = String(argOf('group-id', keyGroupId, argv) ?? '').trim();
      const messageSeq = argOf('message-seq', null, argv);
      res = await requestApi({
        method: 'GET',
        pathname: '/api/agy/onebot',
        query: {
          action,
          ...(groupId ? { groupId } : {}),
          ...(messageSeq != null && messageSeq !== '' ? { messageSeq } : {})
        },
        timeoutMs: 30000
      });
      break;
    }

    // ── 记忆删清（list/add 在 agy-tools.mjs） ────────────────────────────────
    case 'memory-remove': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : {
          key,
          category: argOf('category', '', argv),
          ...(argOf('content', null, argv) != null ? { content: argOf('content', null, argv) } : {}),
          ...(argOf('target', null, argv) != null ? { target: argOf('target', null, argv) } : {})
        };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/memory-remove', payload });
      break;
    }

    case 'memory-clear': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : {
          key,
          ...(argOf('category', null, argv) != null ? { category: argOf('category', null, argv) } : {})
        };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/memory-clear', payload });
      break;
    }

    case 'prompt':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/prompt', query: { key }, timeoutMs: 20000 });
      break;

    case 'message-detail': {
      requireKey();
      const messageId = argOf('message-id', null, argv);
      if (!messageId) { console.error('缺少 --message-id'); process.exit(2); }
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/message-detail', query: { key, messageId } });
      break;
    }

    case 'active-members':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/active-members', query: { key } });
      break;

    case 'my-recent':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/my-recent', query: { key } });
      break;

    case 'social-state':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/state', query: { key } });
      break;

    // ── §2.3 表达 ────────────────────────────────────────────────────────────
    case 'meme-list':
      requireKey();
      res = await requestApi({
        method: 'GET',
        pathname: '/api/socialV2/meme-list',
        query: {
          key,
          tag: argOf('tag', null, argv),
          query: argOf('query', null, argv),
          limit: argOf('limit', null, argv)
        }
      });
      break;

    case 'meme-image': {
      requireKey();
      const memePath = argOf('path', null, argv);
      if (!memePath) { console.error('缺少 --path'); process.exit(2); }
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/meme-image', query: { key, path: memePath }, timeoutMs: 60000 });
      postProcessImagesPrefix = `meme-${Date.now()}`;
      break;
    }

    case 'send-meme': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : {
          key,
          path: argOf('path', '', argv),
          ...(argOf('reply-to', null, argv) != null ? { replyToMessageId: Number(argOf('reply-to', null, argv)) } : {}),
          ...(argOf('at-user-id', null, argv) != null ? { atUserId: argOf('at-user-id', null, argv) } : {})
        };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/send-meme', payload, timeoutMs: 120000 });
      break;
    }

    case 'send-poke': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : { key, targetUserId: argOf('target-user-id', '', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/send-poke', payload, timeoutMs: 30000 });
      break;
    }

    case 'voices':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/voices', query: { key } });
      break;

    case 'send-voice': {
      requireKey();
      const payload = bodyOverride ? { key, ...bodyOverride } : { key, voice: argOf('voice', '', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/send-voice', payload, timeoutMs: 120000 });
      break;
    }

    case 'sticker-list':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/sticker-list', query: { key } });
      break;

    case 'sticker-note': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : {
          key,
          stickerId: argOf('sticker-id', '', argv),
          ...(argOf('note', null, argv) != null ? { note: argOf('note', null, argv) } : {}),
          ...(argOf('usage', null, argv) != null ? { usage: argOf('usage', null, argv) } : {})
        };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/sticker-note', payload });
      break;
    }

    case 'collect-sticker': {
      requireKey();
      const payload = bodyOverride ? { key, ...bodyOverride } : { key, messageId: argOf('message-id', '', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/collect-sticker', payload, timeoutMs: 60000 });
      break;
    }

    case 'image-request': {
      requireKey();
      const payload = bodyOverride
        ? { key, token: sessionToken, ...bodyOverride }
        : { key, token: sessionToken, prompt: argOf('prompt', '', argv), consume: !hasFlag('dry-run', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/image-request', payload, timeoutMs: 30000 });
      break;
    }

    case 'slang-query':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/slang/query', query: { key, q: argOf('q', '', argv) } });
      break;

    case 'slang-submit': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : { key, content: argOf('content', '', argv), context: argOf('context', '', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/slang/submit', payload });
      break;
    }

    case 'feedback': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : { key, level: argOf('level', 'info', argv), message: argOf('message', '', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/feedback', payload });
      break;
    }

    // ── §2.4 群管理 ──────────────────────────────────────────────────────────
    case 'admin-status':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/admin-status', query: { key } });
      break;

    case 'mute-request': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : { key, userId: argOf('user-id', '', argv), reason: argOf('reason', '', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/mute-request', payload, timeoutMs: 60000 });
      break;
    }

    case 'announcement': {
      requireKey();
      const payload = bodyOverride
        ? { key, ...bodyOverride }
        : { key, content: argOf('content', '', argv) };
      res = await requestApi({ method: 'POST', pathname: '/api/socialV2/announcement/propose', payload, timeoutMs: 60000 });
      break;
    }

    // ── §2.5 图 / 转发 / B 站字幕（支持自动落盘供 read_file 原生看图） ───────
    case 'message-images': {
      requireKey();
      const messageId = argOf('message-id', null, argv);
      if (!messageId) { console.error('缺少 --message-id'); process.exit(2); }
      res = await requestApi({ method: 'GET', pathname: '/api/images/message', query: { key, messageId }, timeoutMs: 120000 });
      postProcessImagesPrefix = `msg-${messageId}`;
      break;
    }

    case 'sticker-image': {
      requireKey();
      const stickerId = argOf('sticker-id', null, argv);
      if (!stickerId) { console.error('缺少 --sticker-id'); process.exit(2); }
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/sticker-image', query: { key, stickerId }, timeoutMs: 60000 });
      postProcessImagesPrefix = `sticker-${stickerId}`;
      break;
    }

    case 'self-image':
      requireKey();
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/self-image', query: { key }, timeoutMs: 30000 });
      postProcessImagesPrefix = 'self';
      break;

    case 'forward-message': {
      requireKey();
      const id = argOf('id', null, argv);
      if (!id) { console.error('缺少 --id'); process.exit(2); }
      res = await requestApi({ method: 'GET', pathname: '/api/socialV2/forward-message', query: { key, id }, timeoutMs: 60000 });
      break;
    }

    case 'bili-subtitle': {
      const bvid = argOf('bvid', null, argv);
      if (!bvid) { console.error('缺少 --bvid'); process.exit(2); }
      res = await requestApi({
        method: 'GET',
        pathname: '/api/bili/subtitle',
        query: {
          bvid,
          ...(key ? { key } : {}),
          fromSec: argOf('from-sec', null, argv),
          maxChars: argOf('max-chars', null, argv)
        },
        timeoutMs: 60000
      });
      break;
    }

    // ── 通用直调 ──────────────────────────────────────────────────────────────
    case 'get':
    case 'call': {
      const pathname = String(argOf('path', '', argv) ?? '').trim();
      if (!pathname || !pathname.startsWith('/')) {
        console.error(JSON.stringify({ ok: false, error: 'bad-request', message: '缺少合法 --path（以 / 开头）' }));
        process.exit(2);
      }
      const method = cmd === 'get' ? 'GET' : String(argOf('method', 'POST', argv)).toUpperCase();
      const customTimeout = Number(argOf('timeout-ms', '30000', argv)) || 30000;
      res = await requestApi({
        method,
        pathname,
        query: method === 'GET' && key ? { key } : {},
        payload: method === 'GET' ? undefined : (bodyOverride ?? (key ? { key } : {})),
        timeoutMs: customTimeout
      });
      break;
    }

    default:
      console.error(JSON.stringify({ ok: false, error: 'unknown-subcommand', cmd }));
      printHelp();
      process.exit(2);
  }

  // 图片落盘后处理：把 base64 写进 state/agy-frame-*.ext，stdout 只输出路径与元信息（不撑爆上下文）
  if (postProcessImagesPrefix && res.ok && res.body && typeof res.body === 'object' && !hasFlag('raw-base64', argv)) {
    const savedFiles = [];
    const notes = [];
    if (res.body.image && typeof res.body.image === 'object') {
      const saved = saveImageObject(res.body.image, postProcessImagesPrefix, 0);
      if (saved) savedFiles.push(saved);
    }
    if (Array.isArray(res.body.images)) {
      res.body.images.forEach((img, idx) => {
        const saved = saveImageObject(img, postProcessImagesPrefix, idx);
        if (saved) savedFiles.push(saved);
        else if (img?.text) notes.push(img.text);
      });
    }
    const summary = {
      ok: true,
      ...(res.body.messageId != null ? { messageId: res.body.messageId } : {}),
      ...(res.body.note ? { note: res.body.note } : {}),
      savedFiles,
      ...(notes.length ? { notes } : {}),
      hint: savedFiles.length ? '请用 read_file 读取 savedFiles[].path 原生看图，看完后运行 node scripts/agy-api.mjs cleanup-frames 清理。' : '无落盘图片'
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? { ok: false, http: res.http }, null, 2));
  }

  process.exitCode = res.ok ? 0 : 1;
}
