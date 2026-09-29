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
// 编号会随上游 preset 改版顺延（本副本重挂到 17~23 段后是 20.6.1），所以按内容断言不按编号。
ok('预设含生图状态口径', /【生图状态只信提示里的那两行】/.test(preset)
  && /【后台正在生图】/.test(preset) && /【生图结果：失败】/.test(preset));

console.log('\n## 「待办：生图请求」——桥接回了开场白 ≠ 模型已经调用工具');
// 2026-09-29 实测事故：owner 发「@我 生图，一只小鲸鱼」，桥接替它回了开场白（"行，等我几分钟"），
// 模型于是以为已经受理，整轮没调用 qq_generate_image，转头去回答别人的考研问题 —— 群里永远等不到图。
ok('回执时会记一条待办（含请求原文与请求者）', /st\.imagePending = \{[\s\S]{0,400}text: String\(text \?\? ''\)\.slice\(0, 160\)/.test(bridge));
ok('回执函数接收请求原文', /async function sendImageAck\(key, \{[^}]*text = ''/.test(bridge));
ok('即时回执把原文传进去', /early: true,\s*requestId,\s*text: String\(text \?\? ''\),/.test(bridge));
ok('真正受理后清掉待办（不重复催）', /st\.imageTicket = null;[\s\S]{0,600}st\.imagePending = null;/.test(bridge));
ok('唤醒提示里有【待办：生图请求】段', /【待办：生图请求】/.test(bridge));
ok('这段明确写着"你还没有调用 qq_generate_image"', /你还没有调用 qq_generate_image/.test(bridge));
ok('这段会给出 key 与调用要点（prompt/token）', /key 传 "\$\{key\}"/.test(bridge) && /token 传上面的会话令牌/.test(bridge));
ok('待办有过期时间（默认 15 分钟，可配 pendingTtlMs）', /pendingTtlMs: 900000/.test(bridge) && /const ttlMs = Number\(cfg\.socialV2\?\.image\?\.pendingTtlMs\)/.test(bridge));
ok('只在没有进行中任务时才提示待办', /if \(!job\) \{[\s\S]{0,700}【待办：生图请求】/.test(bridge));
ok('预设新增 20.3.2：开场白不代表已受理', /【最容易犯的错：以为桥接会自己画】/.test(preset));
ok('预设 20.3.2 明确"真正开始画只有一条路"', /真正开始画只有一条路——你调用 `qq_generate_image`/.test(preset));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
