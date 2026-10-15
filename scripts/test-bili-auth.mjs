// B 站登录态（cookie jar 滑动续期 + 扫码续期）的离线回归。
// 全程不联网：fetch 用假的，状态文件落在系统临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cookieHeader, createBiliAuth, expiresIn, mergeJar, parseSetCookie } from '../src/bili-auth.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };
const okAsync = async (name, fn) => { await fn(); n++; console.log(`  ✅ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('cookie 解析与合并（纯逻辑）：');

ok('parseSetCookie：基本形式', () => {
  const c = parseSetCookie('SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com; HttpOnly', 1000);
  assert.equal(c.name, 'SESSDATA');
  assert.equal(c.value, 'abc%2Cdef');
  assert.equal(c.exp, 0, '没有 Expires/Max-Age 就是会话级');
});

ok('parseSetCookie：Expires 与 Max-Age（Max-Age 后写覆盖）', () => {
  const exp = new Date(2000).toUTCString();
  assert.equal(parseSetCookie(`a=1; Expires=${exp}`, 1000).exp, 2000);
  assert.equal(parseSetCookie('a=1; Max-Age=60', 1000).exp, 61000);
  assert.equal(parseSetCookie('a=1; Expires=Wed, 01 Jan 3000 00:00:00 GMT; Max-Age=60', 1000).exp, 61000);
});

ok('parseSetCookie：坏输入返回 null', () => {
  for (const bad of ['', 'no-equals', '=nokey', null, undefined]) assert.equal(parseSetCookie(bad, 1000), null);
});

ok('mergeJar：新增 / 更新 / 过期删除 / changed 标记', () => {
  const now = 1_000_000;
  const r1 = mergeJar({}, ['SESSDATA=v1; Max-Age=3600', 'bili_jct=j1; Max-Age=3600'], now);
  assert.equal(r1.changed, true);
  assert.equal(r1.jar.SESSDATA.v, 'v1');
  assert.equal(r1.jar.SESSDATA.exp, now + 3600_000);
  // 同样的内容再来一次 → 不应报 changed（避免无意义落盘）
  const r2 = mergeJar(r1.jar, ['SESSDATA=v1; Max-Age=3600'], now);
  assert.equal(r2.changed, false);
  // 值变了 → changed
  const r3 = mergeJar(r1.jar, ['SESSDATA=v2; Max-Age=3600'], now);
  assert.equal(r3.changed, true);
  assert.equal(r3.jar.SESSDATA.v, 'v2');
  // 过去的 Expires = 删除
  const r4 = mergeJar(r3.jar, ['SESSDATA=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], now);
  assert.equal(r4.jar.SESSDATA, undefined);
  assert.equal(r4.changed, true);
});

ok('cookieHeader / expiresIn：跳过已过期', () => {
  const jar = { a: { v: '1', exp: 0 }, b: { v: '2', exp: 500 } };
  assert.equal(cookieHeader(jar, 1000), 'a=1');
  assert.equal(expiresIn(jar, 'b', 400), 100);
  assert.equal(expiresIn(jar, 'a', 400), null, '会话级没有过期时间');
});

console.log('\n① 滑动续期（核心：把响应 cookie 存回 jar）：');

/** 造一个假的 fetch 响应 */
const fakeRes = (body, setCookies = []) => ({
  json: async () => body,
  headers: { getSetCookie: () => setCookies, get: () => setCookies[0] }
});

await okAsync('nav 的 Set-Cookie 会把 SESSDATA 续到新过期时间，并写回磁盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-auth-'));
  const file = path.join(dir, 'bili-auth.json');
  const later = new Date(Date.now() + 30 * 86400_000).toUTCString();
  let navCalls = 0;
  const auth = createBiliAuth({
    stateFile: file,
    log: () => {},
    fetchImpl: async (url) => {
      if (String(url).includes('/x/frontend/finger/spi')) return fakeRes({ data: { b_3: 'B3', b_4: 'B4' } });
      if (String(url).includes('/x/web-interface/nav')) {
        navCalls += 1;
        // 第一次：未登录（也顺手给一个短命 SESSDATA）；第二次：已登录 + 续期到 30 天后
        if (navCalls === 1) return fakeRes({ code: -101, data: { isLogin: false } }, ['SESSDATA=short; Max-Age=60']);
        return fakeRes({ code: 0, data: { isLogin: true, uname: '测试号', mid: 123 } }, [`SESSDATA=long; Expires=${later}`]);
      }
      return fakeRes({ code: -404 });
    }
  });

  const first = await auth.status({ force: true });
  assert.equal(first.loggedIn, false);
  assert.equal(first.code, -101);
  assert.equal(auth._jar().SESSDATA.v, 'short');

  const second = await auth.status({ force: true });
  assert.equal(second.loggedIn, true);
  assert.equal(second.uname, '测试号');
  assert.equal(auth._jar().SESSDATA.v, 'long', '响应里的新 SESSDATA 必须覆盖旧的');
  const days = expiresIn(auth._jar(), 'SESSDATA') / 86400_000;
  assert.ok(days > 29 && days < 31, `过期时间应被推到 ~30 天后，实际 ${days.toFixed(1)} 天`);

  await sleep(150);   // 等防抖落盘
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.jar.SESSDATA.v, 'long', '必须写回磁盘（否则重启就丢续期成果）');
  assert.equal(saved.meta.uname, '测试号');
  fs.rmSync(dir, { recursive: true, force: true });
});

await okAsync('未登录时 ensureBuvid 会补匿名指纹', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-auth-'));
  const auth = createBiliAuth({
    stateFile: path.join(dir, 'x.json'),
    log: () => {},
    fetchImpl: async (url) => (String(url).includes('finger/spi') ? fakeRes({ data: { b_3: 'BB3' } }) : fakeRes({ code: -101, data: {} }))
  });
  const b3 = await auth.ensureBuvid();
  assert.equal(b3, 'BB3');
  assert.equal(auth._jar().buvid3.v, 'BB3');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n② 扫码续期（含"凭证在响应头里"这个坑）：');

await okAsync('generate → 轮询 86101/86090 → 0，且从 Set-Cookie 抓到 SESSDATA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-auth-'));
  const file = path.join(dir, 'bili-auth.json');
  let polls = 0;
  const auth = createBiliAuth({
    stateFile: file,
    log: () => {},
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('qrcode/generate')) return fakeRes({ code: 0, data: { qrcode_key: 'KEY123', url: 'https://account.bilibili.com/h5/...' } });
      if (u.includes('qrcode/poll')) {
        polls += 1;
        if (polls === 1) return fakeRes({ code: 0, data: { code: 86101 } });
        if (polls === 2) return fakeRes({ code: 0, data: { code: 86090 } });
        // 成功：★ 凭证只在 Set-Cookie 里，body 的 data.url 里没有
        return fakeRes({ code: 0, data: { code: 0, url: 'https://passport.biligame.com/...' } }, ['SESSDATA=OKSESS; Max-Age=2592000', 'bili_jct=OKJCT; Max-Age=2592000', 'DedeUserID=42; Max-Age=2592000']);
      }
      if (u.includes('/x/web-interface/nav')) return fakeRes({ code: 0, data: { isLogin: true, uname: '扫码号', mid: 42 } });
      return fakeRes({ code: -404 });
    }
  });

  const { key, url } = await auth.startQrLogin();
  assert.equal(key, 'KEY123');
  assert.ok(url.includes('account.bilibili.com'));
  const r = await auth.waitQrLogin(key, { timeoutMs: 5000, intervalMs: 5, onTick: () => {} });
  assert.equal(r.state, 'ok', '扫码成功后应为 ok');
  assert.equal(auth._jar().SESSDATA.v, 'OKSESS', '★ 必须从响应头里拿到 SESSDATA（data.url 里那个是别的域的游戏票）');
  assert.equal(auth._jar().bili_jct.v, 'OKJCT');
  fs.rmSync(dir, { recursive: true, force: true });
});

await okAsync('二维码过期（86038）与超时都能识别', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-auth-'));
  const auth = createBiliAuth({
    stateFile: path.join(dir, 'x.json'),
    log: () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('qrcode/generate')) return fakeRes({ data: { qrcode_key: 'K', url: 'u' } });
      if (u.includes('qrcode/poll')) return fakeRes({ code: 0, data: { code: 86038 } });
      return fakeRes({ code: -101, data: {} });
    }
  });
  await auth.startQrLogin();
  const r = await auth.waitQrLogin('K', { timeoutMs: 5000, intervalMs: 5 });
  assert.equal(r.state, 'expired');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n安全与接线：');

ok('summary() 绝不能泄漏 cookie 的值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-auth-'));
  const auth = createBiliAuth({ stateFile: path.join(dir, 'x.json'), log: () => {} });
  auth._jar().SESSDATA = { v: 'SUPER-SECRET-VALUE', exp: Date.now() + 86400_000 };
  const text = JSON.stringify(auth.summary());
  assert.ok(!text.includes('SUPER-SECRET-VALUE'), '摘要里不能出现 cookie 值');
  assert.ok(text.includes('SESSDATA'), '但可以出现名字');
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('源码守卫：桥接接线 + 出处署名都在', () => {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const auth = fs.readFileSync(path.join(root, 'src', 'bili-auth.js'), 'utf8');
  assert.match(auth, /dsh-bili-scroll/, '必须写明借鉴来源');
  assert.match(auth, /MIT/, '必须写明许可');
  assert.match(auth, /qrcode\/poll/, '扫码轮询接口');
  assert.match(auth, /Set-Cookie/, '必须记录"凭证在响应头里"这个结论');
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /createBiliAuth/, 'bridge 必须实例化它');
  assert.match(bridge, /bili-auth\.json/, '状态文件必须落在 state/ 下');
  assert.match(bridge, /\/api\/bili\/status/, '要有状态查询接口');
  assert.match(bridge, /biliLoginQrPending|startQrLogin/, '要有扫码续期入口');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'bili-login.mjs')), 'CLI 必须存在');
});

console.log(`\n全部通过：${n} 项断言组`);
