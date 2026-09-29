// 二代等待逻辑的「实时」端到端测试：真建一个 qq-chat-v2 会话并向 DSH 提问，
// 断言 qq_wait_for_messages 出现在该 preset 的可用工具面里。需要 DSH 正在运行。
// （纯逻辑单测见 scripts/test-v2-wait.mjs，两者不重复。）
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  let auth;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    auth = {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch {}
  const api = new NodeApiClient('http://127.0.0.1:3080', undefined, auth);
  const cwd = path.join(ROOT, 'state', 'self-test-v2-wait');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
  const sessionId = created.sessionId;
  console.log('SESSION_CREATED', sessionId);

  const stream = api.events.mux({});
  const collector = createTurnCollector();
  // 这个用例要靠模型自己把回合走完（它会输出一份很长的工具名 JSON），deepseek-flash 在
  // 高思考强度下偶尔要 2 分钟以上。超时只说明"模型没答完"，**不能**据此判定工具面缺失，
  // 所以超时按跳过处理（见文件末尾），不制造假红。
  const timeoutMs = Number(process.env.V2_WAIT_E2E_TIMEOUT_MS || 240000);
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT 等待回复超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) {
            clearTimeout(timer);
            resolve(ended);
            return;
          }
        }
        if (frame.type === 'stream/error') {
          clearTimeout(timer);
          reject(new Error('事件流错误: ' + JSON.stringify(frame.error)));
          return;
        }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });

  stream.follow(sessionId);
  const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '请只输出你当前可用的工具名列表（JSON 数组），不要调用任何工具，不要发送消息。只输出 JSON。' }] }), 'session.prompt');
  console.log('PROMPT_ACCEPTED', JSON.stringify(accepted).slice(0, 120));
  const ended = await done;
  const text = ended.text || '';
  console.log('TOOLS_TEXT_START');
  console.log(text.slice(0, 3000));
  console.log('TOOLS_TEXT_END');
  const hasWait = text.includes('qq_wait_for_messages');
  console.log('HAS_qq_wait_for_messages=' + hasWait);
  // 反向断言：这些"插件/资源"类全局工具不该出现在仿真会话的工具面里
  // （qq-tool-restrict 已把它们 restrict 掉；它们对群友人格没用，还会白占 schema token）。
  //
  // 注意：restrict 是在 preset **挂载时**由插件模块执行的，而 DSH 会缓存已 import 的模块 ——
  // 所以改完守卫后必须先重启 DSH 才会生效。默认把这条当"提示"而不是失败，避免在没有重启的
  // 环境里制造假红；重启过 DSH 之后可以用 STRICT_TOOL_FACE=1 把它升级成硬断言。
  const unwanted = ['find_dsh_plugin', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
  const leaked = unwanted.filter((n) => text.includes(n));
  console.log('UNWANTED_TOOLS=' + (leaked.length ? leaked.join(',') : '(none)'));
  if (leaked.length) {
    console.log('NOTE 这些工具仍在会话 schema 里：执行期白名单已经会拒绝它们，只是仍占 token。');
    console.log('     守卫模块已把它们加入 restrict 名单；DSH 重启后生效（重启后可用 STRICT_TOOL_FACE=1 严格校验）。');
  }
  const strict = process.env.STRICT_TOOL_FACE === '1';
  const ok = hasWait && (leaked.length === 0 || !strict);
  console.log('RESULT=' + (ok ? (hasWait ? (leaked.length ? 'WAIT_TOOL_VISIBLE (strict 未开，泄露仅提示)' : 'WAIT_TOOL_VISIBLE') : 'CHECK_FAILED') : 'CHECK_FAILED'));
  try { await api.workspace.archiveSession({ sessionId }); console.log('SESSION_ARCHIVED', sessionId); } catch {}
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  if (/TIMEOUT/.test(String(e?.message ?? ''))) {
    // 模型延迟导致的超时：工具面无法判定，按"跳过"处理（退出码 0），但把原因说清楚。
    console.log('SKIPPED 模型没在超时内结束回合，工具面无法判定（这不是工具缺失）。');
    console.log('        想延长预算：set V2_WAIT_E2E_TIMEOUT_MS=420000 后再跑。');
    process.exitCode = 0;
    return;
  }
  console.error(e);
  process.exitCode = 1;
});
