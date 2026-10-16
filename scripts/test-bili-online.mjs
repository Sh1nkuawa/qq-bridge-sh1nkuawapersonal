// P1/P2/P3 的源码守卫：把"在线交付 / 按需工具 / 兜底唤醒"三条路钉住
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

console.log('P1 在线交付（传给"正在工作的"那一轮）：');

ok('★ 字幕状态要随预取结果落库（只有真的有字幕才算 ready）', () => {
  assert.match(bridge, /function pickReadySubtitle\(key\)/, '要有取"刚就绪字幕"的函数');
  assert.match(bridge, /subtitleBrief: !!/, '预取结果里要记标记');
  assert.match(bridge, /briefInfo && briefInfo\.chars > 0/, '★ no-subtitle/失败不能算 ready（否则在线交付一条空稿）');
});

ok('★ qq_wait_for_messages 的返回值里要带上它（这是唯一的在线通道）', () => {
  assert.match(bridge, /subtitleReady: pickReadySubtitle\(key\)/, 'wait 响应要带 subtitleReady');
  // 为什么必须走工具结果：一轮开始后提示词是固定的一次性输入，桥接没有"追加"接口
  assert.match(bridge, /唯一能"传给正在工作的那一轮"的通道/, '要把这条约束写进注释');
});

console.log('\nP2 按需工具 qq_bili_subtitle：');

ok('桥接端点 + AI 白名单 + 会话校验都在', () => {
  assert.match(bridge, /pathname === '\/api\/bili\/subtitle'/, '要有端点');
  assert.match(bridge, /url\.pathname === '\/api\/bili\/subtitle'\s*$/m, '要加进 agent 白名单');
  assert.match(bridge, /agentTokenOk\(aKey, agentTok\)/, '要校验 agent token 归属');
  assert.match(bridge, /v2SessionAllowed\(aKey\)/, '要校验会话允许范围');
  assert.match(bridge, /pageSubtitle\(r\.subtitle, \{/, 'fromSec 时要走翻页');
});

ok('MCP 工具存在、且把 key 一起传下去（端点要它做会话校验）', () => {
  assert.match(mcp, /'qq_bili_subtitle'/, '要注册工具');
  assert.match(mcp, /key: String\(key \?\? ''\)\.trim\(\)/, '★ 必须把 key 传给端点');
  assert.match(mcp, /agentApi\(`\/api\/bili\/subtitle\?\$\{qs\.toString\(\)\}`/, '走 agentApi（它会带控制台令牌）');
});

console.log('\nP3 兜底唤醒（只在必要时）：');

ok('兜底用独立 reason，且提示词有对应分支', () => {
  assert.match(bridge, /biliWakeProbe\(key, 'subtitleReady'\)/, '兜底原因用 subtitleReady');
  assert.match(bridge, /reason === 'subtitleReady'/, '提示词要有 subtitleReady 分支');
  assert.match(bridge, /如果你其实已经讲过了，就不用重复/, '★ 要给它"不重复"的出口（避免为了交差硬补一句）');
  assert.match(bridge, /主路径是 P1/, '要写明"唤醒只是兜底，主路径是 P1"');
});

console.log(`\n全部通过：${n} 项断言组`);
