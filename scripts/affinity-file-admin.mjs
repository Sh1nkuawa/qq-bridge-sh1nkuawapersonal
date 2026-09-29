// 离线改好感度：直接改 state/social-v2.json（桥接没开时用；开着会被内存覆盖，请停桥上用或改用 HTTP 接口）
//
// 用法：
//   node scripts/affinity-file-admin.mjs show
//   node scripts/affinity-file-admin.mjs reset                  # 全部重置回起始分（默认 40，含清空今日额度/计数器/事件）
//   node scripts/affinity-file-admin.mjs set <QQ> <分数> [名字]
//   node scripts/affinity-file-admin.mjs reset --owner <QQ> 100 # 先全部重置，再把 owner 设为 100
//
// 写盘格式与桥接的 atomicWriteJson 完全一致（JSON.stringify(obj, null, 2) + '\n'，UTF-8 无 BOM）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'state', 'social-v2.json');
const KEY = process.env.QQ_GROUP ? `group:${process.env.QQ_GROUP}` : 'group:123456789'; // 真实群号用 QQ_GROUP=xxx 传入

function loadJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

const cfg = loadJson(path.join(ROOT, 'config.json'));
const affinityCfg = { start: 40, min: -200, max: 1000, ...(cfg?.socialV2?.affinity ?? {}) };
const state = loadJson(STATE_FILE);
const conv = state?.conversations?.[KEY];
if (!conv) { console.error(`state 里没有会话 ${KEY}`); process.exit(1); }
if (!conv.affinity || typeof conv.affinity !== 'object') conv.affinity = { members: {}, updatedAt: 0 };
if (!conv.affinity.members || typeof conv.affinity.members !== 'object') conv.affinity.members = {};
const members = conv.affinity.members;

const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

function reset(m) {
  m.score = Number(affinityCfg.start);
  m.counters = {};
  m.dailyDelta = 0;
  m.dailyDate = today;
  m.lastScoreAt = Date.now();
  m.events = [{ at: Date.now(), kind: 'reset', delta: 0, reasons: `离线重置回 ${affinityCfg.start}` }];
}

function table() {
  const rows = Object.entries(members)
    .map(([id, m]) => ({ id, name: m.name || id, score: m.score, daily: m.dailyDelta ?? 0, last: m.lastInteractAt || 0 }))
    .sort((a, b) => b.score - a.score);
  console.log(`范围 ${affinityCfg.min}~${affinityCfg.max}，起始 ${affinityCfg.start}；共 ${rows.length} 人：`);
  for (const r of rows) {
    const tier = r.score >= 300 ? '自己人' : r.score >= 100 ? '熟人' : r.score >= 40 ? '普通群友' : r.score >= 0 ? '眼熟' : r.score > -50 ? '有点烦' : '梁子';
    console.log(`  ${String(r.score).padStart(5)}  ${tier.padEnd(4)}  今日${r.daily >= 0 ? '+' : ''}${r.daily}  ${r.name}(${r.id})`);
  }
}

const [action, ...rest] = process.argv.slice(2);

if (!action || action === 'show') {
  table();
  process.exit(0);
}

if (action === 'reset') {
  const ownerIdx = rest.indexOf('--owner');
  const resetCount = Object.keys(members).length;
  for (const m of Object.values(members)) reset(m);
  console.log(`已重置 ${resetCount} 人 → ${affinityCfg.start}（今日额度与计数器已清空）`);
  if (ownerIdx >= 0) {
    const ownerId = String(rest[ownerIdx + 1] ?? '').trim();
    const ownerScore = Number(rest[ownerIdx + 2]);
    if (!/^\d+$/.test(ownerId) || !Number.isFinite(ownerScore)) { console.error('--owner 需要 <QQ> <分数>'); process.exit(1); }
    if (!members[ownerId]) { console.error(`state 里没有 ${ownerId} 这个成员（先让他在群里说句话，或用 set 建）`); process.exit(1); }
    members[ownerId].score = Math.max(affinityCfg.min, Math.min(affinityCfg.max, Math.round(ownerScore)));
    members[ownerId].events.push({ at: Date.now(), kind: 'manual', delta: 0, reasons: `离线手调为 ${members[ownerId].score}` });
    console.log(`owner ${members[ownerId].name || ownerId} → ${members[ownerId].score}`);
  }
  conv.affinity.updatedAt = Date.now();
  atomicWriteJson(STATE_FILE, state);
  console.log('');
  table();
  process.exit(0);
}

if (action === 'set') {
  const [id, score, name] = rest;
  if (!/^\d+$/.test(String(id ?? '')) || !Number.isFinite(Number(score))) { console.error('用法：set <QQ> <分数> [名字]'); process.exit(1); }
  if (!members[id]) members[id] = { userId: String(id), name: String(name ?? ''), score: 0, counters: {}, dailyDelta: 0, dailyDate: today, lastInteractAt: 0, lastScoreAt: 0, events: [], nickname: '' };
  if (name) members[id].name = String(name);
  members[id].score = Math.max(affinityCfg.min, Math.min(affinityCfg.max, Math.round(Number(score))));
  members[id].events.push({ at: Date.now(), kind: 'manual', delta: 0, reasons: `离线手调为 ${members[id].score}` });
  conv.affinity.updatedAt = Date.now();
  atomicWriteJson(STATE_FILE, state);
  console.log(`已设置 ${members[id].name || id} → ${members[id].score}`);
  table();
  process.exit(0);
}

console.log('用法：show | reset [--owner <QQ> <分数>] | set <QQ> <分数> [名字]');
