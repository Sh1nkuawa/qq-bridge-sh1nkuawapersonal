// 投喂模块单测：node scripts/test-feed.mjs（不联网，网络部分用假 fetch）
import crypto from 'node:crypto';
import {
  DEFAULT_FEED, mergeFeedConfig, todayKey, extractOrderNo, maskOrderNo,
  emptyLedger, sanitizeLedger, recordOrder, removeOrder, summarize, ledgerCsv,
  attemptsAllowed, noteAttempt, afdianSign, verifyAfdianOrder, shouldAlertHungry,
  shouldHandleFeed, buildFeedHint
} from '../src/feed.js';
import { emptyMember, recordEvent, tierOf } from '../src/affinity.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
};

const cfg = mergeFeedConfig({});
const DAY = 86400000;
const ORDER = '20260712140309100485413171';

console.log('订单号解析：');
ok('取出 ≥10 位连续数字', extractOrderNo(`我投喂了 ${ORDER} 谢谢`) === ORDER);
ok('太短的数字不算', extractOrderNo('投喂 12345') === '');
ok('没有数字返回空', extractOrderNo('投喂一下') === '');
ok('多个数字取第一个', extractOrderNo('1234567890 9876543210') === '1234567890');
ok('日志脱敏', maskOrderNo(ORDER) === '2026…3171' && !maskOrderNo(ORDER).includes('14030910'));

console.log('\n触发判定（谁该被桥接接管）：');
ok('@机器人 + 投喂 → 接管', shouldHandleFeed('@小鲸鱼 投喂', true) === true);
ok('只打"投喂"两个字 → 也接管', shouldHandleFeed('投喂', false) === true);
ok('带标点的"赞助？" → 接管', shouldHandleFeed('赞助？', false) === true);
ok('"打赏一下"（无@）→ 不接管', shouldHandleFeed('打赏一下', false) === false);
ok('普通聊天提到投喂（无@）→ 不接管', shouldHandleFeed('我昨天投喂了楼下的猫', false) === false);
ok('无关键词 → 不接管', shouldHandleFeed('@小鲸鱼 在吗', true) === false);

console.log('\n投喂提示（关键：绝不含链接）：');
const hint = buildFeedHint();
ok('提示去找群主要入口', hint.includes('群主'));
ok('含"订单号"说明：去哪找/怎么给我', hint.includes('订单号'));
ok('**不含任何 http 链接**（机器人不发收款外链）', !/https?:\/\//i.test(hint), hint);
ok('不含 afdian 域名', !/afdian|ifdian/i.test(hint));

console.log('\n账本与权益：');
let ledger = emptyLedger();
let r = recordOrder(ledger, { orderNo: ORDER, userId: '200000008', name: '群友G', amount: 6, status: 2 }, cfg);
ok('第一笔记录成功', r.ok && r.reason === 'ok');
ok('第一笔给权益 +5', r.affinity === 5 && r.dailyFirst === true, `affinity=${r.affinity}`);
ok('累计 1 笔 6 元', ledger.totals.count === 1 && ledger.totals.amount === 6, JSON.stringify(ledger.totals));

r = recordOrder(ledger, { orderNo: '20260712140309100485413172', userId: '200000008', name: '群友G', amount: 6, status: 2 }, cfg);
ok('同一天第二笔不再给权益', r.ok && r.affinity === 0 && r.dailyFirst === false, `affinity=${r.affinity}`);
ok('但账本照记（2 笔 12 元）', ledger.totals.count === 2 && ledger.totals.amount === 12);

r = recordOrder(ledger, { orderNo: ORDER, userId: '9999', name: '别人', amount: 6 }, cfg);
ok('同一订单号不能重复用', !r.ok && r.reason === 'duplicate-order');
ok('重复提交不改账本', ledger.totals.count === 2);

r = recordOrder(ledger, { orderNo: '123', userId: '9999' }, cfg);
ok('非法订单号被拒', !r.ok && r.reason === 'invalid-order-no');

// 次日第一笔恢复权益
const nextDay = Date.now() + DAY;
r = recordOrder(ledger, { orderNo: '20260712140309100485413173', userId: '200000008', name: '群友G', amount: 30, status: 2 }, cfg, nextDay);
ok('次日第一笔又有权益', r.affinity === 5 && r.dailyFirst === true, `affinity=${r.affinity}`);
ok('todayKey 跨天不同', todayKey(Date.now()) !== todayKey(nextDay));

// 不同人各自享有每日首笔
r = recordOrder(ledger, { orderNo: '20260712140309100485413174', userId: '200000001', name: '群友A', amount: 6, status: 2 }, cfg);
ok('换个人同一天也有权益', r.affinity === 5);

console.log('\n撤销与统计：');
const before = { ...ledger.totals };
r = removeOrder(ledger, ORDER);
ok('撤销成功', r.ok && !ledger.orders[ORDER]);
ok('累计同步回滚', ledger.totals.count === before.count - 1 && Math.abs(ledger.totals.amount - (before.amount - 6)) < 1e-6, JSON.stringify(ledger.totals));
ok('撤销不存在的单号', !removeOrder(ledger, ORDER).ok);

const sum = summarize(ledger);
ok('汇总里两个人都统计到', sum.members.length === 2, JSON.stringify(sum.members.map((m) => m.userId)));
ok('按金额排序', sum.members[0].amount >= sum.members[1].amount);
ok('CSV 有表头与行', ledgerCsv(ledger).split('\r\n').length === sum.orders.length + 1);

console.log('\n限流：');
let l2 = emptyLedger();
const uid = '1234';
for (let i = 0; i < cfg.maxAttemptsPerHour; i += 1) noteAttempt(l2, uid);
ok('达到上限后拒绝', attemptsAllowed(l2, uid, cfg) === false);
ok('一小时后恢复', attemptsAllowed(l2, uid, cfg, Date.now() + 3600001) === true);
ok('别人不受影响', attemptsAllowed(l2, '5678', cfg) === true);

console.log('\n清洗：');
const dirty = sanitizeLedger({ orders: { [ORDER]: { userId: '1', amount: '6', at: 1 }, bad: {} }, daily: { '2026-09-27': { '1': { count: 1, affinity: 5 } }, xx: {} }, totals: { count: 99, amount: 1 } });
ok('非法订单号被丢', !dirty.orders.bad);
ok('合法订单留下', !!dirty.orders[ORDER] && dirty.orders[ORDER].amount === 6);
ok('非法日期被丢', !dirty.daily.xx && !!dirty.daily['2026-09-27']);

console.log('\n爱发电签名与核验（假 fetch）：');
ok('签名 = md5(token+params+ts+user_id)', afdianSign('tok', 'u1', '{"a":1}', 123)
  === crypto.createHash('md5').update('tokparams{"a":1}ts123user_idu1', 'utf8').digest('hex'));

const realFetch = globalThis.fetch;
let captured = null;
const seenHosts = [];
globalThis.fetch = async (url, init) => {
  seenHosts.push(new URL(url).host);
  captured = { url, body: JSON.parse(init.body) };
  return { ok: true, status: 200, json: async () => ({ ec: 200, data: { list: [{ out_trade_no: ORDER, total_amount: '6.00', status: 2 }] } }) };
};
let v = await verifyAfdianOrder({ userId: 'u1', token: 'tok', orderNo: ORDER });
ok('主域名用 afdian.com（afdian.net 已废弃）', captured.url === 'https://afdian.com/api/open/query-order', captured.url);
ok('body 带 user_id/params/ts/sign', captured.body.user_id === 'u1' && !!captured.body.sign && captured.body.params.includes(ORDER));
ok('订单存在 → exists', v.ok && v.exists === true);
ok('解析出金额 6', v.amount === 6, `amount=${v.amount}`);
ok('带出 status', v.status === 2);

// 第一个域名挂掉 → 自动切备用域名
seenHosts.length = 0;
globalThis.fetch = async (url) => {
  const host = new URL(url).host;
  seenHosts.push(host);
  if (host === 'afdian.com') throw new Error('getaddrinfo ENOTFOUND');
  return { ok: true, status: 200, json: async () => ({ ec: 200, data: { list: [{ out_trade_no: ORDER, total_amount: '6.00', status: 2 }] } }) };
};
v = await verifyAfdianOrder({ userId: 'u1', token: 'tok', orderNo: ORDER });
ok('主域名失败时自动切备用域名', v.ok && v.exists === true && seenHosts.join(',') === 'afdian.com,ifdian.net', seenHosts.join(','));

// 所有域名都挂 → 明确报错
globalThis.fetch = async () => { throw new Error('boom'); };
v = await verifyAfdianOrder({ userId: 'u1', token: 'tok', orderNo: ORDER });
ok('全部失败时报错且列出原因', !v.ok && /所有接口地址都失败/.test(v.error) && !v.error.includes('tok'));

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ec: 200, data: { list: [] } }) });
v = await verifyAfdianOrder({ userId: 'u1', token: 'tok', orderNo: ORDER });
ok('订单不存在 → exists=false', v.ok && v.exists === false);

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ec: 400, em: '签名错误' }) });
v = await verifyAfdianOrder({ userId: 'u1', token: 'tok', orderNo: ORDER });
ok('ec≠200 报错且不泄露 token', !v.ok && /签名错误/.test(v.error) && !v.error.includes('tok'));

ok('没配凭据时直接拒绝', !(await verifyAfdianOrder({ userId: '', token: '', orderNo: ORDER })).ok);
globalThis.fetch = realFetch;

console.log('\n余额水位：');
let l3 = emptyLedger();
ok('余额低于阈值 → 该提醒', shouldAlertHungry(l3, { ok: true, totalBalance: 5 }, cfg) === true);
ok('余额充足 → 不提醒', shouldAlertHungry(l3, { ok: true, totalBalance: 500 }, cfg) === false);
ok('查询失败 → 不提醒', shouldAlertHungry(l3, { ok: false }, cfg) === false);
l3.alerts.hungryAt = Date.now();
ok('冷却期内不重复提醒', shouldAlertHungry(l3, { ok: true, totalBalance: 5 }, cfg) === false);
ok('过冷却期可再提醒', shouldAlertHungry(l3, { ok: true, totalBalance: 5 }, cfg, Date.now() + cfg.hungry.alertGapMs + 1) === true);

console.log('\n投喂加分绕过好感度日封顶：');
const acfg = { start: 40, dailyUp: 6, dailyDown: 6, min: -200, max: 1000 };
let m = emptyMember('777', '金主', acfg);
recordEvent(m, { kind: 'message', text: '在吗' }, acfg);              // 日常 +2
recordEvent(m, { kind: 'message', text: 'x', attention: true }, acfg); // +1
recordEvent(m, { kind: 'message', text: 'y', attention: true }, acfg); // +1
const beforeFeed = m.score;
ok('日常累计到 44（+4，未触顶）', beforeFeed === 44, `score=${beforeFeed}`);
const fr = recordEvent(m, { kind: 'feed', affinity: 5 }, acfg);
ok('投喂 +5 实打实加上去（不被日封顶裁掉）', m.score === 49, `score=${m.score}`);
ok('事件原因标注不计入日封顶', /不计入日封顶/.test(fr.reasons.join(';')), fr.reasons.join(';'));
ok('投喂后仍在普通群友档', tierOf(m.score, acfg).key === 'normal');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
