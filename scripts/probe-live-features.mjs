// 升级后的「活体功能自检」：只读地打桥接控制台的各个本地特性端点，确认它们在 0.1.7 上仍然活着。
// 不发送任何 QQ 消息（发送类端点只在显式传 --send 时才调用）。
//
// 用法：node scripts/probe-live-features.mjs [会话key]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const PORT = Number(cfg.consolePort) || 3100;
const TOKEN = cfg.consoleToken || (() => { try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; } })();
const KEY = process.argv[2] || `group:${(cfg.allow?.groups ?? [])[0] ?? ''}`;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function ok(name, good, detail = '') {
  results.push(`${good ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${good ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'x-console-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

console.log(`桥接控制台: ${BASE}   会话 key: ${KEY}\n`);

// 1) 桥接总状态
try {
  const r = await req('GET', '/api/status');
  ok('桥接 /api/status', r.status === 200, `mode=${r.data?.mode} dsh=${r.data?.dshReady} qq=${r.data?.botNick ?? r.data?.nick ?? ''}`);
} catch (e) { ok('桥接 /api/status', false, e.message); }

// 2) 群管理状态（禁言能力 / 当前公告 / 待审草稿 / 干跑）
try {
  const r = await req('GET', `/api/socialV2/admin-status?key=${encodeURIComponent(KEY)}`);
  const d = r.data ?? {};
  ok('群管理 admin-status', r.status === 200 && d.ok !== false,
    `admin=${d.isAdmin ?? d.admin ?? '?'} 干跑=${d.dryRun ?? '?'} 公告=${(d.notice?.text ?? d.noticeText ?? '').slice(0, 24) || '(空)'} 待审=${d.pending ? '有' : '无'}`);
} catch (e) { ok('群管理 admin-status', false, e.message); }

// 3) 群管理审计日志
try {
  const r = await req('GET', `/api/socialV2/moderation-log?key=${encodeURIComponent(KEY)}&limit=5`);
  ok('群管理 moderation-log', r.status === 200, `记录 ${(r.data?.records ?? r.data?.log ?? []).length} 条`);
} catch (e) { ok('群管理 moderation-log', false, e.message); }

// 4) 本地表情包库（dsh-meme 图库）
try {
  const r = await req('GET', '/api/socialV2/meme-probe');
  const packs = r.data?.packs ?? [];
  ok('本地表情包库 meme-probe', r.status === 200 && (r.data?.ok !== false),
    `包 ${packs.length} 个 / 图 ${r.data?.total ?? packs.reduce((n, p) => n + (p.rows?.length ?? p.count ?? 0), 0)} 张`);
} catch (e) { ok('本地表情包库 meme-probe', false, e.message); }

// 5) 表情包按情绪抽候选
try {
  const r = await req('GET', `/api/socialV2/meme-list?key=${encodeURIComponent(KEY)}&tag=happy&limit=5`);
  const cands = r.data?.candidates ?? [];
  ok('表情包 meme-list(happy)', r.status === 200 && cands.length > 0, `抽到 ${cands.length} 张，例：${cands[0]?.caption ?? '-'}`);
} catch (e) { ok('表情包 meme-list(happy)', false, e.message); }

// 6) 生图回执（人设口吻短句）
try {
  const r = await req('POST', '/api/socialV2/image-ack-preview', { key: KEY, senderName: '验收测试', count: 3 });
  const samples = r.data?.samples ?? [];
  ok('生图回执 image-ack-preview', r.status === 200 && samples.length > 0, samples[0] ?? '');
} catch (e) { ok('生图回执 image-ack-preview', false, e.message); }

// 7) 当前群公告（发布链路是否读到）
try {
  const r = await req('GET', `/api/socialV2/announcement?key=${encodeURIComponent(KEY)}`);
  ok('群公告 announcement', r.status === 200 && r.data?.ok !== false, (r.data?.notice?.text ?? r.data?.text ?? '').slice(0, 30) || '(未读到)');
} catch (e) { ok('群公告 announcement', false, e.message); }

// 8) 关系（好感度）面板是否还在注入提示词
try {
  const r = await req('GET', `/api/socialV2/affinity?key=${encodeURIComponent(KEY)}`);
  const members = r.data?.members ?? r.data?.brief ?? [];
  ok('关系档 affinity', r.status === 200 && r.data?.ok !== false, `成员 ${Array.isArray(members) ? members.length : Object.keys(members).length} 人`);
} catch (e) { ok('关系档 affinity', false, e.message); }

// 9) 语音（应当处于关闭状态：默认不给 AI 发语音）
try {
  const r = await req('GET', `/api/socialV2/voices?key=${encodeURIComponent(KEY)}&probe=0`);
  ok('语音库（预期：AI 通道关闭）', r.status === 200 || r.status === 403,
    `HTTP ${r.status} ${r.data?.error ?? ''} 文件 ${(r.data?.items ?? []).length}`.trim());
} catch (e) { ok('语音库（预期：AI 通道关闭）', false, e.message); }

const bad = results.filter((r) => r.startsWith('❌'));
console.log(`\n=== ${results.length - bad.length}/${results.length} 项通过 ===`);
process.exit(bad.length ? 1 : 0);
