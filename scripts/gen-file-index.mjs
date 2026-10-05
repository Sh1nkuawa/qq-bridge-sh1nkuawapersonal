// gen-file-index.mjs —— 生成 docs/FILE_INDEX.md：**每个被跟踪文件干什么**，一句话。
//
// 为什么要有这个
//   仓库里有 270+ 个文件，docs/FOLDER_MAP.md 只说明到「目录级 + scripts/ 前缀约定」这一层
//   （逐文件点名率约 23%），剩下 100 多个文件在任何文档里都找不到名字。
//   但本仓库的代码文件**几乎全部**在开头写了"这个文件干什么"，所以这份索引可以**自动生成**，
//   不需要人肉维护 —— 关键是别让它烂掉，于是提供 --check（漂移就退出 1，可挂进回归）。
//
// 作用一列的来源（诚实标注，绝不编）
//   1) 「文件自带」：取文件开头的说明性注释 / markdown 首个标题 / html title；
//   2) 「人工补写」：本文件底部的 OVERLAY 表（给没有注释的 json/png/许可证之类补一句）；
//   3) 「（无注释，待补）」：以上都没有 —— 如实留白，等人补，而不是猜。
//
// 用法
//   node scripts/gen-file-index.mjs            # 写入 docs/FILE_INDEX.md
//   node scripts/gen-file-index.mjs --check    # 只比对，不一致则打印差异并以 1 退出
//   node scripts/gen-file-index.mjs --stdout   # 打到标准输出（不落盘）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'FILE_INDEX.md');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const STDOUT = argv.includes('--stdout');

// ── 手工补写：给没有注释的文件一句话（有注释的一律以文件自身为准）──────────────
const OVERLAY = {
  'config.example.json': '运行配置模板（真实 config.json 不入库）。每一项的语义见 README「配置」一节',
  'package.json': '包定义与 npm 脚本入口（test:*/verify:*/probe:*/postinstall 都在这里）',
  'package-lock.json': '依赖锁定（npm 生成，别手改）',
  '.npmrc': 'npm 行为设置（本仓库用于安装源/缓存相关开关）',
  '.gitignore': '忽略清单：config.json / state/ / audio/ / node_modules 等本机数据与依赖',
  'LICENSE': 'MIT 许可证正文',
  'NOTICE.md': '第三方组件与许可声明（含 SnowLuma EULA 相关的合规说明）',
  '_snowluma-catalog.json': 'SnowLuma 上游接口/事件目录快照（对照用）',
  'assets/deepseek娘.png': '仓库用的形象图资源（README/文档引用）',
  'roles/README.md': '人格卡目录说明与写法约定',
  'dsh/README.md': '要装进 DSH 的东西（preset / MCP 白名单 / skill）的说明',
  'dsh/skills/codex-image/SKILL.md': '生图技能说明（Codex CLI 出图，走 owner 的 ChatGPT 订阅，无需 API key）',
  'dsh/skills/codex-image/scripts/codex-image.ps1': '生图技能实现：调 codex exec 生成图片并拷到指定路径（自动探测系统代理）',
  'public/console.html': '桥接自带控制台前端（127.0.0.1:3100）：设置、状态、二代会话面板、语音试发等',
  'watchdog.cmd': '外部看门狗启动器（双击即用；必须住在桥接进程外，见 FOLDER_MAP / INSTALL_NOTES 16.4）',
  'start.bat': '桥接守护启动器：先收紧 state/ 权限，再在 :loop 里跑 bridge.js，退出 5 秒后自动重启',
  'restart.bat': '先杀旧守护窗口与旧桥接（按锁文件 PID + 命令行兜底），确认退出后再拉起守护窗口',
  // 没有注释的脚本 / 基线文件（逐个确认过用途后补写）
  'scripts/make-config.mjs': '从 config.example.json 生成 config.json（已存在则跳过、绝不覆盖）',
  'scripts/console-ui-contracts.json': '控制台 UI 契约基线（npm run test:console-ui 用；只有后端契约真变时才重录）',
  'scripts/console-ui-legacy-ids.json': '控制台历史元素 id 清单（回归用：确保老 id 没被悄悄删掉）',
  'scripts/test-audit-bridge.mjs': 'test-audit 子模块：桥接行为审计（跑在 audit-bridge-harness 的虚拟网关上）',
  'scripts/test-audit-protocol-helpers.mjs': 'test-audit 子模块：协议审计的公共辅助函数',
  'scripts/test-qq-model-view.mjs': '端到端用例：确认模型侧看到的 QQ 工具清单/会话视图符合预期（在 npm run test:token 里）',
  'src/core/session-router.test.mjs': 'src/core/session-router.mjs 的单测',
};

/** 取文件开头第一句"这个文件干什么"。返回 { text, source }。 */
function extractPurpose(file) {
  const rel = file.split(path.sep).join('/');
  if (OVERLAY[rel]) return { text: OVERLAY[rel], source: '人工补写' };
  const ext = path.extname(rel).toLowerCase();
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, ''); } catch { return { text: '', source: '（读不出内容）' }; }
  const lines = text.split(/\r?\n/);

  const clean = (s) => s
    .replace(/^\s*(\/\/\/?|\/\*+|\*+\/?|#+|<!--|-->|rem\s+|::\s*)/i, '')
    .replace(/\*\/\s*$/, '')
    .trim();

  if (ext === '.json') {
    // JSON 没有注释，但本仓库用 `_comment` / `description` 字段自我说明（config.example / 插件包 / 规则模板）
    try {
      const j = JSON.parse(text);
      const t = j?._comment ?? j?.description ?? j?.desc;
      if (typeof t === 'string' && t.trim()) return { text: t.trim().slice(0, 200), source: '文件自带（JSON 字段）' };
    } catch { /* 解析不了就当没说明 */ }
    return { text: '', source: '（无注释，待补）' };
  }
  if (ext === '.md') {
    const h = lines.find((l) => /^#\s+\S/.test(l));
    if (h) return { text: clean(h), source: '文件自带（标题）' };
    const p = lines.find((l) => l.trim() && !/^[-|>]/.test(l.trim()));
    if (p) return { text: p.trim().slice(0, 120), source: '文件自带（正文首句）' };
    return { text: '', source: '（无注释，待补）' };
  }
  if (ext === '.html' || ext === '.htm') {
    const t = /<title>([^<]+)<\/title>/i.exec(text);
    if (t) return { text: t[1].trim(), source: '文件自带（title）' };
    const c = /<!--([\s\S]{0,200}?)-->/.exec(text);
    if (c) return { text: clean(c[1].split('\n')[0]), source: '文件自带（注释）' };
    return { text: '', source: '（无注释，待补）' };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.mp4', '.webp'].includes(ext)) {
    return { text: '', source: '（二进制资源，待补）' };
  }

  // 代码 / 配置 / 脚本：找开头的说明性注释（跳过 shebang、eslint、@ts-、编码声明）
  for (const raw of lines.slice(0, 40)) {
    const s = clean(raw);
    if (!s) continue;
    if (/^(#!|eslint|@ts-|-\*-|coding[:=]|chcp|@echo)/i.test(s)) continue;
    if (/^[{}[\]();,]/.test(s)) break;          // 已经进入正文
    if (/^(import|export|const|let|var|function|class|await|async|require\()/.test(s)) break;
    if (s.length < 4) continue;
    return { text: s.slice(0, 120), source: '文件自带' };
  }
  return { text: '', source: '（无注释，待补）' };
}

function build() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const files = (r.stdout || '').split('\0').filter(Boolean)
    .filter((f) => !f.startsWith('node_modules/'))
    .sort();

  const rows = files.map((f) => ({ file: f, ...extractPurpose(f) }));
  const groups = new Map();
  for (const row of rows) {
    const dir = path.dirname(row.file) === '.' ? '（仓库根）' : path.dirname(row.file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(row);
  }
  const stats = {
    total: rows.length,
    auto: rows.filter((x) => x.source.startsWith('文件自带')).length,
    manual: rows.filter((x) => x.source === '人工补写').length,
    missing: rows.filter((x) => x.source.includes('待补') || x.source.includes('读不出')).length,
  };

  const out = [];
  out.push('# 文件索引（FILE_INDEX）');
  out.push('');
  out.push('> **本文件由脚本生成，不要手改**：`node scripts/gen-file-index.mjs`（`npm run docs:file-index`）。');
  out.push('> 漂移检查：`node scripts/gen-file-index.mjs --check`（不一致时退出 1，可挂进回归）。');
  out.push('>');
  out.push('> 「作用」一列优先取**文件自己的开头注释**（`文件自带`）；没有注释的由生成器内置表补写（`人工补写`）；');
  out.push('> 两者都没有就如实写「（无注释，待补）」——**不猜内容**。目录级/前缀级的说明见 [FOLDER_MAP.md](FOLDER_MAP.md)。');
  out.push('');
  out.push(`统计：共 **${stats.total}** 个被跟踪文件 —— 文件自带说明 **${stats.auto}**、人工补写 **${stats.manual}**、待补 **${stats.missing}**。`);
  out.push('');
  for (const [dir, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`## ${dir}`);
    out.push('');
    out.push('| 文件 | 作用 | 来源 |');
    out.push('| --- | --- | --- |');
    for (const row of list.sort((a, b) => a.file.localeCompare(b.file))) {
      const link = `[\`${path.basename(row.file)}\`](../${row.file.split(path.sep).join('/')})`;
      const desc = (row.text || '—').replace(/\|/g, '\\|');
      out.push(`| ${link} | ${desc} | ${row.source} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

const text = build();
if (STDOUT) {
  process.stdout.write(text);
  process.exit(0);
}
if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur === text) { console.log('✅ docs/FILE_INDEX.md 与当前仓库一致'); process.exit(0); }
  const a = cur.split('\n'); const b = text.split('\n');
  console.error('❌ docs/FILE_INDEX.md 已过期（重跑 node scripts/gen-file-index.mjs）');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { console.error(`   第一处差异在第 ${i + 1} 行:\n   - 现状: ${a[i] ?? '(无)'}\n   + 应为: ${b[i] ?? '(无)'}`); break; }
  }
  console.error(`   （行数 现状 ${a.length} / 应为 ${b.length}）`);
  process.exit(1);
}
fs.writeFileSync(OUT, text, 'utf8');
console.log(`✅ 已写入 docs/FILE_INDEX.md（${text.split('\n').length} 行）`);
