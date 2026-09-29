// 回归：MCP 里每个「智能体调用」都必须带 x-agent-token 头。
//
// 事故来源（2026-09-29）：桥接 v0.1.7 把「智能体调用」集中把关 —— MCP 的 agentApi 会自动加
// `x-agent-call: 1`，桥接看到这个头就要求**请求头**里有有效的会话令牌（防 confused deputy）。
// 我们把 v0.1.5 时代的生图工具重挂回新文件时，只把 token 放进了 body、漏了请求头，
// 于是模型两次调用生图都被 401 拒掉（群里只看到"生图失败：未授权…"）。
// 这类错误靠"跑一遍功能"才发现太贵，所以在源码层面钉死。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src', 'mcp-snowluma-safe.js');
const src = fs.readFileSync(FILE, 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// ── 取出所有 agentApi(...) 调用，连同它括号内的完整参数文本 ──────────────────
function collectAgentApiCalls(text) {
  const out = [];
  const re = /agentApi\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 跳过函数定义本身（`async function agentApi(path, init = {})`）
    if (/(?:async\s+)?function\s+$/.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    const start = m.index + m[0].length;
    let depth = 1; let i = start;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    const args = text.slice(start, i - 1);
    const urlMatch = /^\s*[`'"]([^`'"]+)[`'"]/.exec(args);
    out.push({ url: urlMatch ? urlMatch[1] : '(动态拼接)', args, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

const calls = collectAgentApiCalls(src);
console.log(`## 扫描到 ${calls.length} 处 agentApi 调用`);
ok('至少扫到 20 处（防止正则失效导致"全绿"假象）', calls.length >= 20, String(calls.length));

// 不需要会话令牌的端点：/api/status 是模式探测（桥接按最小对象放行，见 bridge.js 的 legacyReadToolAllowed）。
const NO_TOKEN_OK = [/^\/api\/status$/];

const missing = [];
for (const c of calls) {
  if (NO_TOKEN_OK.some((re) => re.test(c.url))) continue;
  if (!/x-agent-token/.test(c.args)) missing.push(`L${c.line} ${c.url}`);
}
ok('除 /api/status 外，所有 agentApi 调用都带 x-agent-token 头',
  missing.length === 0, missing.length ? '缺头：' + missing.join(' | ') : `${calls.length} 处全部合规`);

console.log('\n## 生图工具（这次出事的那个）');
const imageCalls = calls.filter((c) => c.url.includes('image-request'));
ok('生图有两处调用（预检 consume:false + 扣配额 consume:true）', imageCalls.length === 2, String(imageCalls.length));
ok('两处都带 x-agent-token 头', imageCalls.every((c) => /x-agent-token/.test(c.args)));
ok('仍保留 body 里的 token（兼容旧桥接）', imageCalls.every((c) => /JSON\.stringify\(\{ key, token/.test(c.args)));

console.log('\n## 桥接侧的集中关卡（前提：它确实要求这个头）');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
ok('桥接有 x-agent-call 集中关卡', /if \(req\.headers\['x-agent-call'\] !== undefined\)/.test(bridge));
ok('关卡要求 isLiveAgentToken(请求头 x-agent-token)', /isLiveAgentToken\(req\.headers\['x-agent-token'\]\)/.test(bridge));
ok('MCP 的 agentApi 会自动加 x-agent-call: 1', /headers\['x-agent-call'\] = '1'/.test(src));
ok('qq-wait 那个独立 MCP 也一样加了这个头', /headers\['x-agent-call'\] = '1'/.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp-qq-wait.js'), 'utf8')));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
