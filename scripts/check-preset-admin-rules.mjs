// 只读校验：预设里的规则编号/关键规则是否齐（手写 YAML 容易漏或串号）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'),
  path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml')
];
const mustHave = [
  '26.1 【本地表情包库',
  '32. 【群管理：禁言与群公告',
  '32.1',
  '32.2',
  '32.3',
  '32.4',
  '32.5',
  '32.6',
  'qq_request_mute',
  'qq_propose_announcement',
  'qq_group_admin_info',
  '不许承诺',
  '踢人',
  '群相册'
];
const mustNotHave = [
  { pattern: /qq_kick/i, why: '不该出现踢人工具' },
  { pattern: /qq_set_group_ban/i, why: '不该让模型直接调禁言接口' },
  { pattern: /qq_delete_group_file/i, why: '不该出现群文件操作' }
];

let bad = 0;
const seen = new Set();
for (const file of files) {
  if (!file || seen.has(file)) continue;
  seen.add(file);
  if (!fs.existsSync(file)) { console.log(`⚠️ 不存在：${file}`); continue; }
  const t = fs.readFileSync(file, 'utf8');
  console.log(`\n== ${file} ==`);
  for (const s of mustHave) {
    const ok = t.includes(s);
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} 含 ${s.slice(0, 24)}`);
  }
  for (const { pattern, why } of mustNotHave) {
    const hit = pattern.test(t);
    if (hit) bad++;
    console.log(`${hit ? '✗' : '✓'} ${why}`);
  }
  // 规则编号连续性（只看顶层规则行：以「数字. 【」开头的）
  const ids = [...t.matchAll(/^\s+(\d+)\.\s*【/gm)].map((m) => Number(m[1]));
  const uniq = [...new Set(ids)].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] !== uniq[i - 1] + 1) gaps.push(`${uniq[i - 1]}→${uniq[i]}`);
  }
  if (gaps.length) { bad++; console.log(`✗ 顶层规则编号不连续：${gaps.join(', ')}`); }
  else console.log(`✓ 顶层规则编号连续（${uniq[0]}~${uniq[uniq.length - 1]}，共 ${uniq.length} 条）`);
}
console.log(bad === 0 ? '\n✅ 预设规则校验通过' : `\n❌ ${bad} 项问题`);
process.exit(bad === 0 ? 0 : 1);
