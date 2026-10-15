// B 站登录态管理：① cookie jar 滑动续期 ② 失效时扫码续期（给桥接用）
//
// 为什么需要这个模块（2026-10-15 实测 + 借鉴 dsh-bili-scroll(MIT) 的 lib/login.mjs）：
//   1. **静态字符串必死**：把 SESSDATA 抄进配置，B 站给它一个固定 Expires（一般 ~30 天），
//      到点就失效 —— 这就是"每过一段时间都要重弄一次"的根因。
//   2. **B 站是滑动续期**：只要带着有效 cookie 请求，响应里常会再 `Set-Cookie` 一个新的
//      （过期时间往后推）。所以**把响应 cookie 存回 jar**（本模块的 absorb）就能长期存活。
//   3. **失效判据**：`GET /x/web-interface/nav` → `code=-101` / `data.isLogin=false`（实测）。
//   4. **续期接口**（扫码，无需手抄 cookie）：
//        GET  passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header → data.url + data.qrcode_key
//        GET  passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=…                → data.code
//             86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
//      ⭐ **凭证在轮询响应的 `Set-Cookie` 头里**，不在 `data.url` 里（那条 url 是别的域的游戏票）。
//
// 设计约束：
//   - **不引任何依赖**（只用 fetch / fs）—— 桥接跑在 Node 16+，不能为了 cookie 加依赖。
//   - `fetchImpl` 与 `now` 可注入，纯逻辑（parseSetCookie / mergeJar / cookieHeader）单独导出，便于离线回归。
//   - `summary()` **绝不返回 cookie 的值**（只给名字与过期时间），免得被日志/接口带出去。

import fs from 'node:fs';
import path from 'node:path';

export const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const URLS = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  spi: 'https://api.bilibili.com/x/frontend/finger/spi',
  qrGenerate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
  qrPoll: (key) => `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`
};

/** 我们要长期持有的那几个 cookie（其余也一并存，但不对外单列） */
const KEY_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4'];

/**
 * 解析一条 `Set-Cookie`。返回 { name, value, exp }（exp 为毫秒时间戳，0 = 会话级/无过期）。
 * 解析不出来返回 null。
 */
export function parseSetCookie(raw, now = Date.now()) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parts = text.split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  let exp = 0;
  let hasExpiry = false;
  for (const attr of parts) {
    const i = attr.indexOf('=');
    if (i <= 0) continue;
    const k = attr.slice(0, i).trim().toLowerCase();
    const v = attr.slice(i + 1).trim();
    if (k === 'max-age') {
      const secs = Number(v);
      if (Number.isFinite(secs)) { exp = now + secs * 1000; hasExpiry = true; }
    } else if (k === 'expires') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) { exp = t; hasExpiry = true; }
    }
  }
  // Max-Age 优先于 Expires（RFC 6265），下面若两者都有则以更早设置的为准：这里简单处理成"后写的赢"
  return { name, value, exp, hasExpiry };
}

/**
 * 把一批 Set-Cookie 合进 jar。jar 形状：{ [name]: { v: string, exp: number } }
 * 返回 { jar, changed }；changed=false 表示完全没变（调用方据此决定要不要落盘）。
 */
export function mergeJar(jar, setCookies, now = Date.now()) {
  const next = { ...(jar ?? {}) };
  let changed = false;
  for (const raw of setCookies ?? []) {
    const parsed = parseSetCookie(raw, now);
    if (!parsed) continue;
    const cur = next[parsed.name];
    // ⚠️ 必须用 hasExpiry 判断，不能只看 exp：B 站登出时发的是 `Expires=Thu, 01 Jan 1970`（解析出来正好是 0），
    // 而 0 在本模块里又是"会话级/无过期"的表示 —— 只看 exp 会把"删除"误判成"会话级"（离线回归抓到过）。
    if (parsed.hasExpiry && parsed.exp <= now) {
      if (cur) { delete next[parsed.name]; changed = true; }
      continue;
    }
    if (!cur || cur.v !== parsed.value || cur.exp !== parsed.exp) {
      next[parsed.name] = { v: parsed.value, exp: parsed.hasExpiry ? parsed.exp : 0 };
      changed = true;
    }
  }
  return { jar: next, changed };
}

/** 组装 Cookie 头（跳过已过期的）。没有可用 cookie 时返回空串。 */
export function cookieHeader(jar, now = Date.now()) {
  const out = [];
  for (const [name, item] of Object.entries(jar ?? {})) {
    if (!item || typeof item.v !== 'string' || !item.v) continue;
    if (item.exp && item.exp <= now) continue;
    out.push(`${name}=${item.v}`);
  }
  return out.join('; ');
}

/** 还剩多久过期（毫秒）；无过期返回 null */
export function expiresIn(jar, name, now = Date.now()) {
  const item = jar?.[name];
  if (!item) return null;
  if (!item.exp) return null;
  return item.exp - now;
}

/**
 * @param {object} opts
 * @param {string} opts.stateFile   存放 jar 的 json（应放在 state/ 下，gitignored）
 * @param {(msg:string)=>void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 */
export function createBiliAuth({ stateFile, log = () => {}, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let jar = {};
  let meta = { updatedAt: 0, lastCheckAt: 0, lastCheckOk: false, lastCheckCode: null, uname: '', mid: 0 };
  let lastStatusAt = 0;
  let lastStatus = null;

  function load() {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.jar && typeof parsed.jar === 'object') jar = parsed.jar;
        if (parsed.meta && typeof parsed.meta === 'object') meta = { ...meta, ...parsed.meta };
      }
      return true;
    } catch {
      return false;
    }
  }

  let saveTimer = null;
  /** 原子落盘（同目录临时文件 + rename）。多次调用合并到一次。 */
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const dir = path.dirname(stateFile);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ jar, meta }, null, 2), 'utf8');
        fs.renameSync(tmp, stateFile);
      } catch (error) {
        log(`⚠️ 写 B 站登录态失败：${error?.message ?? error}`);
      }
    }, 50);
    if (saveTimer.unref) saveTimer.unref();
  }

  /** 把响应里的 Set-Cookie 收进 jar（滑动续期的核心，见文件头第 2 条） */
  function absorb(res) {
    let list = [];
    try {
      if (typeof res?.headers?.getSetCookie === 'function') list = res.headers.getSetCookie();
      else {
        const single = res?.headers?.get?.('set-cookie');
        if (single) list = [single];
      }
    } catch { /* 忽略 */ }
    if (!list || !list.length) return false;
    const { jar: next, changed } = mergeJar(jar, list, now());
    if (!changed) return false;
    const before = jar.SESSDATA?.exp ?? 0;
    const beforeVal = jar.SESSDATA?.v ?? '';
    jar = next;
    meta.updatedAt = now();
    save();
    const after = jar.SESSDATA;
    if (after && (after.exp !== before || after.v !== beforeVal)) {
      const days = after.exp ? ((after.exp - now()) / 86400000).toFixed(1) : '会话级';
      log(`[bili-auth] SESSDATA 已续期（${days} 天后过期）`);
    }
    return true;
  }

  /** 带 cookie 的 fetch（并把响应 cookie 存回） */
  async function request(url, init = {}) {
    const headers = { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/', ...(init.headers ?? {}) };
    const header = cookieHeader(jar, now());
    if (header && !headers.Cookie && !headers.cookie) headers.Cookie = header;
    const res = await fetchImpl(url, { ...init, headers, redirect: init.redirect ?? 'manual' });
    absorb(res);
    return res;
  }

  /** 领一对匿名 buvid（没有登录也能拿，很多接口的风控判据） */
  async function ensureBuvid() {
    if (jar.buvid3?.v) return jar.buvid3.v;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // 这个接口偶尔会 302/抖动，跟随重定向 + 失败重试一次（2026-10-15 实测遇到过一次 fetch failed）
        const res = await request(URLS.spi, { headers: { Referer: 'https://www.bilibili.com/' }, redirect: 'follow' });
        const j = await res.json();
        const b3 = j?.data?.b_3;
        const b4 = j?.data?.b_4;
        const nowMs = now();
        const exp = nowMs + 86400 * 30 * 1000;
        if (b3) {
          jar.buvid3 = { v: b3, exp, hasExpiry: true };
          if (b4) jar.buvid4 = { v: b4, exp, hasExpiry: true };
          save();
          return b3;
        }
      } catch (error) {
        if (attempt === 1) log(`[bili-auth] 领 buvid 失败（重试后仍失败）：${error?.message ?? error}`);
      }
    }
    return '';
  }

  /** 是否登录（走 nav），缓存 5 分钟 */
  async function status({ force = false, cacheMs = 300000 } = {}) {
    if (!force && lastStatus && now() - lastStatusAt < cacheMs) return lastStatus;
    await ensureBuvid();
    let result = { loggedIn: false, code: null, uname: '', mid: 0, checkedAt: now() };
    try {
      const res = await request(URLS.nav);
      const j = await res.json();
      result = {
        loggedIn: j?.data?.isLogin === true,
        code: j?.code ?? null,
        uname: j?.data?.uname ?? '',
        mid: Number(j?.data?.mid) || 0,
        checkedAt: now()
      };
    } catch (error) {
      result = { loggedIn: false, code: 'fetch-error', uname: '', mid: 0, checkedAt: now(), error: String(error?.message ?? error) };
    }
    lastStatus = result;
    lastStatusAt = now();
    meta.lastCheckAt = result.checkedAt;
    meta.lastCheckOk = result.loggedIn;
    meta.lastCheckCode = result.code;
    if (result.uname) meta.uname = result.uname;
    if (result.mid) meta.mid = result.mid;
    save();
    return result;
  }

  /** ① 生成扫码登录用的二维码（返回 url 与 key，url 可直接丢给浏览器/二维码渲染） */
  async function startQrLogin() {
    const res = await request(URLS.qrGenerate, { redirect: 'manual' });
    const j = await res.json();
    const data = j?.data;
    if (!data?.qrcode_key || !data?.url) throw new Error(`生成二维码失败：${j?.message ?? '返回里没有 qrcode_key'}`);
    return { key: data.qrcode_key, url: data.url };
  }

  /** ② 轮询一次。state: waiting / scanned / ok / expired / unknown */
  async function pollQrLogin(key) {
    const res = await request(URLS.qrPoll(key), { redirect: 'manual' });
    let body = {};
    try { body = await res.json(); } catch { /* poll 有时空体 */ }
    const code = body?.data?.code;
    if (code === 0) {
      const has = !!jar.SESSDATA?.v;
      meta.updatedAt = now();
      save();
      if (!has) return { state: 'unknown', code, message: '登录成功但响应里没有 SESSDATA（记下来排查）' };
      const st = await status({ force: true });
      return { state: st.loggedIn ? 'ok' : 'unknown', code, message: st.loggedIn ? '' : '拿到 SESSDATA 但 nav 仍显示未登录', status: st };
    }
    const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' };
    return { state: map[code] ?? 'unknown', code, message: body?.message ?? '' };
  }

  /** ② 一直等到扫完（或超时） */
  async function waitQrLogin(key, { timeoutMs = 240000, intervalMs = 2000, onTick } = {}) {
    const start = now();
    let last = 'waiting';
    while (now() - start < timeoutMs) {
      const r = await pollQrLogin(key);
      if (r.state !== last) { last = r.state; onTick?.(r); }
      if (r.state === 'ok' || r.state === 'expired' || r.state === 'unknown') return r;
      await new Promise((r2) => setTimeout(r2, intervalMs));
    }
    return { state: 'timeout', code: null, message: `${Math.round(timeoutMs / 1000)}s 内没有扫码` };
  }

  /** 对外摘要：**绝不包含 cookie 的值** */
  function summary() {
    const cookies = KEY_COOKIES
      .filter((n) => jar[n])
      .map((n) => ({ name: n, expiresInHours: jar[n].exp ? Math.round((jar[n].exp - now()) / 3600000) : null }));
    return {
      loggedIn: lastStatus?.loggedIn === true,
      uname: meta.uname || '',
      mid: meta.mid || 0,
      cookieCount: Object.keys(jar).length,
      cookies,
      updatedAt: meta.updatedAt || 0,
      lastCheckAt: meta.lastCheckAt || 0,
      lastCheckCode: meta.lastCheckCode ?? null
    };
  }

  function clear() {
    jar = {};
    meta = { ...meta, updatedAt: now(), lastCheckOk: false };
    lastStatus = null;
    lastStatusAt = 0;
    save();
  }

  load();

  return { load, save, absorb, request, status, ensureBuvid, startQrLogin, pollQrLogin, waitQrLogin, summary, clear, _jar: () => jar };
}
