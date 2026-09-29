// 语音链路体检（经桥接，**不发送**）：用「只校验不发送」跑一遍 /api/voice/send，
// 确认桥接侧的 ffprobe 探测（时长/编码）与白名单校验都正常。
//
// 用法：node scripts/probe-voice-send.mjs <音频绝对路径> [目标key]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const token = cfg.consoleToken || fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const port = Number(cfg.consolePort) || 3100;

const file = process.argv[2];
const target = process.argv[3] || `group:${(cfg.allow?.groups ?? [])[0] ?? ''}`;
if (!file) {
  console.error('用法：node scripts/probe-voice-send.mjs <音频绝对路径> [目标key]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`❌ 音频不存在：${file}`);
  process.exit(2);
}

const res = await fetch(`http://127.0.0.1:${port}/api/voice/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-console-token': token },
  body: JSON.stringify({ target, file, dryRun: true }),
  signal: AbortSignal.timeout(60000),
});
const data = await res.json().catch(() => null);
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(data, null, 2));

const probe = data?.probe ?? data;
const okProbe = res.status === 200 && data?.ok !== false && (probe?.duration !== undefined || probe?.durationSec !== undefined);
console.log(`\n${okProbe ? '✅ 桥接侧探测成功（能看到时长/编码）——ffprobe 已被正确找到' : '⚠ 没看到时长信息：可能是 ffprobe 未解析到，或响应结构不同（见上面 JSON）'}`);
process.exit(res.status === 200 && data?.ok !== false ? 0 : 1);
