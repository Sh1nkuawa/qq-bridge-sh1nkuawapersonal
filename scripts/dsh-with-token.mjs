// 启动 DSH 并自动捕获 launch token 写入 config.json
// 用法：node scripts/dsh-with-token.mjs [端口]
// 说明：DSH 0.1.5 的 launch token 是进程内随机生成、只在启动 URL 里打印一次、不落盘，
//       所以 qq-bridge 的 guard 日志自动发现拿不到它。这里由包装进程代读 stdout 并写入配置。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'config.json');
const PORT = process.argv[2] || '3080';

const dshBin = path.join(
  path.dirname(process.execPath), 'node_global', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
);
if (!fs.existsSync(dshBin)) {
  console.error(`[token] 找不到 DSH 入口：${dshBin}`);
  process.exit(1);
}

console.log(`[token] 启动 DSH: node ${dshBin} web --no-open --port ${PORT}`);
const child = spawn(process.execPath, [dshBin, 'web', '--no-open', '--port', PORT], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let captured = false;

function scan(text) {
  process.stdout.write(text);
  if (captured) return;
  // 匹配启动 URL 里的 ?token=XXX（token 为 base64url）
  const m = text.match(/[?&]token=([A-Za-z0-9_-]{16,})/);
  if (!m) return;
  const token = m[1];
  captured = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    cfg.dsh.authToken = token;
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log(`\n[token] ✅ 已写入 config.json：dsh.authToken = ${token.slice(0, 12)}…（长度 ${token.length}）`);
    console.log('[token] 现在可以另开窗口运行：npm start');
  } catch (e) {
    console.error(`\n[token] 写入 config.json 失败：${e.message}`);
  }
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', scan);
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(d));

child.on('exit', (code) => {
  if (!captured) {
    console.error('\n[token] DSH 退出前没抓到 token。');
    console.error('        可在 DSH 启动输出里找 http://127.0.0.1:%s/?token=... 手动填进 config.json', PORT);
  }
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
