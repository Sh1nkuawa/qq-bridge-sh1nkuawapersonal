// 控制台页面自检：新增的 memes 控件是否 html/js 都接上了（排查手写 UI 漏接）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'public', 'console.html');
const t = fs.readFileSync(file, 'utf8');

const open = (t.match(/<div/g) || []).length;
const close = (t.match(/<\/div>/g) || []).length;
console.log(`div 开/闭: ${open}/${close} ${open === close ? '平衡' : '⚠️ 不平衡'}`);

const ids = [
  'v2MemesEnabled', 'v2MemesPromptMax', 'v2MemesIncludePrompt', 'v2MemesPerMin',
  'v2MemesPerHour', 'v2MemesRecentAvoid', 'v2MemesPackDirs', 'v2MemesPacks',
  'v2MemesProbe', 'v2MemesProbeMsg', 'v2MemesProbeOutput',
  'v2MemesTestKey', 'v2MemesTestTag', 'v2MemesTestSend', 'v2MemesTestMsg',
  // 群管理面板
  'v2AdminEnabled', 'v2AdminDryRun', 'v2AdminAnnounceInGroup', 'v2AdminNotifyOwner',
  'v2AdminSpamText', 'v2AdminSpamImage', 'v2AdminSpamWindow', 'v2AdminAttackCount', 'v2AdminAttackWindow',
  'v2AdminMuteSpamBase', 'v2AdminMuteAttackBase', 'v2AdminMuteStep', 'v2AdminMuteMax', 'v2AdminMuteCooldown',
  'v2AdminLimitHour', 'v2AdminLimitDay', 'v2AdminLimitMemberDay', 'v2AdminWhitelist',
  'v2AdminNoticeMax', 'v2AdminNoticeLinks', 'v2AdminNoticePinned', 'v2AdminNoticeConfirm', 'v2AdminNoticeTimeout',
  'v2AdminAttackKeywords', 'v2AdminLoad', 'v2AdminMsg', 'v2AdminStatusOutput',
  'v2AdminMuteUser', 'v2AdminMuteMinutes', 'v2AdminMuteBtn', 'v2AdminUnmuteBtn', 'v2AdminMuteMsg',
  'v2AdminNoticeApprove', 'v2AdminNoticeReject', 'v2AdminNoticeMsg', 'v2AdminNoticeOutput', 'v2AdminLogOutput'
];
let bad = 0;
for (const id of ids) {
  const inHtml = t.includes(`id="${id}"`);
  const inJs = t.includes(`getElementById('${id}')`);
  const flag = inHtml && inJs;
  if (!flag) bad++;
  console.log(`${inHtml ? 'html✓' : 'html✗'} ${inJs ? 'js✓' : 'js✗'} ${id}`);
}
// 检查工具勾选项
for (const flag of ['sendMeme', 'sendSticker', 'collectSticker', 'requestMute', 'proposeAnnouncement']) {
  const ok = t.includes(`data-v2-tool="${flag}"`);
  if (!ok) bad++;
  console.log(`${ok ? 'tool✓' : 'tool✗'} data-v2-tool=${flag}`);
}
// 关键结构不能被手写编辑弄坏
for (const snippet of ['const tools = {};', 'function clampInt(', 'admin: {', 'context: {', 'recentLimit: Math.round']) {
  const ok = t.includes(snippet);
  if (!ok) bad++;
  console.log(`${ok ? 'struct✓' : 'struct✗'} ${snippet}`);
}
console.log(bad === 0 ? '\n✅ 控制台接线完整' : `\n❌ 有 ${bad} 项未接线`);
process.exit(bad === 0 ? 0 : 1);
