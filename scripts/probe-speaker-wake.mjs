// 只读排查：AI 什么时候给谁设过「指定成员唤醒」(triggers.speakerIds)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = fs.readFileSync(path.join(ROOT, 'state', 'tool-calls.jsonl'), 'utf8').split('\n').filter(Boolean);
const names = { 200000001: '群友A', 200000002: '群友B', 100000001: 'owner(你)', 200000009: '群友I', 200000008: '群友G' };

function parseTime(v) {
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
}

const rows = [];
for (const l of lines) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  const name = String(j.name || j.tool || '');
  if (!name.includes('set_wake_config')) continue;
  const body = typeof j.args === 'string' ? j.args : JSON.stringify(j.args || {});
  const m = /"speakerIds":\s*\[([^\]]*)\]/.exec(body);
  rows.push({ at: parseTime(j.at ?? j.time ?? j.ts ?? j.timestamp), ids: m ? m[1].replace(/"/g, '') : null });
}
rows.sort((a, b) => a.at - b.at);
console.log(`set_wake_config 调用总数 ${rows.length}，其中带「指定成员」 ${rows.filter((r) => r.ids).length} 次：\n`);
let last = '';
for (const r of rows) {
  if (r.ids === null) continue;
  const label = r.ids.split(',').map((id) => `${id}(${names[id] ?? '?'})`).join('、');
  const changed = label === last ? '' : '   ← 换人了';
  last = label;
  console.log(new Date(r.at).toLocaleString('zh-CN'), '→', label + changed);
}
