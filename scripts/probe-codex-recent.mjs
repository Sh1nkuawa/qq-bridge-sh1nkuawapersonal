// 看 codex 日志库里最近 N 分钟的记录（判断 codex exec 卡在哪一步）
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const minutes = Number(process.argv[2] || 15);
const db = new DatabaseSync(path.join(os.homedir(), '.codex', 'logs_2.sqlite'), { readOnly: true });
const since = Math.floor(Date.now() / 1000) - minutes * 60;
const rows = db.prepare('select ts, level, target, feedback_log_body from logs where ts >= ? order by ts asc').all(since);
console.log(`最近 ${minutes} 分钟共 ${rows.length} 条 codex 日志：\n`);
for (const r of rows) {
  const t = new Date(r.ts * 1000).toLocaleTimeString('sv');
  console.log(`[${t}] ${String(r.level).padEnd(5)} ${r.target} :: ${String(r.feedback_log_body).slice(0, 260)}`);
}
db.close();
