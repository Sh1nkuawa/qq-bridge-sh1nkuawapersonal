// moderation.js —— 群管理（禁言 / 群公告）的**确定性内核**：纯函数 + 只读文件工具。
//
// 设计原则（与 owner 敲定）：
//   1) 只做两件事：禁言（set_group_ban）与发布群公告（_send_group_notice）。
//      **不许踢人、不许碰群相册/群文件、不许全员禁言、不许设管理员、不许退群**——
//      这些动作在本模块里根本没有封装，且 FORBIDDEN_ACTIONS 会被单测扫描（防止以后被误加）。
//   2) 判定全部确定性：同文本/同图重复 N 次、或针对机器人的辱骂累计 N 条。模型只能说"提议"，
//      提议也要在这里重新核验证据；核验不过一律拒绝。
//   3) 平台权限只是前提，不是保证：即使机器人是群主，也只能调用 ADMIN_ACTIONS 里的动作。
//   4) 一律可解释、可审计：每条记录带触发类型、证据片段、时长、是否 dryRun。
//   5) 豁免优先：owner / 群主 / 群管理员 / 机器人自己 / 白名单永不进入禁言候选。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_ANNOUNCE_TEMPLATES, DEFAULT_ANNOUNCE_TEMPLATES_ATTACK, pickTemplateLine } from './persona-lines.js';

// ── 允许调用的 QQ 动作（唯一出口）────────────────────────────────────────
export const ADMIN_ACTIONS = Object.freeze({
  mute: 'set_group_ban',            // 禁言（duration=0 解禁，仅 owner 手动）
  noticePublish: '_send_group_notice',
  noticeList: '_get_group_notice',
  memberInfo: 'get_group_member_info'
});

/** 明确禁止的动作：不封装、不调用；单测会扫描源码确保它们不出现。 */
export const FORBIDDEN_ACTIONS = Object.freeze([
  'set_group_kick',
  'set_group_kick_members',
  'set_group_whole_ban',
  'set_group_admin',
  'set_group_leave',
  'set_group_card',
  'set_group_name',
  'set_group_portrait',
  'set_group_anonymous',
  'set_group_anonymous_ban',
  'set_group_add_request',
  'set_group_special_title',
  '_del_group_notice',
  // 群文件
  'upload_group_file', 'delete_group_file', 'move_group_file', 'rename_group_file',
  'create_group_file_folder', 'delete_group_file_folder', 'rename_group_file_folder',
  'trans_group_file', 'delete_group_folder',
  // 群相册
  'get_group_album_list', 'get_group_album_media_list', 'upload_image_to_qun_album',
  'upload_video_to_qun_album', 'do_group_album_comment', 'set_group_album_media_like',
  'cancel_group_album_media_like', 'del_group_album_media'
]);

/** 任何群管理动作的唯一出口：不在白名单里直接抛错（fail-closed）。 */
export function assertAllowedAction(action) {
  const allowed = Object.values(ADMIN_ACTIONS);
  if (!allowed.includes(String(action))) {
    throw new Error(`群管理动作 "${action}" 不在白名单内，已拒绝（只允许：${allowed.join(' / ')}）`);
  }
  return String(action);
}

export const DEFAULT_ADMIN_CFG = {
  enabled: true,
  dryRun: true,                 // 干跑：只记录 + 通知 owner，不真的禁言
  groupIds: [],                 // 空 = 用 allow.groups
  spam: {
    enabled: true,
    sameTextCount: 5,           // 同一段文本重复次数阈值
    sameImageCount: 5,          // 同一张图重复次数阈值
    windowMs: 120000,
    minTextChars: 1
  },
  attack: {
    enabled: true,
    count: 3,                   // 针对机器人的辱骂条数阈值
    windowMs: 600000,
    mustAddressBot: true,       // 必须是 @机器人 / 引用机器人 / 带名字
    keywords: [
      '傻逼', '傻b', '煞笔', '智障', '弱智', '脑残', '废物', '垃圾东西', '狗东西',
      '妈的', '草你', '草泥马', '去死', '死开', '滚开', '闭嘴', '神经病', '没用的东西'
    ]
  },
  mute: {
    minSec: 60,
    maxSec: 600,
    spamBaseSec: 180,           // 刷屏首次 3 分钟
    attackBaseSec: 300,         // 攻击首次 5 分钟
    stepSec: 120,               // 24h 内每多一次 +2 分钟
    repeatWindowHours: 24,
    perMemberCooldownMs: 1800000,
    maxPerMemberPerDay: 2
  },
  limits: { maxPerHour: 3, maxPerDay: 10 },
  whitelist: [],                // 永不处理的 QQ
  announceInGroup: true,        // 禁言时在群里说一句（按人设，短、口语）
  announceTemplate: '@{name} 刷屏了，先安静 {minutes} 分钟',
  // 禁言后在群里说的话：随机抽一条，保持"人味"，不要像管理员通告（模板在 persona-lines.js）。
  announceTemplates: [...DEFAULT_ANNOUNCE_TEMPLATES],
  // 攻击机器人时用的那几句（语气硬一点，但仍然不骂人）
  announceTemplatesAttack: [...DEFAULT_ANNOUNCE_TEMPLATES_ATTACK],
  dryRunUntil: 0,               // 干跑截止时间戳（毫秒）；>0 时到点自动转为生效；0=不自动
  notifyOwner: true,
  maxRecords: 500,
  announcement: {
    enabled: true,
    // QQ 服务端对公告正文有硬限制：2026-09-28 实测 603 字被拒（ec=9 text length error），
    // 511 字（1365 字节）可以发布；原公告 502 字也是能发的。所以默认卡在 600 字 / 1400 字节以内。
    maxChars: 600,
    maxBytes: 1400,
    allowLinks: false,
    pinned: 1,
    // 发布时是否要求群成员"确认收到"：0=不要求（默认，避免全群被弹确认框），1=要求
    confirmRequired: 0,
    confirmTimeoutMs: 1800000,  // 30 分钟未批自动作废
    requireOwnerApproval: true
  }
};

function num(v, fallback, { min = -Infinity, max = Infinity, int = true } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.min(max, int ? Math.round(n) : n));
  return clamped;
}

export function mergeAdminConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    ...DEFAULT_ADMIN_CFG,
    ...src,
    spam: { ...DEFAULT_ADMIN_CFG.spam, ...(src.spam && typeof src.spam === 'object' ? src.spam : {}) },
    attack: { ...DEFAULT_ADMIN_CFG.attack, ...(src.attack && typeof src.attack === 'object' ? src.attack : {}) },
    mute: { ...DEFAULT_ADMIN_CFG.mute, ...(src.mute && typeof src.mute === 'object' ? src.mute : {}) },
    limits: { ...DEFAULT_ADMIN_CFG.limits, ...(src.limits && typeof src.limits === 'object' ? src.limits : {}) },
    announcement: { ...DEFAULT_ADMIN_CFG.announcement, ...(src.announcement && typeof src.announcement === 'object' ? src.announcement : {}) }
  };
  out.enabled = out.enabled !== false;
  out.dryRun = out.dryRun !== false;
  out.notifyOwner = out.notifyOwner !== false;
  out.announceInGroup = out.announceInGroup === true;
  out.spam.enabled = out.spam.enabled !== false;
  out.attack.enabled = out.attack.enabled !== false;
  out.announcement.enabled = out.announcement.enabled !== false;
  out.announcement.requireOwnerApproval = out.announcement.requireOwnerApproval !== false;
  out.spam.sameTextCount = num(out.spam.sameTextCount, DEFAULT_ADMIN_CFG.spam.sameTextCount, { min: 2, max: 20 });
  out.spam.sameImageCount = num(out.spam.sameImageCount, DEFAULT_ADMIN_CFG.spam.sameImageCount, { min: 2, max: 20 });
  out.spam.windowMs = num(out.spam.windowMs, DEFAULT_ADMIN_CFG.spam.windowMs, { min: 10000, max: 3600000 });
  out.spam.minTextChars = num(out.spam.minTextChars, DEFAULT_ADMIN_CFG.spam.minTextChars, { min: 0, max: 50 });
  out.attack.count = num(out.attack.count, DEFAULT_ADMIN_CFG.attack.count, { min: 2, max: 50 });
  out.attack.windowMs = num(out.attack.windowMs, DEFAULT_ADMIN_CFG.attack.windowMs, { min: 10000, max: 86400000 });
  out.mute.minSec = num(out.mute.minSec, DEFAULT_ADMIN_CFG.mute.minSec, { min: 60, max: 600 });
  out.mute.maxSec = num(out.mute.maxSec, DEFAULT_ADMIN_CFG.mute.maxSec, { min: 60, max: 600 });
  if (out.mute.maxSec < out.mute.minSec) out.mute.maxSec = out.mute.minSec;
  out.mute.spamBaseSec = num(out.mute.spamBaseSec, DEFAULT_ADMIN_CFG.mute.spamBaseSec, { min: 60, max: 600 });
  out.mute.attackBaseSec = num(out.mute.attackBaseSec, DEFAULT_ADMIN_CFG.mute.attackBaseSec, { min: 60, max: 600 });
  out.mute.stepSec = num(out.mute.stepSec, DEFAULT_ADMIN_CFG.mute.stepSec, { min: 0, max: 600 });
  out.mute.repeatWindowHours = num(out.mute.repeatWindowHours, DEFAULT_ADMIN_CFG.mute.repeatWindowHours, { min: 1, max: 168 });
  out.mute.perMemberCooldownMs = num(out.mute.perMemberCooldownMs, DEFAULT_ADMIN_CFG.mute.perMemberCooldownMs, { min: 0, max: 86400000 });
  out.mute.maxPerMemberPerDay = num(out.mute.maxPerMemberPerDay, DEFAULT_ADMIN_CFG.mute.maxPerMemberPerDay, { min: 1, max: 20 });
  out.limits.maxPerHour = num(out.limits.maxPerHour, DEFAULT_ADMIN_CFG.limits.maxPerHour, { min: 0, max: 60 });
  out.limits.maxPerDay = num(out.limits.maxPerDay, DEFAULT_ADMIN_CFG.limits.maxPerDay, { min: 0, max: 200 });
  out.announcement.maxChars = num(out.announcement.maxChars, DEFAULT_ADMIN_CFG.announcement.maxChars, { min: 50, max: 20000 });
  out.announcement.maxBytes = num(out.announcement.maxBytes, DEFAULT_ADMIN_CFG.announcement.maxBytes, { min: 100, max: 60000 });
  out.announcement.pinned = num(out.announcement.pinned, 1, { min: 0, max: 1 });
  out.announcement.confirmRequired = num(out.announcement.confirmRequired, 0, { min: 0, max: 1 });
  out.announcement.confirmTimeoutMs = num(out.announcement.confirmTimeoutMs, DEFAULT_ADMIN_CFG.announcement.confirmTimeoutMs, { min: 60000, max: 86400000 });
  out.whitelist = (Array.isArray(out.whitelist) ? out.whitelist : []).map((x) => String(x).trim()).filter(Boolean);
  out.groupIds = (Array.isArray(out.groupIds) ? out.groupIds : []).map((x) => String(x).trim()).filter(Boolean);
  out.attack.keywords = (Array.isArray(out.attack.keywords) ? out.attack.keywords : DEFAULT_ADMIN_CFG.attack.keywords)
    .map((x) => String(x).trim()).filter(Boolean);
  out.announceTemplate = String(out.announceTemplate ?? DEFAULT_ADMIN_CFG.announceTemplate);
  out.announceTemplates = (Array.isArray(out.announceTemplates) && out.announceTemplates.length ? out.announceTemplates : DEFAULT_ADMIN_CFG.announceTemplates)
    .map((x) => String(x)).filter(Boolean);
  out.announceTemplatesAttack = (Array.isArray(out.announceTemplatesAttack) && out.announceTemplatesAttack.length ? out.announceTemplatesAttack : DEFAULT_ADMIN_CFG.announceTemplatesAttack)
    .map((x) => String(x)).filter(Boolean);
  out.dryRunUntil = num(out.dryRunUntil, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
  return out;
}

/**
 * 现在是不是干跑？
 * - dryRun=false → 立刻生效（不看 dryRunUntil）
 * - dryRun=true 且 dryRunUntil>0 → 到点前干跑，到点后**自动生效**（不用手动关）
 * - dryRun=true 且 dryRunUntil=0 → 一直干跑，直到手动关
 */
export function isDryRun(cfg, now = Date.now()) {
  const c = mergeAdminConfig(cfg);
  if (!c.dryRun) return false;
  if (c.dryRunUntil > 0 && now >= c.dryRunUntil) return false;
  return true;
}

/** 干跑还剩多久（毫秒）；不干跑返回 0，无限期干跑返回 -1。 */
/**
 * 干跑到期要不要**再通知一次** owner（纯函数）。
 *
 * 为什么要问这个：到期通知以前只用一个**内存变量**去重，桥接一重启就忘 —— 于是每次重启
 * （看门狗重建、控制台重启、DSH 重启…）都会重新给 owner 发一遍"干跑截止时间到了"。
 * 实测 2026-09-29~30 两天发了 14 次。改成"记住通知过哪个截止时间"（落盘），只在
 * 用户设定了**新的**截止时间时才再通知一次。
 */
export function shouldAnnounceDryRunExpiry(cfg, announcedUntil = 0, now = Date.now()) {
  if (!cfg || cfg.dryRun !== true) return false;
  const until = Number(cfg.dryRunUntil) || 0;
  if (until <= 0) return false;          // 没设截止时间 → 没有"到点"这回事
  if (Number(now) < until) return false; // 还没到点
  return Number(announcedUntil) < until; // 这个截止时间还没通知过
}

export function dryRunRemainingMs(cfg, now = Date.now()) {
  const c = mergeAdminConfig(cfg);
  if (!isDryRun(c, now)) return 0;
  return c.dryRunUntil > 0 ? Math.max(0, c.dryRunUntil - now) : -1;
}

// ── 指纹 ───────────────────────────────────────────────────────────────────

/** 文本归一化：去掉空白、标点、零宽字符与常见 emoji，转小写。 */
export function normalizeTextForFingerprint(text) {
  return String(text ?? '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\u3000-\u303F\uFF00-\uFFEF!-\/:-@\[-`{-~]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
    .toLowerCase();
}

/** 图片/表情指纹：优先 QQ 图片 file（实测是稳定的 MD5 形式），否则用去掉签名参数的 url。 */
export function mediaFingerprint(media) {
  const m = media && typeof media === 'object' ? media : {};
  if (m.kind === 'face' && m.faceId) return `face:${m.faceId}`;
  const file = String(m.file ?? '').trim();
  if (file) return `file:${file.toLowerCase()}`;
  const url = String(m.url ?? '').trim();
  if (!url) return '';
  try {
    const u = new URL(url);
    return `url:${u.host.toLowerCase()}${u.pathname}`;
  } catch {
    return `url:${url.split('?')[0].toLowerCase()}`;
  }
}

/** 一条消息里的媒体指纹（一条消息可能有多张图，取全部）。 */
export function messageMediaFingerprints(msg) {
  const list = Array.isArray(msg?.media) ? msg.media : [];
  const fps = [...new Set(list.map(mediaFingerprint).filter(Boolean))];
  if (fps.length) return fps;
  // 兜底：图片段没给出 file/url（取字节失败等）时，用占位文本当指纹，至少还能判"重复发图"。
  const text = String(msg?.plain ?? msg?.text ?? '');
  if (msg?.hasMedia || isPlaceholderText(text)) {
    const norm = normalizeTextForFingerprint(text);
    if (norm) return [`placeholder:${norm}`];
  }
  return [];
}

/** 占位文本（"[图片]" / "[表情]" 之类）不含实际内容，不该走"同文本刷屏"判定。 */
export function isPlaceholderText(text) {
  const t = String(text ?? '').trim();
  return /^\[(图片|表情|视频|语音|文件|动画表情|转发消息[^\]]*|未知)\]$/.test(t);
}

// ── 检测 ───────────────────────────────────────────────────────────────────

function withinWindow(msg, now, windowMs) {
  return Number(msg?.time ?? 0) > 0 && now - Number(msg.time) <= windowMs;
}

function evidenceOf(messages, max = 5) {
  return messages.slice(-max).map((m) => ({
    messageId: m.messageId != null ? String(m.messageId) : null,
    seq: m.seq != null ? m.seq : null,
    at: Number(m.time) || 0,
    text: String(m.plain ?? m.text ?? '').slice(0, 120)
  }));
}

/**
 * 重复刷屏检测（同一个人连续重复同一段文字 / 同一张图）。
 * @returns {{hit:boolean, senderId?:string, kind?:'text'|'image', fingerprint?:string,
 *            count?:number, threshold?:number, evidence?:object[]}}
 */
export function detectRepeat(messages, options = {}) {
  const cfg = options.cfg ?? DEFAULT_ADMIN_CFG.spam;
  const now = Number(options.now) || Date.now();
  const windowMs = num(options.windowMs ?? cfg.windowMs, cfg.windowMs, { min: 1000, max: 86400000 });
  const textThreshold = num(options.textThreshold ?? cfg.sameTextCount, cfg.sameTextCount, { min: 2, max: 20 });
  const imageThreshold = num(options.imageThreshold ?? cfg.sameImageCount, cfg.sameImageCount, { min: 2, max: 20 });
  const minTextChars = num(options.minTextChars ?? cfg.minTextChars, cfg.minTextChars, { min: 0, max: 50 });
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.isSelf && withinWindow(m, now, windowMs));
  let best = { hit: false };

  // 同文本（占位文本如 "[图片]" 不算，交给同图判定）
  const byText = new Map(); // `${senderId}\u0000${fp}` -> messages[]
  for (const m of rows) {
    const raw = String(m.plain ?? m.text ?? '');
    if (isPlaceholderText(raw)) continue;
    const fp = normalizeTextForFingerprint(raw);
    if (!fp || fp.length < Math.max(1, minTextChars)) continue;
    const senderId = String(m.userId ?? '');
    if (!senderId) continue;
    const key = `${senderId}\u0000${fp}`;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(m);
  }
  for (const [key, list] of byText) {
    if (list.length >= textThreshold && list.length > (best.count ?? 0)) {
      const [senderId, fp] = key.split('\u0000');
      best = { hit: true, senderId, kind: 'text', fingerprint: fp, count: list.length, threshold: textThreshold, evidence: evidenceOf(list) };
    }
  }

  // 同图
  const byImage = new Map();
  for (const m of rows) {
    const senderId = String(m.userId ?? '');
    if (!senderId) continue;
    for (const fp of messageMediaFingerprints(m)) {
      const key = `${senderId}\u0000${fp}`;
      if (!byImage.has(key)) byImage.set(key, []);
      byImage.get(key).push(m);
    }
  }
  for (const [key, list] of byImage) {
    if (list.length >= imageThreshold && list.length > (best.count ?? 0)) {
      const [senderId, fp] = key.split('\u0000');
      best = { hit: true, senderId, kind: 'image', fingerprint: fp, count: list.length, threshold: imageThreshold, evidence: evidenceOf(list) };
    }
  }
  return best;
}

/**
 * 针对机器人的持续辱骂检测。
 * @param {object[]} messages 会话消息（含 atSelf / quoteTargetIsSelf）
 * @param {{cfg?:object, now?:number, rudeKeywords?:string[], selfNames?:string[], threshold?:number, windowMs?:number, senderId?:string}} options
 */
export function detectAttack(messages, options = {}) {
  const cfg = options.cfg ?? DEFAULT_ADMIN_CFG.attack;
  const now = Number(options.now) || Date.now();
  const windowMs = num(options.windowMs ?? cfg.windowMs, cfg.windowMs, { min: 1000, max: 86400000 });
  const threshold = num(options.threshold ?? cfg.count, cfg.count, { min: 1, max: 50 });
  const mustAddressBot = options.mustAddressBot ?? cfg.mustAddressBot !== false;
  const keywords = [
    ...(Array.isArray(cfg.keywords) ? cfg.keywords : []),
    ...(Array.isArray(options.rudeKeywords) ? options.rudeKeywords : [])
  ].map((k) => String(k).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const only = options.senderId != null ? String(options.senderId) : null;

  const hits = new Map(); // senderId -> {messages, matched:[], keywords:Set}
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.isSelf) continue;
    if (!withinWindow(m, now, windowMs)) continue;
    const senderId = String(m.userId ?? '');
    if (!senderId || (only && senderId !== only)) continue;
    const text = String(m.plain ?? m.text ?? '');
    if (!text) continue;
    const addressed = Boolean(m.atSelf) || Boolean(m.quoteTargetIsSelf)
      || (Array.isArray(options.selfNames) && options.selfNames.some((n) => n && text.toLowerCase().includes(String(n).toLowerCase())));
    if (mustAddressBot && !addressed) continue;
    const hitWord = keywords.find((k) => text.includes(k));
    if (!hitWord) continue;
    if (!hits.has(senderId)) hits.set(senderId, { messages: [], keywords: new Set() });
    const box = hits.get(senderId);
    box.messages.push(m);
    box.keywords.add(hitWord);
  }
  let best = { hit: false };
  for (const [senderId, box] of hits) {
    if (box.messages.length >= threshold && box.messages.length > (best.count ?? 0)) {
      best = {
        hit: true,
        senderId,
        kind: 'attack',
        count: box.messages.length,
        threshold,
        keywords: [...box.keywords],
        evidence: evidenceOf(box.messages)
      };
    }
  }
  return best;
}

// ── 时长与限流 ─────────────────────────────────────────────────────────────

/** 24 小时内该成员被禁言过几次（用于阶梯）。 */
export function countRecentMutes(records, { groupId, userId, now = Date.now(), windowHours = 24 } = {}) {
  const since = now - windowHours * 3600000;
  return (Array.isArray(records) ? records : []).filter((r) => r
    && r.action === 'mute'
    && r.ok !== false
    && r.dryRun !== true
    && String(r.groupId) === String(groupId)
    && String(r.userId) === String(userId)
    && Number(r.at) >= since).length;
}

/** 阶梯：首次用 base，24h 内每多一次 +step，最后 clamp 到 [minSec, maxSec]（1~10 分钟）。 */
export function planMuteSeconds({ triggerKind, priorMutes24h = 0, cfg }) {
  const c = mergeAdminConfig({ mute: cfg?.mute ?? cfg ?? {}, limits: {}, spam: {}, attack: {} });
  const m = c.mute;
  const base = triggerKind === 'attack' ? m.attackBaseSec : m.spamBaseSec;
  const raw = base + Math.max(0, Number(priorMutes24h) || 0) * m.stepSec;
  const seconds = Math.max(m.minSec, Math.min(m.maxSec, Math.round(raw)));
  const reason = triggerKind === 'attack'
    ? `攻击机器人（第 ${Number(priorMutes24h) + 1} 次）`
    : `重复刷屏（第 ${Number(priorMutes24h) + 1} 次）`;
  return { seconds, reason, base, step: m.stepSec, priorMutes24h: Number(priorMutes24h) || 0 };
}

/** 谁能被禁言：owner / 群主 / 管理员 / 机器人自己 / 白名单一律豁免。 */
export function canMuteTarget({ targetId, targetRole, botRole, botId, ownerQQ, groupOwnerId, whitelist = [] }) {
  const id = String(targetId ?? '');
  if (!id) return { ok: false, reason: '目标 QQ 无效' };
  if (botId && id === String(botId)) return { ok: false, reason: '不能禁言机器人自己' };
  if (ownerQQ && id === String(ownerQQ)) return { ok: false, reason: '不能禁言群主/管理员（ownerQQ）' };
  if (groupOwnerId && id === String(groupOwnerId)) return { ok: false, reason: '不能禁言群主' };
  if (whitelist.map(String).includes(id)) return { ok: false, reason: '该 QQ 在豁免白名单里' };
  if (targetRole === 'owner') return { ok: false, reason: '不能禁言群主' };
  if (targetRole === 'admin') return { ok: false, reason: '不能禁言管理员' };
  if (botRole !== 'admin' && botRole !== 'owner') return { ok: false, reason: '机器人不是管理员，没有禁言权限' };
  if (!targetRole) return { ok: false, reason: '取不到目标成员身份，保守放弃' };
  return { ok: true };
}

/** 全局限流 + 冷却 + 每人每日上限。 */
export function checkMuteLimits({ records, mutedUntil = {}, groupId, userId, now = Date.now(), cfg }) {
  const c = mergeAdminConfig({ mute: cfg?.mute ?? cfg ?? {}, limits: cfg?.limits ?? {}, spam: {}, attack: {} });
  const rows = Array.isArray(records) ? records : [];
  const real = rows.filter((r) => r && r.action === 'mute' && r.ok !== false && r.dryRun !== true);
  const last = real.filter((r) => String(r.groupId) === String(groupId) && String(r.userId) === String(userId)).sort((a, b) => b.at - a.at)[0];
  if (last && now - Number(last.at) < c.mute.perMemberCooldownMs) {
    const waitMin = Math.ceil((c.mute.perMemberCooldownMs - (now - Number(last.at))) / 60000);
    return { ok: false, reason: `该成员 ${waitMin} 分钟内刚被处理过（冷却中）` };
  }
  const until = Number(mutedUntil[`${groupId}:${userId}`] ?? 0);
  if (until > now) {
    return { ok: false, reason: `该成员还在禁言中（剩 ${Math.ceil((until - now) / 60000)} 分钟）` };
  }
  const dayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const perDay = real.filter((r) => String(r.groupId) === String(groupId) && String(r.userId) === String(userId) && Number(r.at) >= dayStart).length;
  if (perDay >= c.mute.maxPerMemberPerDay) return { ok: false, reason: `该成员今天已被禁言 ${perDay} 次（上限 ${c.mute.maxPerMemberPerDay}）` };
  const hourCount = real.filter((r) => now - Number(r.at) < 3600000).length;
  if (c.limits.maxPerHour > 0 && hourCount >= c.limits.maxPerHour) return { ok: false, reason: `本小时禁言已达上限 ${c.limits.maxPerHour} 次` };
  const dayCount = real.filter((r) => Number(r.at) >= dayStart).length;
  if (c.limits.maxPerDay > 0 && dayCount >= c.limits.maxPerDay) return { ok: false, reason: `今天禁言已达上限 ${c.limits.maxPerDay} 次` };
  return { ok: true };
}

// ── 公告 ───────────────────────────────────────────────────────────────────

const URL_RE = /(https?:\/\/|www\.|[a-z0-9-]+\.(?:com|cn|net|org|io|me|xyz|top|vip|cc|tv|app|dev)\b)/i;
const SENSITIVE_RE = /(?:[A-Za-z]:\\|\/home\/|\/Users\/|api[_-]?key|secret|password|passwd|bearer\s|token\s*[:=])/i;

/**
 * 公告正文校验与归一化。
 * @returns {{ok:boolean, text:string, errors:string[]}}
 */
export function validateAnnouncement(text, cfg = {}) {
  const c = mergeAdminConfig({ announcement: cfg, spam: {}, attack: {}, mute: {}, limits: {} }).announcement;
  const errors = [];
  let out = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
  if (!out) errors.push('公告内容不能为空');
  if (out.length > c.maxChars) errors.push(`公告过长（${out.length} > ${c.maxChars} 字；QQ 服务端会直接拒绝，实测 603 字就被拒了）`);
  const bytes = Buffer.byteLength(out, 'utf8');
  if (bytes > c.maxBytes) errors.push(`公告过长（${bytes} > ${c.maxBytes} 字节 UTF-8）`);
  if (/@全体|@all\b/i.test(out)) errors.push('公告里不要用 @全体成员');
  if (!c.allowLinks && URL_RE.test(out)) errors.push('默认不允许在公告里放链接（需要的话请在配置里打开 allowLinks）');
  if (SENSITIVE_RE.test(out)) errors.push('公告里疑似包含本机路径/凭据特征');
  // 折叠 3 行以上空行，去掉行尾空白，避免 QQ 端显示过散
  out = out.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n');
  return { ok: errors.length === 0, text: out, errors };
}

/** 与当前公告的差异摘要（给 owner 审批时看）。 */
export function summarizeNoticeDiff(currentText, nextText) {
  const cur = String(currentText ?? '').trim();
  const next = String(nextText ?? '').trim();
  if (!cur) return '（群里当前没有公告，这将是第一条）';
  if (cur === next) return '（内容与当前公告完全一致）';
  const curLines = new Set(cur.split('\n').map((l) => l.trim()).filter(Boolean));
  const nextLines = next.split('\n').map((l) => l.trim()).filter(Boolean);
  const added = nextLines.filter((l) => !curLines.has(l));
  const removed = [...curLines].filter((l) => !nextLines.includes(l));
  const parts = [];
  if (added.length) parts.push(`新增 ${added.length} 行：${added.slice(0, 3).map((l) => `「${l.slice(0, 40)}」`).join('')}`);
  if (removed.length) parts.push(`移除 ${removed.length} 行：${removed.slice(0, 3).map((l) => `「${l.slice(0, 40)}」`).join('')}`);
  if (!parts.length) parts.push('内容有调整（行数一致）');
  return parts.join('；');
}

// ── 记录 / 待审状态（文件读写）────────────────────────────────────────────

export function emptyModerationLog() {
  return { version: 1, updatedAt: 0, records: [], mutedUntil: {}, ownerNotified: {} };
}

export function loadModerationLog(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return emptyModerationLog();
    return {
      version: 1,
      updatedAt: Number(parsed.updatedAt) || 0,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      mutedUntil: parsed.mutedUntil && typeof parsed.mutedUntil === 'object' ? parsed.mutedUntil : {},
      ownerNotified: parsed.ownerNotified && typeof parsed.ownerNotified === 'object' ? parsed.ownerNotified : {}
    };
  } catch {
    return emptyModerationLog();
  }
}

export function saveModerationLog(file, log, maxRecords = DEFAULT_ADMIN_CFG.maxRecords) {
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    records: (Array.isArray(log?.records) ? log.records : []).slice(-Math.max(1, Number(maxRecords) || 500)),
    mutedUntil: log?.mutedUntil && typeof log.mutedUntil === 'object' ? log.mutedUntil : {},
    ownerNotified: log?.ownerNotified && typeof log.ownerNotified === 'object' ? log.ownerNotified : {}
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

/** 一条审计记录（调用方负责落盘）。 */
export function makeRecord(fields = {}) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    at: Number(fields.at) || Date.now(),
    groupId: String(fields.groupId ?? ''),
    userId: String(fields.userId ?? ''),
    userName: String(fields.userName ?? '').slice(0, 40),
    action: String(fields.action ?? 'mute'),      // mute | unmute | skip | announce
    trigger: String(fields.trigger ?? ''),        // text-repeat | image-repeat | attack | manual | model-request | announcement
    seconds: Number(fields.seconds) || 0,
    by: String(fields.by ?? 'auto'),              // auto | owner | model
    dryRun: fields.dryRun === true,
    ok: fields.ok !== false,
    error: String(fields.error ?? '').slice(0, 200),
    reason: String(fields.reason ?? '').slice(0, 200),
    count: Number(fields.count) || 0,
    keywords: Array.isArray(fields.keywords) ? fields.keywords.slice(0, 10) : [],
    evidence: Array.isArray(fields.evidence) ? fields.evidence.slice(0, 5) : []
  };
}

/** 人类可读的一行摘要（控制台 / owner 通知用）。 */
export function formatRecordLine(rec) {
  const when = new Date(Number(rec.at) || Date.now()).toLocaleString('zh-CN');
  const who = `${rec.userName || ''}(${rec.userId})`;
  const min = rec.seconds ? `${Math.round(rec.seconds / 60)} 分钟` : '';
  const tag = rec.dryRun ? '【干跑】' : '';
  const kind = rec.trigger === 'attack' ? '攻击机器人' : rec.trigger === 'image-repeat' ? '重复发同一张图' : rec.trigger === 'text-repeat' ? '重复发同一句话' : rec.trigger;
  if (rec.action === 'unmute') return `${when} ${tag}解禁 ${who}${rec.by === 'owner' ? '（管理员手动）' : ''}`;
  if (rec.action === 'announce') {
    const okText = rec.ok ? '成功' : (/拒绝/.test(String(rec.reason)) ? `被拒绝（${rec.reason}）` : `失败：${rec.error || '未知'}`);
    return `${when} 群公告：${okText}`;
  }
  if (rec.action === 'skip') return `${when} 跳过处理 ${who}：${rec.reason}`;
  const ev = (rec.evidence ?? []).map((e) => `「${String(e.text ?? '').slice(0, 24)}」`).join('');
  return `${when} ${tag}禁言 ${who} ${min}（${kind} ×${rec.count}）${ev ? ' 证据：' + ev : ''}${rec.ok ? '' : ' 失败：' + rec.error}`;
}

export function emptyPendingAnnouncement() {
  return { version: 1, pending: null };
}

export function loadPendingAnnouncement(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    const p = parsed?.pending;
    if (!p || typeof p !== 'object' || !p.content) return emptyPendingAnnouncement();
    return {
      version: 1,
      pending: {
        id: String(p.id ?? crypto.randomBytes(4).toString('hex')),
        content: String(p.content),
        createdAt: Number(p.createdAt) || Date.now(),
        source: String(p.source ?? 'model'),
        groupId: String(p.groupId ?? ''),
        status: String(p.status ?? 'pending')
      }
    };
  } catch {
    return emptyPendingAnnouncement();
  }
}

export function savePendingAnnouncement(file, state) {
  const payload = { version: 1, pending: state?.pending ?? null };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

/** 待审草稿是否已过期（过期即作废）。 */
export function pendingExpired(pending, cfg, now = Date.now()) {
  if (!pending) return false;
  const c = mergeAdminConfig({ announcement: cfg?.announcement ?? cfg ?? {}, spam: {}, attack: {}, mute: {}, limits: {} });
  return now - Number(pending.createdAt || 0) > c.announcement.confirmTimeoutMs;
}

/** 解析 owner 的批准/拒绝回复。 */
export const APPROVE_WORDS = ['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok'];
export const REJECT_WORDS = ['拒绝', '不同意', '不允许', '驳回', '取消', 'no', 'n', 'reject', 'deny'];

export function parseApproval(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (APPROVE_WORDS.includes(t)) return 'approve';
  if (REJECT_WORDS.includes(t)) return 'reject';
  return null;
}

/** 禁言时在群里说的那句话（announceInGroup=true 才会用）。 */
export function buildMuteNotice(template, { name, minutes }) {
  return String(template ?? DEFAULT_ADMIN_CFG.announceTemplate)
    .replace(/\{name\}/g, String(name || '这位'))
    .replace(/\{minutes\}/g, String(minutes ?? 1));
}

/**
 * 按人设挑一句"禁言播报"：从模板池里随机抽，填充 {name}/{minutes}。
 * 抽不到模板时回落到 announceTemplate。
 */
export function pickAnnounceLine(cfg, { name, minutes, kind = 'spam', random } = {}) {
  const c = mergeAdminConfig({ announceTemplate: cfg?.announceTemplate, announceTemplates: cfg?.announceTemplates, announceTemplatesAttack: cfg?.announceTemplatesAttack, spam: {}, attack: {}, mute: {}, limits: {} });
  const pool = kind === 'attack' ? c.announceTemplatesAttack : c.announceTemplates;
  const list = (Array.isArray(pool) && pool.length ? pool : [c.announceTemplate]).filter(Boolean);
  return pickTemplateLine(list, { name, minutes }, random) || fillFallback(c.announceTemplate, name, minutes);
}

function fillFallback(template, name, minutes) {
  return String(template ?? DEFAULT_ADMIN_CFG.announceTemplate)
    .replace(/\{name\}/g, String(name || '这位'))
    .replace(/\{minutes\}/g, String(minutes ?? 1));
}
