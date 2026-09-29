// 在 qq-chat-v2 预设里加入第 28 条：余额查询
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const HERE = 'D:/dsh/qq-bridge';
const INSTALLED = path.join(os.homedir(), '.dsh', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const REPO = path.join(HERE, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');

const RULE = [
  '28. 【余额查询】群友问"余额还有多少""额度剩多少""还能用多久""没钱了吗"这类问题时，调用 mcp__snowluma__qq_get_balance 查真实余额，然后把结果用一句话自然地说出来（例如"还剩 ¥104.25"）。',
  '28.1 只报工具返回的数字，不要自己编；查询失败就老实说"查不到余额"。',
  '28.2 不要主动播报余额（没人问就不说），也不要把余额当谈资反复提。',
  '28.3 别人追问"够不够用""还能聊多久"时，可以基于余额给个大概判断，但别承诺具体能聊多少轮——用量取决于话题长度。',
].join('\n      ');

const src = fs.readFileSync(INSTALLED, 'utf8');
if (/^\s*28\.\s*【余额查询】/m.test(src)) {
  console.log('[preset] 第 28 条已存在，跳过');
  process.exit(0);
}

// 在 27.7 那一行之后插入
const lines = src.split('\n');
const i277 = lines.findIndex((l) => /^\s*27\.7/.test(l));
if (i277 < 0) { console.error('[preset] 找不到 27.7，无法定位插入点'); process.exit(1); }
const indent = (lines[i277].match(/^\s*/) ?? [''])[0];
const block = RULE.split('\n').map((l, i) => (i === 0 ? indent + l : indent + l));
lines.splice(i277 + 1, 0, ...block);
const out = lines.join('\n');

// 语法校验：能被 YAML 解析且 persona.prefix 含新规则
let parsed;
try {
  parsed = yaml.load(out);
} catch (e) {
  console.error('[preset] 生成的 YAML 解析失败，已放弃写入：', e.message);
  process.exit(1);
}
const persona = (Array.isArray(parsed) ? parsed : []).find((x) => x?.id === 'persona');
const prefix = persona?.config?.prefix ?? '';
if (!/28\.\s*【余额查询】/.test(prefix)) {
  console.error('[preset] 校验失败：prefix 里没有第 28 条');
  process.exit(1);
}

fs.copyFileSync(INSTALLED, INSTALLED + '.bak-balance');
fs.writeFileSync(INSTALLED, out, 'utf8');
fs.writeFileSync(REPO, out, 'utf8');

console.log('[preset] ✅ 已加入第 28 条（余额查询）');
console.log('         安装版:', INSTALLED);
console.log('         仓库源:', REPO);
console.log('         prefix 长度:', prefix.length);
console.log('         27.7 在第 28 条之前:', prefix.indexOf('27.7') < prefix.indexOf('28. 【余额查询】'));
