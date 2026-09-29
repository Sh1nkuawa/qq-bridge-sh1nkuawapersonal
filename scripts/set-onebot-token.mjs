// 把 SnowLuma 的 OneBot HTTP/WS accessToken 统一设为指定令牌，并同步给两个机器人
// 用法: node scripts/set-onebot-token.mjs "你的令牌"
// 说明：令牌**必须**从命令行参数或环境变量 `ONEBOT_TOKEN` 传入，不要写进这个文件
//      （这是会进版本库的脚本，硬编码令牌＝把令牌公开）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SL_DIR = process.env.SNOWLUMA_CONFIG_DIR || 'D:/dsh/snowluma/config';
const TOKEN = String(process.argv[2] || process.env.ONEBOT_TOKEN || '').trim();
if (!TOKEN) {
  console.error('[token] 缺少令牌。用法：node scripts/set-onebot-token.mjs "你的令牌"（或用环境变量 ONEBOT_TOKEN）');
  process.exit(1);
}

const file = fs.readdirSync(SL_DIR).find((f) => /^onebot_\d+\.json$/.test(f));
if (!file) { console.error('[token] 没找到 onebot_*.json（先在 SnowLuma WebUI 里配好 OneBot）'); process.exit(1); }
const p = path.join(SL_DIR, file);
const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));

const mask = (t) => (t ? `${t.slice(0, 3)}***(${t.length})` : '(空)');
console.log('[token] 修改前: WS=' + mask(cfg.networks?.wsServers?.[0]?.accessToken)
  + '  HTTP=' + mask(cfg.networks?.httpServers?.[0]?.accessToken));

for (const s of cfg.networks?.wsServers ?? []) s.accessToken = TOKEN;
for (const s of cfg.networks?.httpServers ?? []) s.accessToken = TOKEN;

if (!fs.existsSync(p + '.bak2')) fs.copyFileSync(p, p + '.bak2');
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('[token] 已写入 SnowLuma:', path.basename(p), '→ WS/HTTP 均设为 ' + mask(TOKEN));

// 同步到桥接（WS + HTTP 同值，所以两个字段都填）
const bPath = path.join(ROOT, 'config.json');
const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
b.snowluma.accessToken = TOKEN;
b.snowluma.httpToken = TOKEN;
fs.writeFileSync(bPath, JSON.stringify(b, null, 2) + '\n', 'utf8');
console.log('[token] 已同步 qq-bridge/config.json（accessToken + httpToken）');

// 同步到卡图机器人
const cPath = 'D:/dsh/sts2-emoji/bot/config.json';
if (fs.existsSync(cPath)) {
  const c = JSON.parse(fs.readFileSync(cPath, 'utf8'));
  c.access_token = TOKEN;
  fs.writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n', 'utf8');
  console.log('[token] 已同步 sts2-emoji/bot/config.json');
}

console.log('\n[token] 注意：SnowLuma 把配置缓存在内存里，需要在 WebUI 里点一次「保存/应用」'
  + '（或重启 SnowLuma）才对新连接生效。');
console.log('[token] 验证：node scripts/sync-onebot-tokens.mjs');
