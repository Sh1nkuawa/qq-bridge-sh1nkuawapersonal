// 每日人格轮换：北京时间每天 05:00 换一次角色卡（owner 2026-11-15 拍板）。
//
// 设计要点（按 owner 的五条决定）：
//   1. 换卡**允许换会话**；若当时这一轮还在跑，就等本轮结束再换（同一时间窗内每分钟重试）。
//   2. **不补切**：05:00 那一刻桥接没跑（说明前一天非正常关机），当天就跳过，绝不延迟到白天突然变脸。
//   3. 手动切换**不暂停**自动：手动只是覆盖到下一个 05:00。
//   4. 心情**不清零**：两个角色是共同体，心情/好感度/黑话全部共享。
//   5. 每天切一次。
//
// 时区：显式按 UTC+8 计算，不依赖系统时区（同 src/birthday.js 的做法）。

const BEIJING_OFFSET_MIN = 8 * 60;

/** 任意时刻 → 北京时间的年月日时分 */
export function beijingParts(now = Date.now()) {
  const d = new Date(Number(now) + BEIJING_OFFSET_MIN * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes()
  };
}

/** 'YYYY-MM-DD'（按北京时间） */
export function dayKey(parts) {
  const p = parts ?? beijingParts();
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** '05:00' → { hour:5, minute:0 }；非法返回 null */
export function parseSwitchAt(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 现在该不该轮换。
 * @param {object} o
 * @param {number} o.now
 * @param {string} [o.switchAt='05:00']   北京时间几点切
 * @param {number} [o.windowMinutes=30]   窗口：到点后多少分钟内允许切（超出即当天放弃）
 * @param {string|null} [o.lastSwitchedDay] 上次成功切换的日期（'YYYY-MM-DD'）
 * @param {string[]} o.rotation           角色名轮换表
 * @param {number} [o.index=0]            当前在第几个
 * @param {boolean} [o.busy=false]        这一轮还在跑 ⇒ 等它结束
 * @returns {{due:boolean, reason:string, day:string, index:number, name:string|null}}
 */
export function shouldSwitch(o) {
  const {
    now = Date.now(),
    switchAt = '05:00',
    windowMinutes = 30,
    lastSwitchedDay = null,
    rotation = [],
    index = 0,
    busy = false
  } = o ?? {};

  const parts = beijingParts(now);
  const day = dayKey(parts);
  const base = { due: false, reason: '', day, index, name: null };

  if (!Array.isArray(rotation) || rotation.length < 2) {
    return { ...base, reason: 'no-rotation' };
  }
  const at = parseSwitchAt(switchAt);
  if (!at) return { ...base, reason: 'bad-switch-at' };

  if (lastSwitchedDay === day) return { ...base, reason: 'already-switched' };

  const elapsed = (parts.hour * 60 + parts.minute) - (at.hour * 60 + at.minute);
  // 关键：到点之前不切；过了窗口就**当天放弃**（不补切）
  if (elapsed < 0) return { ...base, reason: 'before-window' };
  if (elapsed > windowMinutes) return { ...base, reason: 'outside-window' };

  // 在窗口内，但这一轮还在跑 ⇒ 等它结束（下一分钟再来问）
  if (busy) return { ...base, reason: 'busy' };

  const nextIndex = ((Number(index) || 0) + 1) % rotation.length;
  return { due: true, reason: 'due', day, index: nextIndex, name: String(rotation[nextIndex]) };
}

/** 按当前角色名算出起始 index（找不到就 0），保证"下一次"切到另一个 */
export function indexOfRole(rotation, currentRole) {
  if (!Array.isArray(rotation)) return 0;
  const i = rotation.indexOf(String(currentRole ?? ''));
  return i >= 0 ? i : 0;
}
