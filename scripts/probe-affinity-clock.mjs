// probe-affinity-clock.mjs —— 检查好感度数据里的**时间字段是否错位**（排查"分数不涨/不衰减"用）
//
// 用途
//   好感度的加减分和衰减都依赖时间戳（lastInteractAt / lastScoreAt / dailyDate）。
//   一旦时间字段跑到未来（例如机器时钟被改、state 被别的进程写脏、测试注入了假时间），
//   表现会非常迷惑：分数卡住不动、dailyDelta 永远是 0、或者"今天"这个日期跟现实不符。
//   这个探针把每个人的时间字段打出来，并对"未来时间"直接标警，用于一眼分辨：
//     · 是**真没互动**（时间都是过去、就是没人说话）
//     · 还是**时间错位**（出现未来时间 / dailyDate 不是今天）
//
// 用法
//   node scripts/probe-affinity-clock.mjs              # 默认 group:123456789
//   node scripts/probe-affinity-clock.mjs group:123456
//
// 输出
//   现在 / 本地时区（先确认脚本所在进程的时区与系统一致）
//   每个人的：分数、dailyDate（记分归属日）、dailyDelta（当日净变动）、
//             最近互动（lastInteractAt）、最近加分（lastScoreAt），超出当前时间 60s 以上标 ⚠
//   末尾：dailyDate 的分布、有几个成员带未来时间戳。
//
// 说明
//   · **只读**，不修数据；判定为错位后由人决定怎么处理（重置时间字段 / 校正时钟）。
//   · 与 list-affinity.mjs 的分工：那个看"分数排名"，这个看"时间基准对不对"。
//   · 2026-10-05 实测：曾误以为时间戳跑到未来，实际是那次对话跨了 6 天（会话空闲后恢复），
//     所以脚本会同时打印"现在"，避免把"我记错了日期"误判成数据损坏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const key = process.argv[2] || 'group:123456789';
const ms = st.conversations?.[key]?.affinity?.members ?? {};
const now = Date.now();
const f = (t) => (t ? new Date(Number(t)).toLocaleString('zh-CN', { hour12: false }) : '-');

console.log('现在      : ' + f(now));
console.log('本地时区  : ' + Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log('');
for (const [id, m] of Object.entries(ms).sort((a, b) => b[1].score - a[1].score)) {
  const fut = Number(m.lastInteractAt) > now + 60000 ? '  ⚠ 未来时间' : '';
  console.log(`${String(m.name || id).slice(0, 14).padEnd(16)} score=${String(m.score).padStart(3)}`
    + `  dailyDate=${m.dailyDate}  dailyDelta=${String(m.dailyDelta).padStart(2)}`
    + `  最近互动=${f(m.lastInteractAt)}  最近加分=${f(m.lastScoreAt)}${fut}`);
}
const days = {};
for (const m of Object.values(ms)) days[m.dailyDate] = (days[m.dailyDate] || 0) + 1;
console.log('\ndailyDate 分布: ' + JSON.stringify(days));
const futCount = Object.values(ms).filter((m) => Number(m.lastInteractAt) > now + 60000).length;
console.log(`未来时间戳的成员: ${futCount} / ${Object.keys(ms).length}`);
