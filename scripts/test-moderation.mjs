// moderation.js 单元测试：检测规则 / 时长阶梯 / 豁免 / 限流 / 公告校验 / 动作白名单。
// 运行：node scripts/test-moderation.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_ACTIONS,
  FORBIDDEN_ACTIONS,
  DEFAULT_ADMIN_CFG,
  mergeAdminConfig,
  assertAllowedAction,
  shouldAnnounceDryRunExpiry,
  normalizeTextForFingerprint,
  mediaFingerprint,
  messageMediaFingerprints,
  detectRepeat,
  detectAttack,
  countRecentMutes,
  planMuteSeconds,
  canMuteTarget,
  checkMuteLimits,
  validateAnnouncement,
  summarizeNoticeDiff,
  emptyModerationLog,
  loadModerationLog,
  saveModerationLog,
  makeRecord,
  formatRecordLine,
  emptyPendingAnnouncement,
  loadPendingAnnouncement,
  savePendingAnnouncement,
  pendingExpired,
  parseApproval,
  buildMuteNotice,
  pickAnnounceLine,
  isDryRun,
  dryRunRemainingMs
} from '../src/moderation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let count = 0;
const ok = (label, fn) => { fn(); count++; console.log('  ok -', label); };

const NOW = Date.parse('2026-09-28T12:00:00+08:00');
const msg = (over = {}) => ({
  seq: over.seq ?? Math.floor(Math.random() * 1000),
  messageId: over.messageId ?? null,
  userId: over.userId ?? '1001',
  sender: over.sender ?? '甲',
  text: over.text ?? '',
  plain: over.plain ?? over.text ?? '',
  media: over.media ?? [],
  atSelf: over.atSelf === true,
  quoteTargetIsSelf: over.quoteTargetIsSelf === true,
  isSelf: over.isSelf === true,
  time: over.time ?? NOW
});

console.log('配置合并');
ok('默认值：默认干跑、默认开启', () => {
  const c = mergeAdminConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.dryRun, true, 'dryRun 默认必须是 true（先观察再动手）');
  assert.equal(c.attack.count, 3);
  assert.equal(c.spam.sameTextCount, 5);
});
ok('数值归一化与夹取', () => {
  const c = mergeAdminConfig({ mute: { minSec: 30, maxSec: 5000, stepSec: -10 }, attack: { count: 1 }, spam: { sameTextCount: 99 } });
  assert.equal(c.mute.minSec, 60, 'minSec 不能低于 60');
  assert.equal(c.mute.maxSec, 600, 'maxSec 不能高于 600（不许超过 10 分钟）');
  assert.equal(c.mute.stepSec, 0, '负值夹到 0');
  assert.equal(c.attack.count, 2, '攻击阈值至少 2 条');
  assert.equal(c.spam.sameTextCount, 20, '重复阈值上限 20');
  assert.deepEqual(c.whitelist, []);
  assert.deepEqual(c.groupIds, []);
});
ok('布尔字段只有显式 true/false 才算数', () => {
  const c = mergeAdminConfig({ dryRun: false, announceInGroup: 'yes', notifyOwner: 0 });
  assert.equal(c.dryRun, false);
  assert.equal(c.announceInGroup, false, '字符串 "yes" 不算开启');
  assert.equal(c.notifyOwner, true, 'notifyOwner 只在显式 false 时关闭');
});
ok('关键词列表过滤空值', () => {
  const c = mergeAdminConfig({ attack: { keywords: ['  骂人 ', '', '   '] } });
  assert.deepEqual(c.attack.keywords, ['骂人']);
});

console.log('动作白名单（硬边界）');
ok('允许的两个动作', () => {
  assert.equal(assertAllowedAction(ADMIN_ACTIONS.mute), 'set_group_ban');
  assert.equal(assertAllowedAction(ADMIN_ACTIONS.noticePublish), '_send_group_notice');
  assert.equal(assertAllowedAction(ADMIN_ACTIONS.noticeList), '_get_group_notice');
});
ok('踢人 / 全员禁言 / 设管理员 / 退群 一律拒绝', () => {
  for (const a of ['set_group_kick', 'set_group_kick_members', 'set_group_whole_ban', 'set_group_admin', 'set_group_leave', 'set_group_card', 'set_group_name', '_del_group_notice']) {
    assert.throws(() => assertAllowedAction(a), /不在白名单内/, `${a} 必须被拒绝`);
  }
});
ok('群文件 / 群相册动作一律拒绝', () => {
  for (const a of ['upload_group_file', 'delete_group_file', 'upload_image_to_qun_album', 'del_group_album_media', 'get_group_album_list']) {
    assert.throws(() => assertAllowedAction(a), /不在白名单内/, `${a} 必须被拒绝`);
  }
});
ok('禁止动作清单覆盖 owner 点名的四类', () => {
  for (const a of ['set_group_kick', 'set_group_kick_members']) assert.ok(FORBIDDEN_ACTIONS.includes(a), `${a} 应在禁止清单`);
  assert.ok(FORBIDDEN_ACTIONS.some((a) => a.includes('album')), '群相册动作应在禁止清单');
  assert.ok(FORBIDDEN_ACTIONS.some((a) => a.includes('file')), '群文件动作应在禁止清单');
});

console.log('指纹');
ok('文本归一化：空格/标点/表情/大小写都不影响', () => {
  assert.equal(normalizeTextForFingerprint(' 你好，世界！！ '), normalizeTextForFingerprint('你好世界'));
  assert.equal(normalizeTextForFingerprint('ABC  def'), normalizeTextForFingerprint('abcdef'));
  assert.equal(normalizeTextForFingerprint('好耶😄'), normalizeTextForFingerprint('好耶'));
});
ok('图片指纹优先 file（QQ 图片 id）', () => {
  const fp = mediaFingerprint({ kind: 'image', file: 'CA78D7F92F024EF8A0DA879919A4774A.jpg', url: 'https://x/y?rkey=1' });
  assert.equal(fp, 'file:ca78d7f92f024ef8a0da879919a4774a.jpg');
});
ok('没有 file 时用去掉签名参数的 url', () => {
  const fp = mediaFingerprint({ kind: 'image', url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=abc' });
  assert.equal(fp, 'url:multimedia.nt.qq.com.cn/download');
});
ok('表情用 faceId', () => {
  assert.equal(mediaFingerprint({ kind: 'face', faceId: '123' }), 'face:123');
  assert.equal(mediaFingerprint({}), '');
});
ok('一条消息多图去重', () => {
  const ms = messageMediaFingerprints({ media: [{ kind: 'image', file: 'A.jpg' }, { kind: 'image', file: 'a.JPG' }, { kind: 'face', faceId: '9' }] });
  assert.deepEqual(ms, ['file:a.jpg', 'face:9']);
});

console.log('刷屏检测');
ok('同一句话 5 次 → 命中', () => {
  const r = detectRepeat(Array.from({ length: 5 }, (_, i) => msg({ text: '在吗', seq: i, messageId: String(i) })), { now: NOW });
  assert.equal(r.hit, true);
  assert.equal(r.kind, 'text');
  assert.equal(r.count, 5);
  assert.equal(r.senderId, '1001');
  assert.equal(r.evidence.length, 5);
});
ok('4 次不命中（阈值 5）', () => {
  assert.equal(detectRepeat(Array.from({ length: 4 }, () => msg({ text: '在吗' })), { now: NOW }).hit, false);
});
ok('标点/空格差异仍然算同一句', () => {
  const texts = ['在吗', '在吗？', '在 吗', '在吗!!', '在吗。'];
  assert.equal(detectRepeat(texts.map((t) => msg({ text: t })), { now: NOW }).hit, true);
});
ok('不同人各发 3 次不合并', () => {
  const rows = [...Array.from({ length: 3 }, () => msg({ text: '哈哈哈', userId: '1' })), ...Array.from({ length: 3 }, () => msg({ text: '哈哈哈', userId: '2' }))];
  assert.equal(detectRepeat(rows, { now: NOW }).hit, false);
});
ok('超出时间窗的不算', () => {
  const rows = Array.from({ length: 5 }, (_, i) => msg({ text: '刷屏', time: NOW - (i + 1) * 60000 }));
  assert.equal(detectRepeat(rows, { now: NOW, windowMs: 120000 }).hit, false, '都在 2 分钟窗外');
});
ok('同一张图 5 次 → 命中（含表情）', () => {
  const rows = Array.from({ length: 5 }, () => msg({ text: '[图片]', media: [{ kind: 'image', file: 'CA78D7F92F024EF8A0DA879919A4774A.jpg' }] }));
  const r = detectRepeat(rows, { now: NOW });
  assert.equal(r.hit, true);
  assert.equal(r.kind, 'image');
});
ok('自己发的不算（isSelf）', () => {
  const rows = Array.from({ length: 6 }, () => msg({ text: '喂喂喂', isSelf: true }));
  assert.equal(detectRepeat(rows, { now: NOW }).hit, false);
});
ok('阈值可配置', () => {
  const rows = Array.from({ length: 3 }, () => msg({ text: 'x' }));
  assert.equal(detectRepeat(rows, { now: NOW, textThreshold: 3 }).hit, true);
});

console.log('攻击检测');
ok('针对机器人的辱骂 3 条 → 命中', () => {
  const rows = [
    msg({ text: '@鲸鲸 你个傻逼', atSelf: true }),
    msg({ text: '闭嘴', atSelf: true }),
    msg({ text: '垃圾东西', quoteTargetIsSelf: true })
  ];
  const r = detectAttack(rows, { now: NOW });
  assert.equal(r.hit, true);
  assert.equal(r.kind, 'attack');
  assert.equal(r.count, 3);
  assert.ok(r.keywords.length >= 2);
});
ok('没针对机器人（只是群里对骂）→ 不命中', () => {
  const rows = [msg({ text: '你个傻逼', userId: '2002' }), msg({ text: '闭嘴', userId: '2002' }), msg({ text: '垃圾东西', userId: '2002' })];
  assert.equal(detectAttack(rows, { now: NOW }).hit, false, 'mustAddressBot 默认开启');
});
ok('关闭 mustAddressBot 后普通对骂也会命中（配置项可用）', () => {
  const rows = [msg({ text: '你个傻逼' }), msg({ text: '闭嘴' }), msg({ text: '垃圾东西' })];
  assert.equal(detectAttack(rows, { now: NOW, mustAddressBot: false }).hit, true);
});
ok('好感度雷点词（rudeKeywords）也算证据', () => {
  const rows = [msg({ text: '蓝色大肥鱼', atSelf: true }), msg({ text: '大肥鱼', atSelf: true }), msg({ text: '肥鱼', atSelf: true })];
  const r = detectAttack(rows, { now: NOW, rudeKeywords: ['大肥鱼', '肥鱼', '死鱼'] });
  assert.equal(r.hit, true);
});
ok('带名字但不带 @ 也算针对（selfNames）', () => {
  const rows = [msg({ text: '小鲸鱼你个傻逼' }), msg({ text: '小鲸鱼闭嘴' }), msg({ text: '小鲸鱼滚开' })];
  assert.equal(detectAttack(rows, { now: NOW, selfNames: ['小鲸鱼'] }).hit, true);
});
ok('可按 senderId 只核验某个人（模型提议用）', () => {
  const rows = [
    msg({ text: '傻逼', atSelf: true, userId: '1001' }),
    msg({ text: '闭嘴', atSelf: true, userId: '1001' }),
    msg({ text: '垃圾东西', atSelf: true, userId: '1001' })
  ];
  assert.equal(detectAttack(rows, { now: NOW, senderId: '1001' }).hit, true);
  assert.equal(detectAttack(rows, { now: NOW, senderId: '9999' }).hit, false);
});
ok('2 条不命中（阈值 3）', () => {
  const rows = [msg({ text: '傻逼', atSelf: true }), msg({ text: '闭嘴', atSelf: true })];
  assert.equal(detectAttack(rows, { now: NOW }).hit, false);
});

console.log('时长阶梯（1~10 分钟）');
ok('刷屏首次 3 分钟，逐次 +2，封顶 10 分钟', () => {
  const c = mergeAdminConfig();
  assert.equal(planMuteSeconds({ triggerKind: 'text-repeat', priorMutes24h: 0, cfg: c }).seconds, 180);
  assert.equal(planMuteSeconds({ triggerKind: 'text-repeat', priorMutes24h: 1, cfg: c }).seconds, 300);
  assert.equal(planMuteSeconds({ triggerKind: 'text-repeat', priorMutes24h: 2, cfg: c }).seconds, 420);
  assert.equal(planMuteSeconds({ triggerKind: 'text-repeat', priorMutes24h: 9, cfg: c }).seconds, 600, '不超过 600 秒');
});
ok('攻击首次 5 分钟起', () => {
  const c = mergeAdminConfig();
  assert.equal(planMuteSeconds({ triggerKind: 'attack', priorMutes24h: 0, cfg: c }).seconds, 300);
  assert.equal(planMuteSeconds({ triggerKind: 'attack', priorMutes24h: 2, cfg: c }).seconds, 540);
});
ok('配置改小上限也生效', () => {
  const c = mergeAdminConfig({ mute: { maxSec: 240 } });
  assert.equal(planMuteSeconds({ triggerKind: 'attack', priorMutes24h: 5, cfg: c }).seconds, 240);
});
ok('只统计真实禁言（干跑/失败不算）', () => {
  const rows = [
    makeRecord({ action: 'mute', userId: '1', at: NOW - 1000, seconds: 180 }),
    makeRecord({ action: 'mute', userId: '1', at: NOW - 2000, seconds: 180, dryRun: true }),
    makeRecord({ action: 'mute', userId: '1', at: NOW - 3000, seconds: 180, ok: false }),
    makeRecord({ action: 'mute', userId: '1', at: NOW - 30 * 3600000, seconds: 180 })
  ];
  assert.equal(countRecentMutes(rows, { groupId: '', userId: '1', now: NOW, windowHours: 24 }), 1);
});

console.log('豁免（谁能被禁言）');
const guardBase = { botRole: 'admin', botId: '100000002', ownerQQ: '100000001', groupOwnerId: '100000001', whitelist: [] };
ok('普通成员可禁言', () => {
  assert.equal(canMuteTarget({ ...guardBase, targetId: '555', targetRole: 'member' }).ok, true);
});
ok('群主/管理员/自己/白名单一律拒绝', () => {
  assert.equal(canMuteTarget({ ...guardBase, targetId: '100000001', targetRole: 'member' }).ok, false);
  assert.equal(canMuteTarget({ ...guardBase, targetId: '200000001', targetRole: 'admin' }).ok, false);
  assert.equal(canMuteTarget({ ...guardBase, targetId: '100000002', targetRole: 'member' }).ok, false);
  assert.equal(canMuteTarget({ ...guardBase, targetId: '777', targetRole: 'member', whitelist: ['777'] }).ok, false);
  assert.equal(canMuteTarget({ ...guardBase, targetId: '888', targetRole: 'owner' }).ok, false);
});
ok('机器人不是管理员时拒绝（当前真实状态）', () => {
  const r = canMuteTarget({ ...guardBase, botRole: 'member', targetId: '555', targetRole: 'member' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是管理员/);
});
ok('取不到目标身份时保守放弃', () => {
  assert.equal(canMuteTarget({ ...guardBase, targetId: '555', targetRole: '' }).ok, false);
});

console.log('限流');
ok('冷却期内拒绝', () => {
  const records = [makeRecord({ action: 'mute', userId: '555', at: NOW - 60000, seconds: 180 })];
  const c = mergeAdminConfig();
  const r = checkMuteLimits({ records, groupId: '', userId: '555', now: NOW, cfg: c });
  assert.equal(r.ok, false);
  assert.match(r.reason, /冷却/);
});
ok('还在禁言中拒绝', () => {
  const c = mergeAdminConfig();
  const r = checkMuteLimits({ records: [], mutedUntil: { ':555': NOW + 120000 }, groupId: '', userId: '555', now: NOW, cfg: c });
  assert.equal(r.ok, false);
  assert.match(r.reason, /还在禁言中/);
});
ok('每人每日上限', () => {
  const c = mergeAdminConfig();
  const records = [
    makeRecord({ action: 'mute', userId: '555', at: NOW - 3 * 3600000, seconds: 180 }),
    makeRecord({ action: 'mute', userId: '555', at: NOW - 2 * 3600000, seconds: 180 })
  ];
  const r = checkMuteLimits({ records, groupId: '', userId: '555', now: NOW, cfg: c });
  assert.equal(r.ok, false);
  assert.match(r.reason, /今天已被禁言 2 次/);
});
ok('全局每小时上限', () => {
  const c = mergeAdminConfig();
  const records = ['1', '2', '3'].map((id) => makeRecord({ action: 'mute', userId: id, at: NOW - 60000, seconds: 180 }));
  const r = checkMuteLimits({ records, groupId: '', userId: '9', now: NOW, cfg: c });
  assert.equal(r.ok, false);
  assert.match(r.reason, /本小时/);
});
ok('干净状态放行', () => {
  const c = mergeAdminConfig();
  assert.equal(checkMuteLimits({ records: [], groupId: '', userId: '9', now: NOW, cfg: c }).ok, true);
});

console.log('公告校验');
ok('正常公告通过并归一化', () => {
  const r = validateAnnouncement('  【更新】\n\n\n\n1. 新增表情包库   \n2. 修了搜索  ', mergeAdminConfig().announcement);
  assert.equal(r.ok, true);
  assert.equal(r.text, '【更新】\n\n1. 新增表情包库\n2. 修了搜索');
});
ok('空内容 / 超长 / @全体 / 链接 / 敏感特征被拒', () => {
  const cfg = mergeAdminConfig().announcement;
  assert.equal(validateAnnouncement('   ', cfg).ok, false);
  assert.equal(validateAnnouncement('x'.repeat(cfg.maxChars + 1), cfg).ok, false);
  assert.equal(validateAnnouncement('@全体成员 上线了新功能', cfg).ok, false);
  assert.equal(validateAnnouncement('详见 https://example.com/a', cfg).ok, false);
  assert.equal(validateAnnouncement('详见 example.com', cfg).ok, false);
  assert.equal(validateAnnouncement('key: api_key=abc', cfg).ok, false);
  assert.equal(validateAnnouncement('路径 C:\\Users\\x\\y', cfg).ok, false);
});
ok('显式打开 allowLinks 后链接放行', () => {
  const cfg = mergeAdminConfig({ announcement: { allowLinks: true } }).announcement;
  assert.equal(validateAnnouncement('详见 https://example.com/a', cfg).ok, true);
});
ok('QQ 服务端的长度上限也被卡住（字数 + 字节数）', () => {
  const cfg = mergeAdminConfig().announcement;
  assert.equal(cfg.maxChars, 600);
  assert.equal(cfg.maxBytes, 1400);
  assert.equal(validateAnnouncement('字'.repeat(460), cfg).ok, true, '460 字≈1380 字节，应通过');
  const r = validateAnnouncement('字'.repeat(480), cfg);
  assert.equal(r.ok, false, '480 字≈1440 字节，应被字节上限拒绝');
  assert.match(r.errors.join('；'), /字节/);
  assert.equal(validateAnnouncement('a'.repeat(601), cfg).ok, false, '超过 600 字也要拒');
});
ok('差异摘要', () => {
  assert.match(summarizeNoticeDiff('', '新公告'), /没有公告/);
  assert.match(summarizeNoticeDiff('一样', '一样'), /完全一致/);
  const d = summarizeNoticeDiff('旧内容\n共同行', '共同行\n新增行');
  assert.match(d, /新增 1 行/);
  assert.match(d, /移除 1 行/);
});

console.log('记录与待审状态');
ok('审计记录落盘 / 读回 / 截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-log-'));
  const file = path.join(dir, 'moderation.json');
  let log = emptyModerationLog();
  log.records.push(makeRecord({ action: 'mute', userId: '1', groupId: 'g', seconds: 180, trigger: 'text-repeat', count: 5, evidence: [{ text: '在吗' }] }));
  saveModerationLog(file, log, 500);
  const back = loadModerationLog(file);
  assert.equal(back.records.length, 1);
  assert.equal(back.records[0].seconds, 180);
  assert.equal(back.records[0].by, 'auto');
  for (let i = 0; i < 20; i++) log.records.push(makeRecord({ action: 'mute', userId: String(i) }));
  saveModerationLog(file, log, 10);
  assert.equal(loadModerationLog(file).records.length, 10, '超过上限只保留最近 N 条');
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('记录摘要可读', () => {
  const line = formatRecordLine(makeRecord({ action: 'mute', userId: '555', userName: '甲', seconds: 300, trigger: 'attack', count: 3, evidence: [{ text: '闭嘴' }] }));
  assert.match(line, /禁言/);
  assert.match(line, /5 分钟/);
  assert.match(line, /攻击机器人/);
  const dry = formatRecordLine(makeRecord({ action: 'mute', userId: '555', seconds: 180, dryRun: true, trigger: 'text-repeat', count: 5 }));
  assert.match(dry, /【干跑】/);
});
ok('待审公告落盘 / 读回 / 过期', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-pending-'));
  const file = path.join(dir, 'pending.json');
  assert.equal(loadPendingAnnouncement(file).pending, null);
  savePendingAnnouncement(file, { pending: { id: 'abc', content: '新公告', createdAt: NOW, source: 'model', groupId: 'g', status: 'pending' } });
  const back = loadPendingAnnouncement(file);
  assert.equal(back.pending.content, '新公告');
  const cfg = mergeAdminConfig();
  assert.equal(pendingExpired(back.pending, cfg, NOW + 1000), false);
  assert.equal(pendingExpired(back.pending, cfg, NOW + cfg.announcement.confirmTimeoutMs + 1), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('批准/拒绝词解析', () => {
  assert.equal(parseApproval('通过'), 'approve');
  assert.equal(parseApproval(' 同意 '), 'approve');
  assert.equal(parseApproval('拒绝'), 'reject');
  assert.equal(parseApproval('取消'), 'reject');
  assert.equal(parseApproval('再看看'), null);
});
ok('群内禁言提示模板', () => {
  assert.equal(buildMuteNotice(DEFAULT_ADMIN_CFG.announceTemplate, { name: '甲', minutes: 3 }), '@甲 刷屏了，先安静 3 分钟');
});
ok('干跑可以定时自动关闭（dryRunUntil）', () => {
  const base = mergeAdminConfig({ dryRun: true, dryRunUntil: NOW + 3600000 });
  assert.equal(isDryRun(base, NOW), true, '到点前是干跑');
  assert.equal(isDryRun(base, NOW + 3600001), false, '到点后自动生效');
  assert.equal(dryRunRemainingMs(base, NOW), 3600000);
  assert.equal(dryRunRemainingMs(base, NOW + 3600001), 0);
  const forever = mergeAdminConfig({ dryRun: true, dryRunUntil: 0 });
  assert.equal(isDryRun(forever, NOW + 999999999), true, '没设截止时间就一直干跑');
  assert.equal(dryRunRemainingMs(forever, NOW), -1);
  const off = mergeAdminConfig({ dryRun: false, dryRunUntil: NOW + 3600000 });
  assert.equal(isDryRun(off, NOW), false, '手动关掉就是生效，不看截止时间');
});
ok('按人设抽禁言播报（不骂人、带名字和分钟数）', () => {
  const c = mergeAdminConfig();
  const a = pickAnnounceLine(c, { name: '甲', minutes: 3, random: () => 0 });
  const b = pickAnnounceLine(c, { name: '乙', minutes: 5, kind: 'attack', random: () => 0.99 });
  assert.match(a, /甲/);
  assert.match(a, /3/);
  assert.match(b, /乙/);
  assert.match(b, /5/);
  assert.ok(!/傻|蠢|滚|闭嘴/.test(a), '刷屏播报不带脏字');
  const pool = new Set(Array.from({ length: 30 }, (_, i) => pickAnnounceLine(c, { name: '甲', minutes: 1, random: () => i / 30 })));
  assert.ok(pool.size >= 3, `模板池应该有多条可选（抽到 ${pool.size} 种）`);
});
ok('模板池留空时回落到内置模板池（不会说不出话）', () => {
  const c = mergeAdminConfig({ announceTemplates: [], announceTemplatesAttack: [], announceTemplate: 'X {name} {minutes}' });
  assert.deepEqual(c.announceTemplates, DEFAULT_ADMIN_CFG.announceTemplates, '空数组视为用默认池');
  const line = pickAnnounceLine(c, { name: '甲', minutes: 2, random: () => 0 });
  assert.match(line, /甲/);
  assert.match(line, /2/);
  // 直接喂一个空配置时，仍会回落到 announceTemplate
  const fallback = pickAnnounceLine({ announceTemplates: [], announceTemplatesAttack: [], announceTemplate: '' }, { name: '甲', minutes: 2, random: () => 0 });
  assert.equal(typeof fallback, 'string');
});

console.log('源码扫描：禁止动作不能出现在桥接/工具层');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const consoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
  const moderation = fs.readFileSync(path.join(ROOT, 'src', 'moderation.js'), 'utf8');
  const forbiddenCallPattern = FORBIDDEN_ACTIONS.map((a) => `'${a}'`);
  ok('bridge.js 里没有任何禁止动作', () => {
    for (const pat of forbiddenCallPattern) assert.ok(!bridge.includes(pat), `bridge.js 不该出现 ${pat}`);
  });
  ok('MCP 工具层里没有任何禁止动作', () => {
    for (const pat of forbiddenCallPattern) assert.ok(!mcp.includes(pat), `mcp-snowluma-safe.js 不该出现 ${pat}`);
  });
  ok('控制台里没有手动踢人/相册入口', () => {
    for (const pat of forbiddenCallPattern) assert.ok(!consoleHtml.includes(pat), `console.html 不该出现 ${pat}`);
  });
  ok('moderation.js 只把它们写在 FORBIDDEN_ACTIONS 清单里', () => {
    const start = moderation.indexOf('export const FORBIDDEN_ACTIONS');
    const end = moderation.indexOf('];', start);
    assert.ok(start > 0 && end > start, 'FORBIDDEN_ACTIONS 应存在');
    const outside = moderation.slice(0, start) + moderation.slice(end);
    for (const a of FORBIDDEN_ACTIONS) {
      assert.ok(!outside.includes(`'${a}'`), `${a} 出现在了 FORBIDDEN_ACTIONS 清单之外`);
      assert.ok(!new RegExp(`request\\(['"]${a}['"]`).test(moderation), `${a} 不该被真正调用`);
    }
  });
  ok('bridge.js 只通过 ADMIN_ACTIONS 调禁言/公告', () => {
    assert.ok(bridge.includes('ADMIN_ACTIONS.mute') || bridge.includes('assertAllowedAction'), 'bridge 必须走白名单出口');
  });

  // 2026-09-30 事故：干跑到期通知只用**内存**旗标去重，桥接一重启就忘 → 两天给 owner 发了 14 次
  ok('干跑到期通知按"已通知的截止时间"去重，且落盘（重启不再重发）', () => {
    const until = 1790678178213;
    assert.equal(shouldAnnounceDryRunExpiry({ dryRun: true, dryRunUntil: until }, 0, until + 1000), true, '到期且没通知过 → 该通知');
    assert.equal(shouldAnnounceDryRunExpiry({ dryRun: true, dryRunUntil: until }, until, until + 600000), false, '同一截止时间通知过 → 不再通知');
    assert.equal(shouldAnnounceDryRunExpiry({ dryRun: true, dryRunUntil: until }, until - 1, until - 1), false, '还没到点 → 不通知');
    assert.equal(shouldAnnounceDryRunExpiry({ dryRun: true, dryRunUntil: until + 3600000 }, until, until + 7200000), true, '用户设了更晚的新截止时间 → 再通知一次');
    assert.equal(shouldAnnounceDryRunExpiry({ dryRun: false, dryRunUntil: until }, 0, until + 1000), false, '不是干跑 → 不通知');
    assert.equal(shouldAnnounceDryRunExpiry({ dryRun: true, dryRunUntil: 0 }, 0, until), false, '干跑但没设截止时间 → 不通知');
    assert.ok(bridge.includes('shouldAnnounceDryRunExpiry(c, dryRunAnnouncedUntil)'), 'bridge 必须用这个判定');
    assert.ok(bridge.includes('admin-dryrun.json'), '已通知的截止时间必须落盘');
  });
}

console.log(`\n全部通过：${count} 项断言组`);
