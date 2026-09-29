import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'config.example.json');
const dst = path.join(ROOT, 'config.json');

if (fs.existsSync(dst)) {
  console.log('[skip] config.json 已存在，未覆盖');
} else {
  const cfg = JSON.parse(fs.readFileSync(src, 'utf8'));

  // 会话工作目录固定到本仓库（空着会让 DSH 用默认 workspace）
  cfg.sessionCwd = ROOT;

  // 安全默认：白名单为空 + allowAllWhenEmpty=false 时桥接不转发任何消息。
  // 这里保持 fail-closed，等你填了 ownerQQ / allow.groups 再放开。
  console.log('[info] allowAllWhenEmpty =', cfg.allowAllWhenEmpty, '（白名单为空时不响应任何群/私聊）');

  fs.writeFileSync(dst, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('[ok] 已生成 config.json');
}

// 汇报关键待填项
const cfg = JSON.parse(fs.readFileSync(dst, 'utf8'));
const todo = [];
if (!cfg.ownerQQ) todo.push('ownerQQ        —— 你的 QQ 号（管理员，管理命令只有它能用）');
if (!cfg.allow.groups.length && !cfg.allow.private.length) {
  todo.push('allow.groups   —— 允许机器人说话的群号，例如 [123456789]');
}
if (!cfg.snowluma.wsUrl.includes('127.0.0.1:3001')) {
  todo.push('snowluma.wsUrl —— 确认与 OneBot 的 WebSocket 端口一致');
}
console.log('\n=== 还需要你填的 ===');
if (todo.length === 0) {
  console.log('（无）');
} else {
  for (const t of todo) console.log('  - ' + t);
}
console.log('\n=== 当前关键配置 ===');
console.log('  dsh.baseUrl      =', cfg.dsh.baseUrl);
console.log('  dsh.authToken    =', cfg.dsh.authToken === '' ? '(空，自动从 DSH guard 日志发现)' : '(已填)');
console.log('  snowluma.wsUrl   =', cfg.snowluma.wsUrl);
console.log('  snowluma.httpUrl =', cfg.snowluma.httpUrl);
console.log('  sessionCwd       =', cfg.sessionCwd);
console.log('  agentPreset      =', cfg.agentPreset);
console.log('  consolePort      =', cfg.consolePort);
