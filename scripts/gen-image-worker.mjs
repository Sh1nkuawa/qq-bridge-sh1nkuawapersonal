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
  const out = path.join(imageOutDir(), `img-${stamp}-${crypto.randomBytes(3).toString('hex')}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const started = Date.now();
  const { code } = await runCodexImage(prompt, out, images);
  const secs = Math.round((Date.now() - started) / 1000);

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
  log(`❌ 生图失败 code=${code}（${secs}s）${tail ? ' 输出: ' + tail : ''}`);
  await refund(`code=${code}`);
  // 分类真实原因：以前一律写"codex 没能在超时前出图"，而实测有一次是
  // "referenced photo wasn't attached"（没拿到参考图），文案误导了群友和模型。
  const why = (() => {
    if (/网络不可达|network error|fetch failed|ECONNRESET|ETIMEDOUT/i.test(tail)) return '网络到 chatgpt.com 不通（代理节点问题）';
    if (/wasn't attached|was not attached|no image|missing image|attach/i.test(tail)) {
      return images.length ? 'codex 没收到我给的参考图' : '这次是要改图，但我没拿到参考图';
    }
    if (/safety|policy|violat/i.test(tail)) return 'codex 说这个请求它不能画';
    if (code === 124 || /timed? ?out/i.test(tail)) return 'codex 超时了（没在时限内画完）';
    return 'codex 那边出错了（不是你的问题）';
  })();
  // 带上请求者与请求内容，避免和上一次失败混淆（模型看到"图没画出来"会以为是别的那单）
  const whoTag = sender ? `@${sender}` : '';
  const brief = String(prompt ?? '').replace(/\s+/g, ' ').slice(0, 40);
  try {
    await sendAtText(`图没画出来：${why}。这次不扣次数${brief ? `（你那句「${brief}…」我记着，重新 @我 发一次就行）` : '，重新 @我 发一次就行'}。`);
  } catch (error) { log(`⚠️ 失败通知也发不出去：${error?.message ?? error}`); }
  await markJobFinished(false, why);
  void whoTag;
}

await main();
process.exit(0);
