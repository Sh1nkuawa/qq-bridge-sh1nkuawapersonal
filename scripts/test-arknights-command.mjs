// arknights-command 纯函数回归（触发命令判定 + 状态描述）：不联网、不碰 MAA/QQ。
// 用法：node scripts/test-arknights-command.mjs
import { describeJob, formatArknightsReport, isArknightsCommand, normalizeCommandText } from '../src/arknights-command.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── normalizeCommandText ─────────────────────────────────────────────────
assert('去掉 @提及', normalizeCommandText('@！？哦鲸鲸？！ 帮我做明日方舟日活') === '帮我做明日方舟日活');
assert('去掉所有空白', normalizeCommandText('  帮我 做 明日方舟 日活 ') === '帮我做明日方舟日活');
assert('去掉句末标点', normalizeCommandText('帮我做明日方舟日活！！') === '帮我做明日方舟日活');
assert('去掉全角空格', normalizeCommandText('帮我做\u3000明日方舟日活') === '帮我做明日方舟日活');
assert('空输入安全', normalizeCommandText(null) === '');

// ── isArknightsCommand：只认那一句 ───────────────────────────────────────
const P = '帮我做明日方舟日活';
assert('@机器人 + 原句 → 触发', isArknightsCommand('@！？哦鲸鲸？！ 帮我做明日方舟日活', P) === true);
assert('带句末感叹号 → 触发', isArknightsCommand('帮我做明日方舟日活！', P) === true);
assert('引用消息里的原句 → 触发（引用原文不参与判定，这里模拟纯正文）', isArknightsCommand('帮我做明日方舟日活', P) === true);
assert('少一个字 → 不触发', isArknightsCommand('帮我做方舟日活', P) === false);
assert('多一个字 → 不触发', isArknightsCommand('帮我做一下明日方舟日活', P) === false);
assert('包含关系不算（前后有别的字）→ 不触发', isArknightsCommand('你现在帮我做明日方舟日活吧', P) === false);
assert('换说法 → 不触发', isArknightsCommand('帮我刷个方舟', P) === false);
assert('同义英文 → 不触发', isArknightsCommand('do arknights daily', P) === false);
assert('空消息 → 不触发', isArknightsCommand('', P) === false && isArknightsCommand('   ', P) === false);
assert('命令本身为空 → 一律不触发（防配置写错把一切都当命令）', isArknightsCommand('帮我做明日方舟日活', '') === false);
assert('@全体成员 也会被剥掉', isArknightsCommand('@全体成员 帮我做明日方舟日活', P) === true);

// ── describeJob ─────────────────────────────────────────────────────────
const now = 1750000000000;
const running = describeJob({ startedAt: now - 5 * 60000 }, now);
assert('进行中 → running + 已 X 分钟', running.state === 'running' && running.text.includes('5 分钟'), JSON.stringify(running));
const done = describeJob({ startedAt: now - 12 * 60000, finishedAt: now - 60000, ok: true, reason: 'MAA 报告 AllTasksCompleted' }, now);
assert('刚成功 → done', done.state === 'done' && done.text.includes('成功'), JSON.stringify(done));
const failedJob = describeJob({ startedAt: now - 3 * 60000, finishedAt: now - 60000, ok: false, reason: 'MAA 已退出，但日志里没看到 AllTasksCompleted' }, now);
assert('刚失败 → failed 且带原因', failedJob.state === 'failed' && failedJob.text.includes('没看到 AllTasksCompleted'), JSON.stringify(failedJob));
assert('很久以前的结果不再提示', describeJob({ startedAt: now - 3 * 3600000, finishedAt: now - 2 * 3600000, ok: true }, now).text === '');
const stale = describeJob({ startedAt: now - 45 * 60000 }, now, { timeoutSec: 1800 });
assert('状态文件停在 45 分钟前 → stale（异常中断）', stale.state === 'stale', JSON.stringify(stale));
assert('没有状态 → null', describeJob(null, now) === null && describeJob({}, now) === null);

// ── 部分完成（跑了但有任务失败）的措辞：一眼看出成功几个、失败的是哪个 ──
const partialReport = formatArknightsReport({ ok: false, partial: true, startedAt: 0, finishedAt: 900000, successCount: 5, failedCount: 1, failedNames: ['DijiangRewards'], closedClient: true });
assert('部分完成 → "基本跑完 ⚠️" + 成功/失败数 + 失败任务名',
  partialReport.includes('基本跑完') && partialReport.includes('成功 5') && partialReport.includes('失败 1') && partialReport.includes('DijiangRewards') && partialReport.includes('客户端已关闭'), partialReport);

console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
