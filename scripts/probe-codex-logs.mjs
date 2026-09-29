// 一次性排查脚本：看 codex CLI 自己的日志库里最近发生了什么
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const dir = path.join(os.homedir(), '.codex');
for (const name of ['logs_2.sqlite', 'state_5.sqlite', 'thread_history_1.sqlite']) {
  const f = path.join(dir, name);
  console.log(`\n================ ${name} ================`);
  let db;
  try {
    db = new DatabaseSync(f, { readOnly: true });
  } catch (error) {
    console.log('  打开失败:', error.message);
    continue;
  }
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((t) => t.name);
  console.log('  表:', tables.join(', '));
  for (const t of tables) {
    let cols;
    try {
      cols = Object.keys(db.prepare(`select * from "${t}" limit 1`).all()[0] ?? {});
    } catch { continue; }
    const n = db.prepare(`select count(*) as c from "${t}"`).all()[0]?.c ?? 0;
    console.log(`  -- ${t} (${n} 行) 字段: ${cols.join(', ')}`);
    // 时间字段排序，取最后 5 行
    const timeCol = cols.find((c) => /time|ts|created|at$/i.test(c));
    if (!n || !timeCol) continue;
    try {
      const rows = db.prepare(`select * from "${t}" order by "${timeCol}" desc limit 5`).all();
      for (const r of rows) {
        const line = JSON.stringify(r).slice(0, 400);
        console.log(`     ${line}`);
      }
    } catch (error) { console.log('     读取失败:', error.message); }
  }
  db.close();
}
