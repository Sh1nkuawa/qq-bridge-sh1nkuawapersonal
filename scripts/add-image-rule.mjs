// 在 qq-chat-v2 预设里加入第 29 条：生图
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const INSTALLED = path.join(os.homedir(), '.dsh', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const REPO = 'D:/dsh/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml';

const RULE = [
  '29. 【生图】群友 @你 并且消息以「生图」开头时（例如「@你 生图 一只穿女仆装的蓝色小鲸鱼」），调用 mcp__snowluma__qq_generate_image 生成图片并自动发到群里。',
  '29.1 参数：key 传当前会话 key（如 group:123456789）；prompt 传画面描述——把「生图」后面的内容整理成更具体的描述（主体、风格、颜色、构图、背景），中英文都行，英文往往效果更好，可以自己补充细节让画面更好看；token 必须传【会话令牌】。',
  '29.2 【很慢】一次生图要 1~4 分钟，期间不要重复调用、也不要发消息催促；调用成功后图片会自动发到群里，你可以再简短说一句画面内容，但不要长篇汇报。',
  '29.3 【限制】只有被 @ 且以「生图」开头才能用；别人只是聊天里提到"画个图"但没 @你、或没以「生图」开头，就不要调用。每个 QQ 号每天限 5 次（管理员不限）；工具返回"今日生图次数已用完"时，如实告诉对方今天额度用完了、明天再来，不要反复重试。',
  '29.4 【失败处理】工具报错时（例如超时、后端不可用），如实说一句"没生成出来"，不要假装已经发图，也不要反复重试消耗次数。',
].join('\n      ');

const src = fs.readFileSync(INSTALLED, 'utf8');
if (/^\s*29\.\s*【生图】/m.test(src)) {
  console.log('[preset] 第 29 条已存在，跳过');
  process.exit(0);
}

const lines = src.split('\n');
const anchor = lines.findIndex((l) => /^\s*28\.3/.test(l));
if (anchor < 0) { console.error('[preset] 找不到 28.3，无法定位插入点'); process.exit(1); }
const indent = (lines[anchor].match(/^\s*/) ?? [''])[0];
const block = RULE.split('\n').map((l) => indent + l.trim());
lines.splice(anchor + 1, 0, ...block);
const out = lines.join('\n');

let parsed;
try {
  parsed = yaml.load(out);
} catch (e) {
  console.error('[preset] 生成 YAML 解析失败，已放弃：', e.message);
  process.exit(1);
}
const persona = (Array.isArray(parsed) ? parsed : []).find((x) => x?.id === 'persona');
const prefix = persona?.config?.prefix ?? '';
if (!/29\.\s*【生图】/.test(prefix)) { console.error('[preset] 校验失败：prefix 里没有第 29 条'); process.exit(1); }

fs.copyFileSync(INSTALLED, INSTALLED + '.bak-image');
fs.writeFileSync(INSTALLED, out, 'utf8');
fs.writeFileSync(REPO, out, 'utf8');

console.log('[preset] ✅ 已加入第 29 条（生图）');
console.log('         prefix 长度:', prefix.length);
console.log('         28 在 29 之前:', prefix.indexOf('28. 【余额查询') < prefix.indexOf('29. 【生图】'));
