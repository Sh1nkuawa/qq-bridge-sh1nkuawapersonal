// mcp-qq-wait.js — **只**暴露 qq_wait_for_messages 的独立 MCP stdio 服务。
//
// 为什么要单独拆一个进程：
//   MCP 的 stdio 传输是**串行**的 —— 一个请求处理完才会处理下一个。而 qq_wait_for_messages
//   是个长轮询，最长 10 分钟。它和生图、发消息挤在同一个 mcp-snowluma-safe.js 里时，
//   只要 agent 正在等待，其他所有工具调用都只能排队。实测踩过一次：
//   群友 @ 机器人要求生图，qq_generate_image 确实被调用了，但它排在前面那个 90 秒的
//   qq_wait_for_messages 后面，一直没轮到执行，codex 自然也没有任何日志。
//
// 拆开之后：长等待只堵住它自己，其他工具永远立即可用。
// 工具名会从 mcp__snowluma__qq_wait_for_messages 变成 mcp__<serverName>__qq_wait_for_messages
// （serverName 在 cordis.patch.yml 里配置），功能完全不变。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

function readConsoleToken() {
  // 每次请求都重新读取，避免 token 变化后仍用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function agentApi(apiPath, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  // 声明「这是一次智能体调用」：桥接据此把「没带会话令牌」判定为拒绝，而不是退化成
  // 「管理端全权」（confused deputy）。与 mcp-snowluma-safe.js 的 agentApi 保持一致。
  headers['x-agent-call'] = '1';
  const res = await fetch(`${agentApiBase()}${apiPath}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  return body;
}

const server = new McpServer({ name: 'qq-wait', version: '0.1.7' });

// [qq-bridge 本地补丁] 这里的工具定义必须与 src/mcp-snowluma-safe.js 里那份**保持同步**：
// 合并上游 v0.1.7 后，等待工具新增了 purpose="reply"（首答前短静默）与 readThroughSeq 水位，
// 独立进程里若还是旧版语义，模型会同时看到两套说法（更糟的是它可能挑中旧的那份）。
server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
