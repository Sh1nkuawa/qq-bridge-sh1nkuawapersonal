// 只读：打印 dsh-meme 图库索引结构与样例（排查用）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'node_modules', 'dsh-meme', 'memes');
const packs = process.argv[3] ? [process.argv[3]] : fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, 'index.db')));

for (const pack of packs) {
  const dir = path.join(root, pack);
  const manifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; } })();
  console.log(`\n=== ${pack} ===`);
  console.log('manifest:', manifest ? JSON.stringify(manifest).slice(0, 400) : '（无）');
  const db = new DatabaseSync(path.join(dir, 'index.db'), { readOnly: true });
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
  console.log('表:', tables.join(', '));
  const cols = db.prepare('pragma table_info(memes)').all().map((c) => c.name);
  console.log('列:', cols.join(', '));
  const rows = db.prepare('select * from memes limit 5').all();
  console.log('样例:', JSON.stringify(rows, null, 1));
  console.log('总数:', db.prepare('select count(*) n from memes').get().n);
  console.log('按 tag:', db.prepare('select tag, count(*) n from memes group by tag order by n desc').all().map((r) => `${r.tag}:${r.n}`).join(' '));
  console.log('扩展名:', [...new Set(db.prepare('select path from memes').all().map((r) => path.extname(r.path).toLowerCase()))].join(' '));
  db.close();
}
