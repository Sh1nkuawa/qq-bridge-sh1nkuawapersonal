// 验证「生图工具的调用形状」是否被桥接接受（只跑不扣配额的前置校验 consume:false）。
// 用会话状态里的真实 agentToken，带齐桥接要求的头（x-agent-call + x-agent-token）。
// 退出码：0 = 桥接接受了这次智能体调用（哪怕因为 @ 票据过期而拒绝"生图资格"，也算鉴权通过）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const token = cfg.consoleToken || fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const port = Number(cfg.consolePort) || 3100;
const key = process.argv[2] || `group:${(cfg.allow?.groups ?? [])[0] ?? ''}`;

const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const agentToken = state?.conversations?.[key]?.agentToken;
if (!agentToken) {
  console.error(`❌ 会话 ${key} 没有 agentToken（桥接没为它建会话？）`);
  process.exit(2);
}

const res = await fetch(`http://127.0.0.1:${port}/api/socialV2/image-request`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token, 'x-agent-call': '1', 'x-agent-token': agentToken },
  body: JSON.stringify({ key, token: agentToken, consume: false }),
  signal: AbortSignal.timeout(20000),
});
const body = await res.json().catch(() => null);
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(body, null, 2));

const authFailed = /会话令牌|未授权/.test(String(body?.error ?? ''));
console.log('');
if (authFailed) {
  console.log('❌ 鉴权仍被拒（头没带对）—— 这正是模型看到的那个错误');
  process.exit(1);
}
if (body?.ok) {
  console.log('✅ 鉴权通过 + @ 票据有效：现在调用生图会被受理（本次 consume:false，不扣配额、不生成）');
} else {
  console.log('✅ 鉴权通过（不再是"未授权"）；这次被拒的原因是："' + (body?.error ?? '未知') + '"');
  console.log('   —— 若原因是 @ 票据过期/没有 @ 记录，让群友重新 @ 一次「生图 …」即可。');
}
process.exit(0);
