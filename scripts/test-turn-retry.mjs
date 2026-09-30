// 回合级重试策略单测：工具参数写成非法 JSON（MALFORMED_RESPONSE）时该不该自动重发。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMalformedResponse, planMalformedRetry, noteMalformedRetry, MALFORMED_RETRY_HINT } from '../src/turn-retry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + ' — ' + (e?.message ?? e)); }
};

console.log('## 错误识别');
ok('MALFORMED_RESPONSE 被认出来', () => assert.equal(isMalformedResponse({ code: 'MALFORMED_RESPONSE' }), true));
ok('按 message 文本也能认出来（实测原文）', () => assert.equal(
  isMalformedResponse({ message: 'DeepSeek Messages stream: tool input is invalid JSON' }), true));
ok('限流不是这个错，不该走这条路', () => assert.equal(isMalformedResponse({ code: 'RATE_LIMIT', message: 'slow down' }), false));
ok('空输入不误判', () => assert.equal(isMalformedResponse({}), false));

console.log('\n## 重试计划');
const cfg = { socialV2: { errorRetry: { malformedMax: 2, windowMs: 180000 } } };
ok('首次允许重试，计第 1 次', () => {
  const p = planMalformedRetry({ state: {}, cfg, now: 1000 });
  assert.equal(p.allowed, true); assert.equal(p.attempt, 1); assert.equal(p.max, 2);
});
ok('窗口内第 2 次仍允许', () => {
  const p = planMalformedRetry({ state: { malformedRetry: { count: 1, at: 1000 } }, cfg, now: 2000 });
  assert.equal(p.allowed, true); assert.equal(p.attempt, 2);
});
ok('窗口内用完 2 次后不再重试（避免死循环）', () => {
  const p = planMalformedRetry({ state: { malformedRetry: { count: 2, at: 1000 } }, cfg, now: 2000 });
  assert.equal(p.allowed, false); assert.equal(p.attempt, 2);
});
ok('超出窗口后计数归零，重新允许', () => {
  const p = planMalformedRetry({ state: { malformedRetry: { count: 2, at: 1000 } }, cfg, now: 1000 + 180001 });
  assert.equal(p.allowed, true); assert.equal(p.attempt, 1);
});
ok('malformedMax=0 等于关掉自动重试', () => {
  const p = planMalformedRetry({ state: {}, cfg: { socialV2: { errorRetry: { malformedMax: 0 } } }, now: 1 });
  assert.equal(p.allowed, false);
});
ok('配置缺失时用安全默认（2 次 / 3 分钟）', () => {
  const p = planMalformedRetry({ state: {}, cfg: {}, now: 1 });
  assert.equal(p.max, 2); assert.equal(p.windowMs, 180000); assert.equal(p.allowed, true);
});
ok('计划里带着给模型的重发提示', () => {
  const p = planMalformedRetry({ state: {}, cfg, now: 1 });
  assert.ok(p.hint.includes('合法 JSON') && p.hint.includes('引号'), p.hint.slice(0, 60));
  assert.equal(p.hint, MALFORMED_RETRY_HINT);
});
ok('记账写回会话状态', () => {
  const st = {};
  noteMalformedRetry(st, { now: 500 });
  assert.deepEqual(st.malformedRetry, { count: 1, at: 500 });
  noteMalformedRetry(st, { now: 600 });
  assert.deepEqual(st.malformedRetry, { count: 2, at: 600 });
});

console.log('\n## 接线（源码级断言：这些行为必须真的接上，否则策略再对也没用）');
const bridge = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
ok('桥接 import 了重试策略', () => assert.match(bridge, /from '\.\/turn-retry\.mjs'/));
ok('错误分支用了 isMalformedResponse/planMalformedRetry/noteMalformedRetry', () => {
  assert.match(bridge, /isMalformedResponse\(\{ code, message: msg \}\)/);
  assert.match(bridge, /planMalformedRetry\(\{ state: stErr, cfg \}\)/);
  assert.match(bridge, /noteMalformedRetry\(stErr\)/);
});
ok('重试时会安排唤醒并带上重发提示', () => {
  assert.match(bridge, /stErr\.retryHint = plan\.hint/);
  assert.match(bridge, /scheduleWakeV2\(key, `retry:malformed:\$\{plan\.attempt\}`\)/);
});
ok('唤醒提示里消费一次 retryHint（不长期占上下文）', () => {
  assert.match(bridge, /const retryLine = \(\(\) => \{[\s\S]{0,400}st\.retryHint = '';/);
  assert.match(bridge, /\|\| retryLine;|participationLine \+ retryLine;/);
});
ok('错误分支现在会写本地日志（原来什么都不记）', () => assert.match(bridge, /log\(`⚠️ agent 回合出错/));
ok('技术细节私聊 owner，不再把原始报错丢进群里', () => {
  assert.match(bridge, /await sendOwnerDM\(`⚠️ 群 \$\{key\} 的 agent 回合出错/);
  assert.ok(!bridge.includes('`⚠️ agent 处理出错：${safeMsg}`'), '旧的"把技术文案发群里"的写法应已移除');
});
// [2026-09-30 政策变更] owner：「这类系统提示加上就不太像群友了」→ 出错提示**不再发群**，
// 只走 systemNotice()（写 bridge.log + 活动记录）。这条断言从此改成钉"不许再发群"。
ok('回合出错只写本地记录，不往群里发系统提示', () => {
  assert.match(bridge, /if \(!retried\) \{[\s\S]{0,200}systemNotice\(key, '⚠️ 我这边卡了一下/);
  assert.ok(!bridge.includes("sendToQQ(key, '⚠️ 我这边卡了一下"), '不该再发群');
});
ok('默认配置里有 errorRetry（2026-09-30 省 token：重试上限从 2 收到 1，一次重试就是整轮重发）', () => assert.match(bridge, /errorRetry: \{[\s\S]{0,300}?malformedMax: 1[\s\S]{0,300}?windowMs: 180000/));

const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
ok('MCP 的 messages 描述明确要求加引号', () => {
  assert.match(mcp, /记得写引号/);
  assert.match(mcp, /不要把整段话写成不带引号的裸文本/);
});
const preset = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'), 'utf8');
ok('preset 里加了"参数必须是合法 JSON"的规则', () => {
  assert.match(preset, /【工具参数必须是合法 JSON】/);
  assert.match(preset, /绝不要把中文正文写成不带引号的裸文本/);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
