// 生图状态口径验收（只读 + 单元）：失败后模型不能再被"没有状态"误导着说"正在画"。
// 用法：node scripts/test-image-state.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-image-worker.mjs'), 'utf8');
const preset = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 失败状态要被记住并注入提示');
ok('image-job 回调会记录 imageFail / imageDone', /st\.imageFail = \{/.test(bridge) && /st\.imageDone = \{/.test(bridge));
ok('唤醒提示里有【生图结果：失败】这一段', /【生图结果：失败】/.test(bridge));
ok('失败段明确禁止"还在画/等两分钟"', /绝对不要\*\*说"还在画\/正在生成\/马上好\/等两分钟"/.test(bridge));
ok('仍保留进行中那一段（有 job 时才出现）', /【后台正在生图】/.test(bridge));

console.log('## 失败回执要说清是哪一单、什么原因');
ok('worker 会分类真实原因（不再一律写"超时"）', /referenced photo|wasn't attached|was not attached/.test(worker));
ok('失败文案带上请求内容片段，避免和上一单混淆', /你那句「/.test(worker));
ok('worker 把成功发出的图回报给桥接（含路径+消息id）', /sentImage/.test(worker) && /message_id/.test(worker));

console.log('## 引用机器人自己发的图 → 能当参考图');
ok('桥接会把 worker 上报的图存成持久副本并记入上下文', /generated-images/.test(bridge) && /recordSelfMessage\(key, '\[我发的图\]'/.test(bridge));
ok('本地图引用 "local:" 能被识别', /function localPathOfMedia/.test(bridge) && /local:/.test(bridge));
ok('引用我的图但本地已丢 → 提前报错，不烧 codex', /REF_IMAGE_LOST/.test(bridge));

console.log('## 预设规则：只有"进行中"那行才允许说正在画');
ok('预设含 29.6.1 生图状态口径', /29\.6\.1 【生图状态只信提示里的那两行】/.test(preset));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
