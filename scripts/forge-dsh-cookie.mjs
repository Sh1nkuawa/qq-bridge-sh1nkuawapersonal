// 用 DSH 持久 secret 自签浏览器会话 cookie，并写入桥接配置（免 launch token）
//
// 背景：DSH 0.1.5 的 launch token 是进程内随机生成、只在启动 URL 打印一次、不落盘，
// 所以 qq-bridge 的 guard 日志自动发现拿不到它。但签名 cookie 用的是
// ~/.dsh/.credentials.yaml 里「持久化」的 secret，重启 DSH 也不变。
// 因此可以本地自签一个合法 cookie 直接给桥接用，无需任何 DSH 输出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CRED = path.join(HOME, '.credentials.yaml');
const CFG = path.join(ROOT, 'config.json');

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

// ---- 1) 读持久 secret ----
if (!fs.existsSync(CRED)) {
  console.error(`[cookie] 找不到 ${CRED}`);
  process.exit(1);
}
let secret = null;
let inRecord = false;
for (const line of fs.readFileSync(CRED, 'utf8').split(/\r?\n/)) {
  if (/^\s{2}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue; }
  if (inRecord && /^\s{2}\S/.test(line)) break;
  if (inRecord) {
    const m = line.match(/^\s*secret:\s*(\S+)\s*$/);
    if (m) { secret = m[1]; break; }
  }
}
if (!secret) {
  console.error('[cookie] 没在 .credentials.yaml 里找到 client-connection/browser-session 的 secret');
  process.exit(1);
}
const secretBytes = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
console.log(`[cookie] secret 已读取（${secret.length} 字符 / ${secretBytes.length} 字节）`);

// ---- 2) 自签 cookie ----
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const baseUrl = String(cfg.dsh?.baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
const authority = new URL(baseUrl).host;
const cookieName = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest());

const DAYS = Number(process.env.QQ_BRIDGE_COOKIE_DAYS || 30);
const now = Date.now();
const payload = {
  version: 1,
  authority,
  issuedAt: now,
  expiresAt: now + DAYS * 24 * 3600 * 1000,
};
const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
const sig = b64u(createHmac('sha256', secretBytes).update(body).digest());
const cookie = `${cookieName}=v1.${body}.${sig}`;

console.log(`[cookie] authority = ${authority}，有效期 ${DAYS} 天`);

// ---- 3) 写入桥接配置 ----
cfg.dsh.authCookie = cookie;
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('[cookie] 已写入 config.json 的 dsh.authCookie');

// ---- 4) 实测 ----
let okStatus = null;
for (const ep of ['/api/agentPresets/list', '/api/settings/describe']) {
  try {
    const r = await fetch(baseUrl + ep, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    okStatus = r.status;
    console.log(`[cookie] 实测 POST ${ep} → HTTP ${r.status}`);
    if (r.status === 200) break;
  } catch (e) {
    console.log(`[cookie] 实测 ${ep} 失败: ${e.message}`);
  }
}
console.log(okStatus === 200 ? '[cookie] ✅ 认证有效' : '[cookie] ⚠️ 认证未通过，请检查 DSH 是否在运行');
