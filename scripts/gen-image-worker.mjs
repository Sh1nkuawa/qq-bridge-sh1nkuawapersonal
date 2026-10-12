#!/usr/bin/env node
// gen-image-worker.mjs — 异步生图 worker（由 mcp-snowluma-safe.js 的 qq_generate_image 以
// detached 方式 spawn，父进程立刻返回，不阻塞 agent 回合）。
//
// 为什么要异步：
//   1) codex 生图要 1~4 分钟（网络不好时更久），同步调用会让 agent 哑在那里，
//      而且 MCP stdio 是串行的，会把同一个服务里的其他工具全部堵住；
//   2) 群聊体验上，"秒回一句『开始画了』+ 画好自动发图"比"等 4 分钟"好得多。
//
// 职责：
//   1. 跑 codex-image.ps1 生图；
//   2. 成功 → 先发一条 @提要求的人 的消息，再把图片发到群里；
//   3. 失败 → 退还这次配额（避免"没画出来还扣次数"），并发一条 @对方 的失败说明；
//   4. 全程写 state/image-jobs.log，方便排查。
//
// 用法（由 MCP 工具构造，参数一律用 base64 传文本，避免命令行引号问题）：
//   node scripts/gen-image-worker.mjs --key group:123456789 --sender 100000001 \
//        --prompt-b64 <base64> --token <agentToken> [--sender-name <base64>] [--timeout 600]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  DEFAULT_ARK_MODEL,
  DEFAULT_ARK_SIZE,
  detectImageMime,
  extensionForMime,
  fileToDataUri,
  generateWithArk,
  normalizeArkEndpoint,
  pickImageBackend
} from '../src/ark-image.mjs';
import { buildImageFailureText, looksLikeModeration } from '../src/image-failure-text.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'state', 'image-jobs.log');

// 生图技能脚本的位置。**仓库内副本优先**（dsh/skills/codex-image/，随仓库做版本控制），
// 找不到才回退到 ~/.agents/skills/ 下的安装副本 —— 这样：
//   · 新克隆的仓库不用先跑安装步骤就能生图；
//   · 技能脚本改了会跟着仓库一起被 review / 回滚，而不是散在用户目录里没人管；
//   · 老机器上只有 ~/.agents 副本时也不会坏。
// 两份同步用 scripts/install-skills.mjs（默认建 junction，避免漂移）。
function imageScriptCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return [
    path.join(ROOT, 'dsh', 'skills', 'codex-image', 'scripts', 'codex-image.ps1'),
    home ? path.join(home, '.agents', 'skills', 'codex-image', 'scripts', 'codex-image.ps1') : '',
  ].filter(Boolean);
}

function imageScriptPath() {
  for (const p of imageScriptCandidates()) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 试下一个 */ }
  }
  // 都不存在：返回仓库内那个路径，报错信息里能直接指出"该放哪"。
  return imageScriptCandidates()[0];
}

// 排障用：打印本 worker 实际会用的路径（不发图、不需要任何参数）。
if (process.argv.includes('--print-paths')) {
  for (const p of imageScriptCandidates()) {
    console.log(`${fs.existsSync(p) ? '✅ 存在' : '❌ 缺失'}  ${p}`);
  }
  console.log(`→ 实际使用: ${imageScriptPath()}`);
  process.exit(0);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* 日志失败不影响主流程 */ }
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? String(process.argv[i + 1]) : fallback;
}

function b64decode(v) {
  if (!v) return '';
  try { return Buffer.from(String(v), 'base64').toString('utf8'); } catch { return ''; }
}

const key = arg('key');
const sender = arg('sender');
const senderName = b64decode(arg('sender-name-b64'));
const prompt = b64decode(arg('prompt-b64'));
const agentToken = arg('token');
const timeoutSec = Math.min(Math.max(Number(arg('timeout', '600')) || 600, 60), 900);
// 带图生图：桥接挑好的输入图（本地临时文件路径），base64(JSON 数组) 传入以避免命令行引号问题
const images = (() => {
  const raw = b64decode(arg('images-b64'));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return (Array.isArray(arr) ? arr : []).map((p) => String(p ?? '')).filter((p) => p && fs.existsSync(p)).slice(0, 3);
  } catch { return []; }
})();

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function consoleToken() {
  const c = loadConfig();
  if (c.consoleToken) return String(c.consoleToken);
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function bridgeApi(apiPath, body, extraHeaders = {}, timeoutMs = 20000) {
  const port = Number(loadConfig().consolePort) || 3100;
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  const ct = consoleToken();
  if (ct) headers['x-console-token'] = ct;
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok) throw new Error(parsed?.error || `桥接 HTTP ${res.status}`);
  return parsed;
}

async function onebot(action, params, timeoutMs = 60000) {
  const c = loadConfig();
  const httpUrl = String(c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = c.snowluma?.httpToken || c.snowluma?.accessToken || '';
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== 'ok' || body?.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: HTTP ${res.status} retcode=${body?.retcode} ${body?.wording ?? ''}`);
  }
  return body.data;
}

/** 发送「@某人 + 一句话」或纯图片；群聊用结构化消息段，避免 CQ 码注入 */
async function sendSegments(segments) {
  const m = /^(group|private):(\d+)$/.exec(key);
  if (!m) throw new Error(`会话 key 格式无效：${key}`);
  const isPrivate = m[1] === 'private';
  return await onebot(isPrivate ? 'send_private_msg' : 'send_group_msg', {
    ...(isPrivate ? { user_id: Number(m[2]) } : { group_id: Number(m[2]) }),
    message: segments
  });
}

/**
 * 发「@某人 + 一句话」。
 * 走桥接的 /api/socialV2/send-message（和 agent 自己发言同一条路径）而不是直连 OneBot，
 * 原因：桥接会顺手把这条消息记进会话的 recentMessages —— 否则 agent 的上下文里只有
 * "已开始生成"，它根本不知道图已经送达，实测会让群友"重新 @ 一次"。
 * 顺带还继承了白名单校验、发送频率限制与分条延迟。
 * 桥接不可用时退回直连 OneBot（至少保证图能通知出去）。
 */
async function sendAtText(text) {
  const clean = String(text).replace(/\[CQ:/gi, '[CQ：');
  try {
    // 注意：这个端点要求 token 放在 x-agent-token **请求头**里（放 body 会被 403
    // "reserved2 模式发送必须携带 agent token"），而它正是"顺手记录进上下文"的那条路径。
    await bridgeApi('/api/socialV2/send-message', {
      key,
      messages: clean,
      atUserId: key.startsWith('group:') && sender ? String(sender) : null
    }, { 'x-agent-token': agentToken }, 120000);
    log(`💬 通知已通过桥接发送（并记入上下文）：${clean}`);
    return;
  } catch (error) {
    log(`⚠️ 桥接发送失败，退回直连 OneBot（这次通知不会进 agent 上下文）：${error?.message ?? error}`);
  }
  const segments = [];
  if (key.startsWith('group:') && sender) segments.push({ type: 'at', data: { qq: String(sender) } });
  segments.push({ type: 'text', data: { text: (segments.length ? ' ' : '') + clean } });
  await sendSegments(segments);
}

/** 告诉桥接"这单生图结束了"，让它清掉"后台正在生图"标记；成功时顺便上报"我发出去的那张图" */
async function markJobFinished(ok, reason, sentImage = null) {
  try {
    await bridgeApi('/api/socialV2/image-job', { key, ok, reason, ...(sentImage ? { sentImage } : {}) }, { 'x-agent-token': agentToken }, 15000);
  } catch (error) {
    log(`⚠️ 通知桥接生图结束失败：${error?.message ?? error}`);
  }
}

async function sendImage(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length > 8 * 1024 * 1024) throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB）`);
  const data = await sendSegments([{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }]);
  // 返回 OneBot 的 message_id：桥接要靠它把"这张图"和"这条消息"关联起来，
  // 之后群友引用这张图来改图时才能拿到本地原图。
  return data?.message_id != null ? String(data.message_id) : null;
}

// 位置解析见文件顶部（imageScriptCandidates / imageScriptPath）。

function imageOutDir() {
  const configured = loadConfig()?.socialV2?.image?.outDir;
  if (configured && String(configured).trim()) return String(configured).trim();
  return path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'qq-bridge-images');
}

/**
 * Agent Plan（火山方舟视觉模型）配置。
 *
 * [2026-10-05] 默认生图后端。key 与 Base URL 优先取 config.socialV2.image.ark*，
 * 否则读 state/ark-key.txt 与 state/ark-base.txt（两者都在 .gitignore 覆盖的 state/ 下，
 * 不会进仓库）。两者缺一就视为"没配"，直接走 codex。
 */
function arkConfig() {
  const img = loadConfig()?.socialV2?.image ?? {};
  const readFile = (rel) => {
    try { return fs.readFileSync(path.join(ROOT, String(rel)), 'utf8').trim(); } catch { return ''; }
  };
  const apiKey = String(img.arkApiKey ?? '').trim() || readFile(img.arkKeyFile ?? 'state/ark-key.txt');
  const base = String(img.arkBaseUrl ?? '').trim() || readFile(img.arkBaseFile ?? 'state/ark-base.txt');
  return {
    apiKey,
    base,
    endpoint: normalizeArkEndpoint(base),
    model: String(img.arkModel ?? '').trim() || DEFAULT_ARK_MODEL,
    size: String(img.arkSize ?? '').trim() || DEFAULT_ARK_SIZE,
    timeoutMs: Number(img.arkTimeoutMs) > 0 ? Number(img.arkTimeoutMs) : 300000,
    hasArk: Boolean(apiKey && base)
  };
}

/** 把参考图（本地路径）转成 data URI 数组；Ark 的 image 参数接受 URL 或 base64 data URI。 */
function arkImages(images = []) {
  return images.map((f) => {
    try { return fileToDataUri(f); } catch (error) { log(`⚠️ 参考图读取失败 ${f}：${error?.message ?? error}`); return ''; }
  }).filter(Boolean);
}

/**
 * 调 Agent Plan 出图。成功时把图写到 outPath（**扩展名按真实字节修正**：Ark 常返回 JPEG，
 * 硬写 .png 会让下游按扩展名读图的地方踩坑）。返回 { ok, path, log }。
 */
async function runArkImage(promptText, outPath, images = []) {
  const cfg = arkConfig();
  if (!cfg.hasArk) return { ok: false, path: null, log: '未配置 Agent Plan（缺 key 或 Base URL）' };
  const res = await generateWithArk({
    endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, prompt: promptText,
    images: arkImages(images), size: cfg.size, timeoutMs: cfg.timeoutMs
  });
  if (!res.ok) {
    const line = `Agent Plan 生图失败 HTTP ${res.status}：${res.message}`;
    log(`⚠️ ${line}`);
    return { ok: false, path: null, log: line };
  }
  const ext = extensionForMime(res.mimeType);
  const finalPath = outPath.replace(/\.[A-Za-z0-9]+$/, ext);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, res.buffer);
  log(`✅ Agent Plan 出图 ${finalPath}（${(res.ms / 1000).toFixed(1)}s，${res.mimeType}，${Math.round(res.buffer.length / 1024)}KB，usage=${JSON.stringify(res.usage ?? null)}）`);
  return { ok: true, path: finalPath, log: `agent-plan ${res.mimeType} ${(res.ms / 1000).toFixed(1)}s` };
}

/** 跑 codex-image.ps1；输出重定向到文件，返回 { code, log } */
function runCodexImage(promptText, outPath, images = []) {
  return new Promise((resolve) => {
    const script = imageScriptPath();
    if (!fs.existsSync(script)) {
      // 位置说清楚：仓库内副本优先，其次 ~/.agents（装法见 scripts/install-skills.mjs）。
      resolve({ code: -1, log: `找不到生图脚本。找过这些位置：\n  - ${imageScriptCandidates().join('\n  - ')}\n`
        + '仓库内副本应在 dsh/skills/codex-image/scripts/codex-image.ps1；'
        + '要装到 ~/.agents/skills 下可运行 node scripts/install-skills.mjs' });
      return;
    }
    const logPath = path.join(path.dirname(outPath), `codex-${path.basename(outPath, '.png')}.log`);
    const fd = fs.openSync(logPath, 'a');
    const argv = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Prompt', promptText,
      '-Out', outPath,
      '-TimeoutSec', String(timeoutSec)
    ];
    // 带图生图：逐张作为 -Images 传给技能脚本（脚本内部会变成 codex exec -i <file>）。
    // 注意：powershell.exe -File 不允许重复写同一个参数名（会报 ParameterAlreadyBound），
    // 多值必须写成 "-Images a,b" 这种逗号数组形式。输入图路径由桥接生成在
    // %TEMP%\qq-bridge-inputs\ 下，不含逗号，所以逗号分隔是安全的。
    if (images.length) argv.push('-Images', images.join(','));
    const child = spawn('powershell.exe', argv, { windowsHide: true, stdio: ['ignore', fd, fd] });
    const killer = setTimeout(() => {
      try { child.kill(); } catch {}
      log(`⚠️ 硬超时 ${timeoutSec + 60}s，已终止生图进程`);
      try { fs.closeSync(fd); } catch {}
      resolve({ code: -1 });
    }, (timeoutSec + 60) * 1000);
    child.on('error', (error) => {
      clearTimeout(killer);
      log(`⚠️ 生图进程启动失败：${error?.message ?? error}`);
      try { fs.closeSync(fd); } catch {}
      resolve({ code: -2 });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.closeSync(fd); } catch {}
      resolve({ code });
    });
  });
}

async function main() {
  if (!key || !prompt) {
    log(`❌ 参数缺失 key=${key} promptLen=${prompt.length}`);
    return;
  }
  const who = senderName || sender || '群友';
  log(`▶ 开始生图 key=${key} 请求者=${who}(${sender}) 超时=${timeoutSec}s 输入图=${images.length}张 提示词=${prompt.slice(0, 120)}`);

  let refunded = false;
  const refund = async (reason) => {
    if (refunded) return;
    refunded = true;
    try {
      await bridgeApi('/api/socialV2/image-request', { action: 'refund', key, token: agentToken, senderId: sender });
      log(`↩️ 已退还配额（${reason}）`);
    } catch (error) {
      log(`⚠️ 退还配额失败：${error?.message ?? error}`);
    }
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let out = path.join(imageOutDir(), `img-${stamp}-${crypto.randomBytes(3).toString('hex')}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const started = Date.now();
  // [2026-10-05] 生图后端：默认 Agent Plan（国内直连、不受 VPN 影响），失败回落 codex。
  // backend=codex 可强制只用 codex；没配 Agent Plan（缺 key/Base URL）时自动走 codex。
  const imageCfg = loadConfig()?.socialV2?.image ?? {};
  const backend = pickImageBackend(imageCfg, { hasArk: arkConfig().hasArk });
  let code = -1;
  let outFile = out;
  let backendLog = '';
  if (backend === 'ark') {
    log('▶ 生图后端：Agent Plan（失败会回落 codex）');
    const ark = await runArkImage(prompt, out, images);
    backendLog = ark.log;
    if (ark.ok) { code = 0; outFile = ark.path; }
    else log(`⚠️ 回落 codex（原因：${ark.log}）`);
  } else {
    log('▶ 生图后端：codex（未配 Agent Plan 或 backend=codex）');
  }
  if (code !== 0) {
    const r = await runCodexImage(prompt, out, images);
    code = r.code;
    outFile = out;
    if (code === 0) backendLog = 'codex';
  }
  const secs = Math.round((Date.now() - started) / 1000);
  out = outFile;

  if (code === 0 && fs.existsSync(out)) {
    try {
      await sendAtText(images.length ? '按你发的图改好了，收图' : '画好了，收图');
      const sentId = await sendImage(out);
      log(`✅ 生图完成并已发送 ${out}（${secs}s，${Math.round(fs.statSync(out).size / 1024)}KB）`);
      // 把我发出去的那张图回报给桥接：记下本地路径 + 消息 id，
      // 这样群友之后【引用这张图】来改图时，桥接能直接拿本地原图当参考图（2026-09-28 事故修复）。
      await markJobFinished(true, '', { path: out, messageId: sentId });
    } catch (error) {
      log(`⚠️ 图已生成但发送失败：${error?.message ?? error}（${out}）`);
      try { await sendAtText(`图画好了但我发不出来（${error?.message ?? error}）`); } catch {}
      await markJobFinished(false, `图已生成但发送失败：${error?.message ?? error}`);
    }
    return;
  }

  // 失败：退配额 + 如实说明
  const tail = (() => {
    try {
      const logPath = path.join(path.dirname(out), `codex-${path.basename(out, '.png')}.log`);
      const text = fs.readFileSync(logPath, 'utf8').trim();
      return text.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 200);
    } catch { return ''; }
  })();
  log(`❌ 生图失败 code=${code}（${secs}s，后端=${backend}）${backendLog ? ' 后端日志: ' + String(backendLog).slice(0, 160) : ''}${tail ? ' 输出: ' + tail : ''}`);
  await refund(`code=${code}`);
  // 失败原因如实分类（[2026-10-12] 改）：以前只看 codex 那半段日志，于是火山方舟因内容
  // 审核拒绝时，群里收到的却是「codex 那边出错了」✗。现在 Ark 与 codex 的原因都报出来
  // （分类逻辑在 src/image-failure-text.mjs，有离线回归）。
  // 注意：这里只改"怎么说"，**不改**"Ark 失败后要不要回落 codex"的策略。
  let why = buildImageFailureText({
    backend,
    arkText: backend === 'ark' ? backendLog : '',
    codexText: tail,
    hasImages: images.length > 0
  });
  // 只在"根本没走 Ark"时保留老的 124（PowerShell 超时）兜底，避免覆盖掉 Ark 那半段原因
  if (backend !== 'ark' && code === 124 && !/超时/.test(why)) why = 'codex 超时了（没在时限内画完）';
  // 内容审核类的失败，重发同样的请求还是会被拒——如实提醒换个说法
  const retryHint = looksLikeModeration(why) ? '这种情况换个描述、或别用真人参考图（重发原样还会被拒）' : '';
  // 带上请求者与请求内容，避免和上一次失败混淆（模型看到"图没画出来"会以为是别的那单）
  const whoTag = sender ? `@${sender}` : '';
  const brief = String(prompt ?? '').replace(/\s+/g, ' ').slice(0, 40);
  try {
    await sendAtText(`图没画出来：${why}。${retryHint ? retryHint + '。' : ''}这次不扣次数${brief ? `（你那句「${brief}…」我记着，重新 @我 发一次就行）` : '，重新 @我 发一次就行'}。`);
  } catch (error) { log(`⚠️ 失败通知也发不出去：${error?.message ?? error}`); }
  await markJobFinished(false, why);
  void whoTag;
}

await main();
process.exit(0);
