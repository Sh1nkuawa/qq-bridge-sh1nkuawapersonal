// feed.js — 投喂（赞助）账本 + 爱发电订单核验 + DeepSeek 余额水位
//
// 背景（必须先说清楚的事实）：
//   DeepSeek 开放平台**没有充值 API**，余额只能在控制台人工充（支付宝/微信）或用企业对公汇款，
//   且对公汇款要求"汇款方开户名与实名认证名称一致"。所以"群友付款自动变成 API 余额"做不到。
//   本模块负责的是前半段：**收款 → 核验 → 记账 → 发权益**；充值那一下必须 owner 手动做。
//
// 核验走爱发电开放 API（order 必须是赞助者本人能看到的订单号）：
//   POST https://ifdian.net/api/open/query-order
//   body = { user_id, params: '{"out_trade_no":"..."}', ts, sign }
//   sign = md5(`${token}params${params}ts${ts}user_id${user_id}`)
//   返回 { ec: 200, data: { list: [...] } }；list 非空即订单存在。
//
// 设计底线：
//   - 金额只在 owner 私聊/控制台可见，**绝不在群里出现**；
//   - 订单号一次性（全局去重），并做每人每小时提交次数限流（防拿假单号刷 API）；
//   - 权益由 owner 定的规则给（当前：每人每天第一笔 +5 好感度，且**绕过好感度每日封顶**）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEDGER_FILE = path.join(ROOT, 'state', 'feed.json');
const BALANCE_URL = 'https://api.deepseek.com/user/balance';

export const DEFAULT_FEED = {
  // 默认关闭：必须先配好爱发电 user_id/token（见 docs/FEED.md）
  enabled: false,
  // 爱发电开放平台凭据。注意：控制台地址是 https://afdian.com/dashboard/dev
  // （旧的 afdian.net 域名**已经废弃**，DNS 都解析不出来，实测 2026-09-27）。
  // apiBases 按顺序尝试，前面的挂了自动切后面的 —— 毕竟这个平台换过一次域名。
  afdian: {
    userId: '',
    token: '',
    apiBases: ['https://afdian.com', 'https://ifdian.net']
  },
  // 每人每天第一笔投喂给的好感度（0 = 不给）
  dailyAffinity: 5,
  // 每人每小时最多提交几次订单号（防止拿假单号刷爱发电 API）
  maxAttemptsPerHour: 5,
  // 是否把每笔投喂私聊告知 owner（含金额）
  notifyOwnerOnFeed: true,
  // 余额水位提醒：只私聊 owner，不在群里说钱
  hungry: {
    enabled: true,
    threshold: 20,          // 余额低于该值（元）时提醒
    checkMs: 6 * 3600 * 1000,
    alertGapMs: 12 * 3600 * 1000
  }
};

export function mergeFeedConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_FEED, ...src };
  out.afdian = { ...DEFAULT_FEED.afdian, ...(src.afdian && typeof src.afdian === 'object' ? src.afdian : {}) };
  out.hungry = { ...DEFAULT_FEED.hungry, ...(src.hungry && typeof src.hungry === 'object' ? src.hungry : {}) };
  out.dailyAffinity = Math.max(0, Number(out.dailyAffinity) || 0);
  out.maxAttemptsPerHour = Math.max(1, Number(out.maxAttemptsPerHour) || 5);
  return out;
}

export function todayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 从一段文本里取订单号：第一串 ≥10 位连续数字（爱发电订单号是长数字串） */
export function extractOrderNo(text) {
  const m = String(text ?? '').match(/\d{10,}/);
  return m ? m[0] : '';
}

export const FEED_TRIGGER_RE = /投喂|赞助|打赏|投币|喂饭/;

/**
 * 这条消息要不要由桥接接管（而不是交给模型）？
 * 两种情况：① 明确对机器人说 + 含投喂关键词；② 整条消息就是"投喂"这类命令词（哪怕没 @）。
 * 第二种是为了体验：群友只打"投喂"两个字，也应该直接拿到付款入口。
 */
export function shouldHandleFeed(rawText, addressedToBot) {
  const text = String(rawText ?? '');
  if (!FEED_TRIGGER_RE.test(text)) return false;
  if (addressedToBot) return true;
  return /^\s*[/／]?\s*(投喂|赞助|打赏|投币|喂饭)\s*[!！。.~～?？]*\s*$/.test(text);
}

/**
 * 群友说"投喂"但没给订单号时的回话。
 *
 * **刻意不含任何链接**（2026-09-27 owner 决定）：机器人自动在群里发"收款性质外链"有风控风险
 * （可能被拦消息/限制发送，被人举报会升级；账号还是小号），所以入口一律由 owner 人工给人。
 * 机器人只负责：提示去找群主要入口 + 订单号核验 + 记账 + 发权益。
 */
export function buildFeedHint() {
  return '投喂是自愿赞助～入口找群主要，付完之后把订单号（一串数字）发我，我来核对记账。';
}

/** 日志/报错里不要出现完整订单号（谁看到都能拿去冒领） */
export function maskOrderNo(no) {
  const s = String(no ?? '');
  if (s.length <= 8) return s ? `${s.slice(0, 2)}…` : '';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function emptyLedger() {
  return { orders: {}, daily: {}, attempts: {}, totals: { count: 0, amount: 0 }, alerts: { hungryAt: 0 }, updatedAt: 0 };
}

export function sanitizeLedger(raw) {
  const out = emptyLedger();
  const src = raw && typeof raw === 'object' ? raw : {};
  const orders = src.orders && typeof src.orders === 'object' ? src.orders : {};
  for (const [no, v] of Object.entries(orders)) {
    if (!/^\d{10,}$/.test(no) || !v || typeof v !== 'object') continue;
    out.orders[no] = {
      orderNo: no,
      userId: String(v.userId ?? ''),
      name: String(v.name ?? '').slice(0, 40),
      amount: Number(v.amount) || 0,
      status: v.status === undefined || v.status === null ? null : Number(v.status),
      verified: v.verified !== false,
      at: Number(v.at) || 0,
      rawSummary: String(v.rawSummary ?? '').slice(0, 120)
    };
  }
  const daily = src.daily && typeof src.daily === 'object' ? src.daily : {};
  for (const [day, users] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !users || typeof users !== 'object') continue;
    const clean = {};
    for (const [uid, v] of Object.entries(users)) {
      if (!/^\d+$/.test(uid) || !v || typeof v !== 'object') continue;
      clean[uid] = { count: Number(v.count) || 0, affinity: Number(v.affinity) || 0 };
    }
    out.daily[day] = clean;
  }
  const attempts = src.attempts && typeof src.attempts === 'object' ? src.attempts : {};
  for (const [uid, list] of Object.entries(attempts)) {
    if (!/^\d+$/.test(uid) || !Array.isArray(list)) continue;
    out.attempts[uid] = list.map(Number).filter((n) => Number.isFinite(n)).slice(-50);
  }
  out.totals = {
    count: Number(src.totals?.count) || Object.keys(out.orders).length,
    amount: Number(src.totals?.amount) || Object.values(out.orders).reduce((s, o) => s + (Number(o.amount) || 0), 0)
  };
  out.alerts = { hungryAt: Number(src.alerts?.hungryAt) || 0 };
  out.updatedAt = Number(src.updatedAt) || 0;
  // 只保留最近 60 天的 daily，避免无限增长
  const days = Object.keys(out.daily).sort();
  while (days.length > 60) delete out.daily[days.shift()];
  return out;
}

export function loadLedger() {
  try {
    let text = fs.readFileSync(LEDGER_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return sanitizeLedger(JSON.parse(text));
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(ledger) {
  const clean = sanitizeLedger(ledger);
  clean.updatedAt = Date.now();
  const tmp = `${LEDGER_FILE}.tmp`;
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(tmp, LEDGER_FILE);
  return clean;
}

/** 提交限流：同一人一小时最多 N 次（含失败尝试） */
export function attemptsAllowed(ledger, userId, cfg, now = Date.now()) {
  const c = mergeFeedConfig(cfg);
  const list = (ledger.attempts?.[String(userId)] || []).filter((t) => now - t < 3600000);
  return list.length < c.maxAttemptsPerHour;
}

export function noteAttempt(ledger, userId, now = Date.now()) {
  const id = String(userId);
  if (!ledger.attempts || typeof ledger.attempts !== 'object') ledger.attempts = {};
  const list = (ledger.attempts[id] || []).filter((t) => now - t < 3600000);
  list.push(now);
  ledger.attempts[id] = list.slice(-50);
}

/**
 * 记一笔已核验的投喂。
 * 返回 { ok, reason, order?, affinity, dailyFirst }；reason ∈
 *   ok / duplicate-order / invalid-order-no / empty
 */
export function recordOrder(ledger, info, cfg, now = Date.now()) {
  const c = mergeFeedConfig(cfg);
  const orderNo = String(info?.orderNo ?? '').trim();
  if (!/^\d{10,}$/.test(orderNo)) return { ok: false, reason: 'invalid-order-no', affinity: 0, dailyFirst: false };
  if (ledger.orders[orderNo]) return { ok: false, reason: 'duplicate-order', affinity: 0, dailyFirst: false };

  const userId = String(info?.userId ?? '');
  const day = todayKey(now);
  const order = {
    orderNo,
    userId,
    name: String(info?.name ?? '').slice(0, 40),
    amount: Number(info?.amount) || 0,
    status: info?.status === undefined || info?.status === null ? null : Number(info.status),
    verified: info?.verified !== false,
    at: now,
    rawSummary: String(info?.rawSummary ?? '').slice(0, 120)
  };
  ledger.orders[orderNo] = order;
  ledger.totals = {
    count: (Number(ledger.totals?.count) || 0) + 1,
    amount: (Number(ledger.totals?.amount) || 0) + order.amount
  };
  if (!ledger.daily[day]) ledger.daily[day] = {};
  const d = ledger.daily[day][userId] || { count: 0, affinity: 0 };
  d.count += 1;
  // 权益：每人每天第一笔才给（之后不加）
  let affinity = 0;
  const dailyFirst = d.count === 1;
  if (dailyFirst && c.dailyAffinity > 0) {
    affinity = c.dailyAffinity;
    d.affinity += affinity;
  }
  ledger.daily[day][userId] = d;
  return { ok: true, reason: 'ok', order, affinity, dailyFirst };
}

/** 撤销一笔（退款/误记）：从账本移除并回滚累计 */
export function removeOrder(ledger, orderNo) {
  const no = String(orderNo ?? '').trim();
  if (!ledger.orders[no]) return { ok: false, reason: 'not-found' };
  const o = ledger.orders[no];
  delete ledger.orders[no];
  ledger.totals = {
    count: Math.max(0, (Number(ledger.totals?.count) || 0) - 1),
    amount: Math.round(((Number(ledger.totals?.amount) || 0) - (Number(o.amount) || 0)) * 100) / 100
  };
  return { ok: true, order: o };
}

export function summarize(ledger) {
  const orders = Object.values(ledger?.orders ?? {}).sort((a, b) => b.at - a.at);
  const byUser = {};
  for (const o of orders) {
    const k = o.userId || '未知';
    if (!byUser[k]) byUser[k] = { userId: k, name: o.name, count: 0, amount: 0, lastAt: 0 };
    byUser[k].count += 1;
    byUser[k].amount += Number(o.amount) || 0;
    byUser[k].lastAt = Math.max(byUser[k].lastAt, o.at);
    if (o.name) byUser[k].name = o.name;
  }
  return {
    totals: { count: orders.length, amount: Math.round((Number(ledger?.totals?.amount) || 0) * 100) / 100 },
    members: Object.values(byUser).sort((a, b) => b.amount - a.amount),
    orders
  };
}

export function ledgerCsv(ledger) {
  const rows = [['时间', 'QQ', '昵称', '金额', '订单号', '状态', '来源'].join(',')];
  for (const o of Object.values(ledger?.orders ?? {}).sort((a, b) => a.at - b.at)) {
    const t = new Date(o.at).toLocaleString('sv');
    rows.push([t, o.userId, `"${String(o.name).replace(/"/g, '""')}"`, o.amount, o.orderNo, o.status ?? '', 'afdian'].join(','));
  }
  return rows.join('\r\n');
}

// ───────────────────────── 爱发电核验 ─────────────────────────

export function afdianSign(token, userId, params, ts) {
  return crypto.createHash('md5').update(`${token}params${params}ts${ts}user_id${userId}`, 'utf8').digest('hex');
}

function pickOrderAmount(order) {
  const cands = [order?.total_amount, order?.price, order?.show_amount, order?.amount];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * 查询一个订单号是否真实存在。
 * 返回 { ok, exists, amount, status, order?, error? }
 * apiBases 里多个域名会依次尝试（爱发电换过域名，afdian.net 已废弃）。
 */
export async function verifyAfdianOrder({ userId, token, orderNo, timeoutMs = 15000, apiBases }) {
  if (!userId || !token) return { ok: false, exists: false, error: '未配置爱发电 user_id / token' };
  const bases = (Array.isArray(apiBases) && apiBases.length ? apiBases : DEFAULT_FEED.afdian.apiBases)
    .map((b) => String(b).replace(/\/+$/, ''));
  const params = JSON.stringify({ out_trade_no: String(orderNo) });
  const ts = Math.floor(Date.now() / 1000);
  const sign = afdianSign(token, userId, params, ts);
  const errors = [];
  for (const base of bases) {
    let res;
    try {
      res = await fetch(`${base}/api/open/query-order`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: userId, params, ts, sign }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      errors.push(`${base}: 请求失败 ${error?.message ?? error}`);
      continue;
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) { errors.push(`${base}: HTTP ${res.status}`); continue; }
    if (!body || body.ec !== 200) {
      // 业务错误（签名/权限问题）换域名也没用，直接返回；不要把 token/sign 回显出去
      return { ok: false, exists: false, error: `爱发电返回 ec=${body?.ec ?? '?'}${body?.em ? `（${String(body.em).slice(0, 60)}）` : ''}` };
    }
    const list = Array.isArray(body.data?.list) ? body.data.list : [];
    const order = list[0] ?? null;
    if (!order) return { ok: true, exists: false };
    return {
      ok: true,
      exists: true,
      amount: pickOrderAmount(order),
      status: order.status === undefined ? null : Number(order.status),
      order,
      rawSummary: `ec=200, status=${order.status ?? '?'}`
    };
  }
  return { ok: false, exists: false, error: `所有接口地址都失败：${errors.join('；').slice(0, 160)}` };
}

// ───────────────────────── DeepSeek 余额 ─────────────────────────

function readDeepseekKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  for (const file of [path.join(home, '.credentials.yaml'), path.join(ROOT, '.credentials.yaml')]) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const refsAt = text.indexOf('refs:');
      const recordsAt = text.indexOf('records:');
      const scope = refsAt >= 0 ? text.slice(refsAt, recordsAt > refsAt ? recordsAt : undefined) : text;
      const m = scope.match(/DEEPSEEK_API_KEY\s*:\s*["']?([A-Za-z0-9_\-]{8,})/);
      if (m) return m[1];
    } catch { /* 继续找下一个 */ }
  }
  return '';
}

export async function fetchDeepseekBalance(timeoutMs = 20000) {
  const key = readDeepseekKey();
  if (!key) return { ok: false, error: '未找到 DEEPSEEK_API_KEY（DSH 凭据或环境变量）' };
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, error: `余额接口 HTTP ${res.status}` };
    const data = await res.json();
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
    const info = infos.find((x) => x && x.currency === 'CNY') || infos[0];
    if (!info || info.total_balance === undefined) return { ok: false, error: '余额接口结构异常' };
    return {
      ok: true,
      currency: String(info.currency || 'CNY'),
      totalBalance: Number(info.total_balance),
      grantedBalance: info.granted_balance !== undefined ? Number(info.granted_balance) : undefined,
      toppedUpBalance: info.topped_up_balance !== undefined ? Number(info.topped_up_balance) : undefined
    };
  } catch (error) {
    return { ok: false, error: `余额查询失败：${error?.message ?? error}` };
  }
}

/** 是否该提醒 owner 充值了（含冷却），不改状态；由调用方决定是否记 alerts.hungryAt */
export function shouldAlertHungry(ledger, balance, cfg, now = Date.now()) {
  const c = mergeFeedConfig(cfg);
  if (!c.hungry.enabled) return false;
  if (!balance?.ok) return false;
  if (!(Number(balance.totalBalance) < Number(c.hungry.threshold))) return false;
  const last = Number(ledger?.alerts?.hungryAt) || 0;
  return now - last >= c.hungry.alertGapMs;
}
