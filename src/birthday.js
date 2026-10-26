// 生日祝贺：判定"今天谁过生日" → 到点唤醒一次模型，由它写祝福并用自己的声音说一句日语。
//
// owner 2026-10-26 的需求：
//   · 北京时间 0 点给祝福（本机时区虽是 Asia/Shanghai，但这里**显式按 UTC+8** 算，不依赖系统时区）
//   · **模型现场写** 祝福 + **日语语音**（走已有的 qq_speak：先中文、再声音）
//   · 0 点不在线 ⇒ **当天补发**
//   · 生日数据**由 owner 手动编辑** state/birthdays.json
//
// 数据格式（state/birthdays.json）：
//   {
//     "100000001": { "name": "小明", "month": 10, "day": 26, "group": 123456789 },
//     "100000002": { "name": "小红", "month": 2, "day": 29 }
//   }
//   · key = QQ 号；group 省略时用 config.allow.groups 的第一个群
//   · year 可选（存了也只用于显示，不影响判定）
//   · lastSentYear 由程序自己写（同一年只发一次）
//
// 闰年边界：2/29 出生的人，在**平年**默认按 **2/28** 过（可改 by 传 feb29On 参数）。

import fs from 'node:fs';
import path from 'node:path';

const BEIJING_OFFSET_MIN = 8 * 60;

/** 把任意时刻转成"北京时间的年月日时分" */
export function beijingParts(now = Date.now()) {
  const d = new Date(Number(now) + BEIJING_OFFSET_MIN * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay()
  };
}

/** 是否是闰年 */
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 今天（北京时间）过生日的人。
 * @param {object} birthdays  state/birthdays.json 的内容
 * @param {number} now
 * @param {{feb29On?: '02-28'|'03-01'}} opts  平年时 2/29 的人算哪天（默认 02-28）
 */
export function todaysBirthdays(birthdays, now = Date.now(), { feb29On = '02-28' } = {}) {
  const t = beijingParts(now);
  const out = [];
  for (const [userId, raw] of Object.entries(birthdays ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    const month = Number(raw.month);
    const day = Number(raw.day);
    if (!isValidMonthDay(month, day)) continue;
    let hit = month === t.month && day === t.day;
    // 2/29 在平年：按配置的日子算
    if (!hit && month === 2 && day === 29 && !isLeapYear(t.year)) {
      const [m, d] = feb29On.split('-').map(Number);
      hit = m === t.month && d === t.day;
    }
    if (!hit) continue;
    if (Number(raw.lastSentYear) === t.year) continue;   // 同一年只发一次
    out.push({
      userId: String(userId),
      name: String(raw.name || userId),
      group: raw.group != null ? String(raw.group) : '',
      year: raw.year != null ? Number(raw.year) : null
    });
  }
  return out;
}

export function isValidMonthDay(month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const max = new Date(Date.UTC(2000, month, 0)).getUTCDate();   // 2000 是闰年 ⇒ 2 月按 29 算
  return day <= max;
}

/**
 * 现在该不该触发（北京时间 0 点整；或当天补发：>= 0 点且今天还没发过）。
 * @returns {{due:boolean, reason:string, parts:object}}
 */
export function shouldTickNow(now = Date.now(), { catchUp = true, windowMinutes = 1 } = {}) {
  const p = beijingParts(now);
  const minutesOfDay = p.hour * 60 + p.minute;
  if (minutesOfDay === 0) return { due: true, reason: 'midnight', parts: p };
  if (catchUp && minutesOfDay >= 0) {
    // 补发：0 点之后再检查时也算"该发"（是否已发由 lastSentYear 去重兜住）
    return { due: true, reason: 'catch-up', parts: p };
  }
  return { due: false, reason: 'not-yet', parts: p };
}

/** 读 state/birthdays.json（不存在就当空） */
export function loadBirthdays({ stateDir = 'state' } = {}) {
  const p = path.join(stateDir, 'birthdays.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

/** 写回 state/birthdays.json（原子写，UTF-8 无 BOM） */
export function saveBirthdays(birthdays, { stateDir = 'state' } = {}) {
  const p = path.join(stateDir, 'birthdays.json');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(birthdays, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}

/** 标记某人今年已发 */
export function markSent(birthdays, userId, year) {
  const k = String(userId);
  if (!birthdays[k]) return birthdays;
  birthdays[k].lastSentYear = Number(year);
  return birthdays;
}

/**
 * 给唤醒提示词的那一段：告诉模型"今天是他的生日，去祝福并用自己的声音说一句日语"。
 * @param {{name:string,userId:string,age?:number|null}} person
 */
export function birthdayPromptLine(person, { key = '' } = {}) {
  const uid = String(person?.userId || '');
  return `【生日】${key}\n今天是**这位群友**（QQ ${uid}）的生日。\n`
    + `请用 \`qq_speak\` 送祝福 —— 顺序它自己会处理（先中文、再语音）：\n`
    + `· \`text\`：一句**中文**祝福，用 \`atUserId\` = ${uid} **@ 他**；\n`
    + `  **不要写他的名字**（群名片会变，@ 就够）—— 直接说祝福本身，短一点、真心一点，别套话、别写小作文。\n`
    + `· \`ja\`：用**你自己的声音**说的一句**日语**生日祝福（必须含假名，≤100 字）；\n`
    + `  日语里同样**不要带名字**。\n`
    + `如果语音合成失败（服务没起等），就**只发中文祝福**，不要重试、不要假装发了语音。\n`;
}
