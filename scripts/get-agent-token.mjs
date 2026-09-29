// 取当前会话的 agent token（仅用于本地验证限制逻辑）
import fs from 'node:fs';

const stateFile = 'D:/dsh/qq-bridge/state/socialV2.json';
const candidates = [
  stateFile,
  'D:/dsh/qq-bridge/state/social-v2.json',
  'D:/dsh/qq-bridge/state/socialV2.state.json',
];
let found = null;
for (const f of candidates) {
  if (fs.existsSync(f)) { found = f; break; }
}
if (!found) {
  const dir = 'D:/dsh/qq-bridge/state';
  console.log('state 目录内容:', fs.readdirSync(dir).join(', '));
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(found, 'utf8'));
console.log('state 文件:', found);
const convs = data.conversations ?? data;
const key = process.env.QQ_GROUP ? `group:${process.env.QQ_GROUP}` : 'group:123456789';
const st = typeof convs.get === 'function' ? convs.get(key) : convs[key];
if (!st) { console.log('没找到会话', key, '现有 keys:', Object.keys(convs).slice(0, 10)); process.exit(1); }
console.log('agentToken =', st.agentToken);
console.log('lastMention =', JSON.stringify(st.lastMention));
console.log('imageQuota =', JSON.stringify(st.imageQuota));
fs.writeFileSync('D:/dsh/qq-bridge/state/.probe-agent-token', st.agentToken + '\n', 'utf8');
