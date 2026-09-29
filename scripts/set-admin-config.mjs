// 配置群管理：开关干跑、设置干跑截止时间、禁言播报模板、白名单等（离线改，需重启桥接生效）。
//
// 用法：
//   node scripts/set-admin-config.mjs --show
//   node scripts/set-admin-config.mjs --dryrun 24h        # 干跑到 24 小时后自动生效（0=一直干跑，off=立刻生效）
//   node scripts/set-admin-config.mjs --mute-target 200000003 1   # （仅记录）真测目标与时长，供人工参考
//   node scripts/set-admin-config.mjs --announce in|off   # 禁言时是否在群里说一句（按人设模板）
//   node scripts/set-admin-config.mjs --add-whitelist 123,456
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'config.json');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}
function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

const args = process.argv.slice(2);
const cfg = readJson(FILE);
cfg.socialV2 = cfg.socialV2 ?? {};
cfg.socialV2.admin = cfg.socialV2.admin ?? {};

const show = () => {
  const a = cfg.socialV2.admin;
  const until = Number(a.dryRunUntil) || 0;
  console.log('群管理配置：');
  console.log(JSON.stringify({
    enabled: a.enabled !== false,
    dryRun: a.dryRun !== false,
    dryRunUntil: until ? new Date(until).toLocaleString('zh-CN') : '(未设置=一直干跑)',
    剩余: until ? `${Math.max(0, Math.round((until - Date.now()) / 3600000))} 小时` : '-',
    announceInGroup: a.announceInGroup === true,
    whitelist: a.whitelist ?? [],
    spam: a.spam, attack: { enabled: a.attack?.enabled, count: a.attack?.count }, mute: a.mute, limits: a.limits,
    announcement: a.announcement
  }, null, 2));
};

if (!args.length || args.includes('--show')) { show(); process.exit(0); }

if (args.includes('--dryrun')) {
  const v = String(args[args.indexOf('--dryrun') + 1] ?? '').trim().toLowerCase();
  if (v === 'off') {
    cfg.socialV2.admin.dryRun = false;
    cfg.socialV2.admin.dryRunUntil = 0;
    console.log('已设为：立刻生效（dryRun=false）');
  } else if (v === '0' || v === 'forever' || v === '') {
    cfg.socialV2.admin.dryRun = true;
    cfg.socialV2.admin.dryRunUntil = 0;
    console.log('已设为：一直干跑（dryRun=true，无截止时间）');
  } else {
    const m = /^(\d+)\s*(h|小时|m|分钟)?$/.exec(v);
    if (!m) { console.error('用法：--dryrun 24h | 30m | off | 0'); process.exit(1); }
    const n = Number(m[1]);
    const ms = (m[2] === 'm' || m[2] === '分钟') ? n * 60000 : n * 3600000;
    cfg.socialV2.admin.dryRun = true;
    cfg.socialV2.admin.dryRunUntil = Date.now() + ms;
    console.log(`已设为：干跑到 ${new Date(cfg.socialV2.admin.dryRunUntil).toLocaleString('zh-CN')} 自动生效`);
  }
}

if (args.includes('--announce')) {
  const v = String(args[args.indexOf('--announce') + 1] ?? '').toLowerCase();
  cfg.socialV2.admin.announceInGroup = v === 'in' || v === 'on' || v === 'true';
  console.log('禁言时群内播报：', cfg.socialV2.admin.announceInGroup ? '开（按人设模板随机一句）' : '关（静默执行）');
}

if (args.includes('--add-whitelist')) {
  const ids = String(args[args.indexOf('--add-whitelist') + 1] ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const cur = new Set((cfg.socialV2.admin.whitelist ?? []).map(String));
  for (const id of ids) cur.add(id);
  cfg.socialV2.admin.whitelist = [...cur];
  console.log('豁免白名单：', cfg.socialV2.admin.whitelist.join(', ') || '(空)');
}

atomicWriteJson(FILE, cfg);
console.log('');
show();
