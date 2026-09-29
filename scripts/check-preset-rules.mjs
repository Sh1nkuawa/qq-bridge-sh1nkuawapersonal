// 校验两个 preset 的规则完整性（YAML 可解析 + 关键规则都在）
import fs from 'node:fs';
import yaml from '../node_modules/js-yaml/index.js';

const files = [
  'C:/Users/<you>/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml',
  'D:/dsh/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml'
];
const needles = ['【关系与语气】', '30.1', '30.2', '30.3', '30.4', '29.6', '29.5'];
for (const f of files) {
  try {
    const s = JSON.stringify(yaml.load(fs.readFileSync(f, 'utf8')));
    const missing = needles.filter((n) => !s.includes(n));
    console.log(`  ${missing.length ? '❌' : '✅'} ${f.split('/').slice(-3).join('/')}  缺失: ${missing.join(',') || '无'}`);
  } catch (e) {
    console.log(`  ❌ ${f} YAML 解析失败: ${e.message}`);
  }
}
