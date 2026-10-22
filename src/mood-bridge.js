// 「鱼的心情」(dsh-feiyu-mood) 的本地适配：把它的目标会话跟我们的会话 id 同步。
//
// 为什么需要（2026-10-23）：插件用 `cfg.targetSession` **精确匹配** DSH 的 session id
// （其内部判定是 `if (sid !== target) continue`，而 `DEFAULT_SESSION = ''`）。
// 我们的桥接在「切模式 / 切角色 / 会话重置 / 看门狗解绑卡死会话」时都会**新建会话** ⇒
// id 一变，插件的 targetSession 就指向一个不存在的会话 ⇒ 它**一个会话都不挂** ✗ ⇒
// 心情永远停在基线、也不注入（实测：config.targetSession 为空、state.mood 一直是 70）。
//
// 注意：心情本身（`<DSH_HOME>/feiyu-mood/state.json`）是**全局一份、跨会话共享** ✓ ——
// 换会话不会重置它 ✓，所以这里只需要把「绑定」跟过去，不需要搬数据 ✓。
//
// 设计约束：
//   - 只改 targetSession 一个字段，其它设置（名字/模型/门槛/开关）**一律不碰** ✗；
//   - 文件不存在（没装插件）⇒ 静默跳过 ✓；JSON 坏了 ⇒ **不覆盖** ✓（免得毁掉用户设置）；
//   - 写入用「临时文件 + rename」✓，避免插件正好在读时读到半个文件；
//   - **UTF-8 无 BOM** ✓（带 BOM 会让 DSH 读 profile 时崩，这个作者专门警告过）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_RE = /^session-[A-Za-z0-9-]{6,}$/;

export function moodConfigPath({ home = os.homedir() } = {}) {
  return path.join(home, '.dsh', 'feiyu-mood', 'config.json');
}

function readJsonTolerant(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { ok: false, reason: 'not-installed' }; }
  const text = raw.replace(/^\uFEFF/, '');   // 容忍 BOM（别人手改过也读得动）
  try { return { ok: true, json: JSON.parse(text), text }; } catch { return { ok: false, reason: 'bad-json' }; }
}

/** 读它当前绑定的会话（排障用） */
export function readMoodTargetSession({ home = os.homedir() } = {}) {
  const p = moodConfigPath({ home });
  const r = readJsonTolerant(p);
  if (!r.ok) return { ok: false, reason: r.reason, path: p };
  return { ok: true, path: p, target: String(r.json?.targetSession ?? '') };
}

/**
 * 把插件的 targetSession 同步成给定会话。
 * @returns {{ok:boolean, changed?:boolean, target?:string, reason?:string, path:string}}
 */
export function syncMoodTargetSession(sessionId, { home = os.homedir(), log = () => {} } = {}) {
  const p = moodConfigPath({ home });
  const sid = String(sessionId ?? '').trim();
  if (!SESSION_RE.test(sid)) return { ok: false, reason: 'bad-session-id', path: p };

  const r = readJsonTolerant(p);
  if (!r.ok) {
    // 没装：静默（很多人没装这个插件，不该刷日志）
    if (r.reason === 'not-installed') return { ok: false, reason: 'not-installed', path: p };
    // 坏了：只报，不覆盖 ✗
    return { ok: false, reason: 'bad-json', path: p };
  }
  const cfg = r.json && typeof r.json === 'object' ? r.json : {};
  if (String(cfg.targetSession ?? '') === sid) return { ok: true, changed: false, target: sid, path: p };

  const next = { ...cfg, targetSession: sid };
  const body = JSON.stringify(next, null, 2) + '\n';
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, p);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, reason: `write-failed:${error?.message ?? error}`, path: p };
  }
  return { ok: true, changed: true, target: sid, path: p };
}
