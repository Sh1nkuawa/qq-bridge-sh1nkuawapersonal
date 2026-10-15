#!/usr/bin/env node
// B 站登录态 CLI（给桥接的扫码续期铺路，也可以手动跑）
//
//   node scripts/bili-login.mjs              # 生成二维码并等扫码（默认 240 秒）
//   node scripts/bili-login.mjs --status     # 只看当前登录态（不发码）
//   node scripts/bili-login.mjs --png        # 顺手尝试用 venv 的 python qrcode 画一张 PNG
//   node scripts/bili-login.mjs --clear      # 清掉本地登录态
//
// 返回码：0 成功/已登录；1 未登录或失败
// ⚠️ 全程不用 `process.exit()`：有挂起句柄时它会在 Windows 上触发
//    `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 崩溃
//    （仓库里 test-vision-media.mjs 踩过同一个坑）—— 统一用 process.exitCode。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBiliAuth } from '../src/bili-auth.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_FILE = path.join(ROOT, 'state', 'bili-auth.json');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const auth = createBiliAuth({ stateFile: STATE_FILE, log: (m) => console.log('  ' + m) });

async function main() {
  if (has('--clear')) {
    auth.clear();
    await sleep(150);                     // 等防抖落盘
    console.log('已清空 ' + STATE_FILE);
    return 0;
  }

  if (has('--status')) {
    const st = await auth.status({ force: true });
    console.log(st.loggedIn
      ? `已登录：${st.uname || '(未知)'}（mid ${st.mid || '?'}）`
      : `未登录（nav code=${st.code}${st.error ? ' ' + st.error : ''}）`);
    console.log('  摘要：' + JSON.stringify(auth.summary()));
    return st.loggedIn ? 0 : 1;
  }

  console.log('① 生成二维码…');
  const { key, url } = await auth.startQrLogin();
  console.log('  URL: ' + url);
  console.log('  key: ' + key);
  console.log('  （手机 B 站 App 扫码；二维码约 3 分钟有效）');

  if (has('--png')) {
    const venvPy = path.join(ROOT, 'state', 'asr-venv', 'Scripts', 'python.exe');
    const py = fs.existsSync(venvPy) ? venvPy : 'python';
    const png = path.join(ROOT, 'state', 'bili-login-qr.png');
    const r = spawnSync(py, ['-c', 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])', url, png], { encoding: 'utf8', timeout: 60000 });
    if (r.status === 0 && fs.existsSync(png)) console.log('  ✔ 二维码 PNG：' + png);
    else console.log('  （画 PNG 失败：' + String(r.stderr || r.error?.message || '').trim().split('\n').slice(-1)[0] + ' —— 直接用上面的 URL 也行）');
  }

  console.log('② 等扫码…');
  const result = await auth.waitQrLogin(key, {
    timeoutMs: 240000,
    onTick: (r) => {
      const text = { waiting: '  等待扫码…', scanned: '  已扫码，请在手机上确认', expired: '  二维码过期了', ok: '  登录成功 ✓' }[r.state];
      if (text) console.log(text);
    }
  });

  console.log('  结果：' + result.state + (result.message ? '（' + result.message + '）' : ''));
  if (result.state !== 'ok') return 1;
  console.log('  摘要：' + JSON.stringify(auth.summary()));
  console.log('  ✔ 登录态已存到 ' + STATE_FILE + '（之后靠滑动续期自动保活）');
  return 0;
}

process.exitCode = await main();
