// 语音功能现状体检：MCP 工具是否注册、控制台语音面板在哪一组、配置与依赖是否就绪。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcp = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));

console.log('=== MCP 工具注册 ===');
for (const k of ["'qq_send_voice'", "'qq_list_voices'", "qq_send_voice: 'sendVoice'", "qq_list_voices: 'sendVoice'"]) {
  console.log(`${mcp.includes(k) ? '✅' : '❌'} ${k}`);
}

console.log('\n=== 配置 ===');
const v = cfg.socialV2?.voice ?? {};
console.log('  socialV2.voice.enabled      = ' + v.enabled);
console.log('  socialV2.tools.sendVoice    = ' + cfg.socialV2?.tools?.sendVoice);
console.log('  voice.dir                   = ' + (v.dir ?? '(默认 audio)'));
console.log('  maxSeconds / maxBytes       = ' + v.maxSeconds + ' / ' + v.maxBytes);
console.log('  maxPerMinute / maxPerHour   = ' + v.maxPerMinute + ' / ' + v.maxPerHour);
console.log('  defaultVolume / loudness    = ' + v.defaultVolume + ' / ' + v.loudness);
console.log('  ffmpegPath                  = ' + JSON.stringify(v.ffmpegPath ?? ''));
console.log('  autoReadback                = ' + v.autoReadback);
const audioDir = path.resolve(ROOT, v.dir ?? 'audio');
console.log(`  语音库目录 ${audioDir} → ${fs.existsSync(audioDir) ? '存在，' + fs.readdirSync(audioDir).length + ' 个文件' : '不存在'}`);

console.log('\n=== 控制台语音面板（「语音库与语音发送（调试）」组）===');
const idx = consoleHtml.indexOf('data-v2-tool="sendVoice"');
const groupAt = consoleHtml.lastIndexOf('<summary>', idx);
const groupEnd = consoleHtml.indexOf('</summary>', groupAt);
console.log('  工具勾选所在分组: ' + consoleHtml.slice(groupAt + 9, groupEnd));
const panelAt = consoleHtml.indexOf('语音库与语音发送');
console.log('  调试面板分组: ' + (panelAt >= 0 ? '✅ 存在' : '❌ 缺失'));
for (const id of ['voiceRefreshBtn', 'voiceSendTarget', 'voiceSendDryRun', 'voiceSendBtn', 'voiceList']) {
  console.log(`  ${consoleHtml.includes(`id="${id}"`) ? '✅' : '❌'} id="${id}"`);
}

console.log('\n=== 外部依赖 ===');
console.log('  ffprobe 探测时长/编码 —— 不在 PATH 时非 SILK 音频会被拒');
console.log('  ffmpeg  调音量/响度   —— 只在需要音量处理时用');
