// 一次性工具：把本次改动分成几个有意义的提交（用 Node 调 git，避免 PowerShell 的编码坑）。用完即删。
// 用法：node scripts/_publish-commits.mjs [--dry]
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry');
const git = (args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const groups = [
  {
    msg: 'feat(admin): 群管理（禁言 + 群公告）\n\n- src/moderation.js：确定性判定（同内容重复/针对机器人的辱骂）、1~10 分钟阶梯、豁免与限流、公告校验、动作白名单\n- 只允许 set_group_ban 与 _send_group_notice 两个动作；踢人/全员禁言/群文件/群相册等在 FORBIDDEN_ACTIONS 里，并有单测扫描源码\n- 禁言默认干跑（dryRunUntil 到点自动生效）；禁言后在群里按人设说一句；执行/失败都私聊通知 owner\n- 群公告：起草 → owner 私聊回「通过」/控制台按钮 → 发布；发布失败保留草稿\n- owner 命令：/禁言 /解禁 /禁言记录 /公告 /公告通过 /公告拒绝\n- 文档 docs/MODERATION.md 与自检/探活脚本',
    files: [
      'src/moderation.js', 'docs/MODERATION.md',
      'scripts/test-moderation.mjs', 'scripts/test-admin-routes.mjs', 'scripts/test-owner-dm.mjs',
      'scripts/test-mute-live.mjs', 'scripts/probe-group-admin.mjs', 'scripts/probe-ban-plumbing.mjs',
      'scripts/set-admin-config.mjs', 'scripts/check-preset-admin-rules.mjs',
      'scripts/propose-notice.mjs', 'scripts/show-notice.mjs', 'docs/群公告-新版草稿.md'
    ]
  },
  {
    msg: 'feat(memes): 接入本地表情包库（dsh-meme 图库）\n\n- src/meme-lib.js：只读扫描 dsh-meme 的 SQLite 索引、情绪桶抽样、使用统计（避免复读）、路径越界防护\n- 新工具 qq_send_meme（search/view/send）；与 QQ 收藏表情分工\n- 控制台加「检测图库 / 发一张试试」；配置文件与控制台参数\n- 文档 docs/MEMES.md 与路由/提示注入自检',
    files: [
      'src/meme-lib.js', 'docs/MEMES.md',
      'scripts/test-memes.mjs', 'scripts/test-meme-routes.mjs', 'scripts/test-meme-prompt.mjs',
      'scripts/meme-flow-test.mjs', 'scripts/inspect-meme-pack.mjs', 'scripts/probe-bridge.mjs'
    ]
  },
  {
    msg: 'feat(image): 生图回执、失败状态口径与「引用自己发的图」改图\n\n- src/image-ack.js：@我+生图 的文本识别（受理闸门与群内即时回执共用一套）+ 请求级去重 + 从最近 @ 里挑真正那条请求\n- src/persona-lines.js：禁言播报与生图回执的文案模板池（人设口吻、不带脏字、owner 无限次时自动去掉剩余次数）\n- 桥接：受理即回执、失败写 imageFail 并在唤醒提示里明确「已失败，别再说正在画」、worker 上报 sentImage（本地持久副本，支持引用自己发的图改图）、本地原图丢了直接报错不烧 codex\n- worker 失败回执分类真实原因（没拿到参考图/网络/超时/被拒）\n- 诊断工具：check-braces / trace-depth / find-syntax-error / show-recent',
    files: [
      'src/image-ack.js', 'src/persona-lines.js', 'scripts/gen-image-worker.mjs',
      'scripts/test-image-ack.mjs', 'scripts/test-image-state.mjs', 'scripts/test-persona-lines.mjs',
      'scripts/check-braces.mjs', 'scripts/trace-depth.mjs', 'scripts/find-syntax-error.mjs', 'scripts/show-recent.mjs'
    ]
  },
  {
    msg: 'feat(affinity,feed): 好感度（关系）系统与投喂核验\n\n- src/affinity.js：确定性打分、±6 日上限、闲置衰减、档位→称呼+语气；只注入在场成员，不对外公布数值\n- src/feed.js：爱发电订单核验、去重记账、余额水位提醒、订单号脱敏\n- 相关运维脚本与单测、docs/AFFINITY.md、docs/FEED.md',
    files: [
      'src/affinity.js', 'src/feed.js', 'docs/AFFINITY.md', 'docs/FEED.md',
      'scripts/test-affinity.mjs', 'scripts/test-feed.mjs', 'scripts/affinity-admin.mjs',
      'scripts/affinity-file-admin.mjs', 'scripts/affinity-report.mjs', 'scripts/feed-admin.mjs',
      'scripts/probe-affinity-prompt.mjs', 'scripts/probe-afdian.mjs', 'scripts/probe-balance-tool.mjs'
    ]
  },
  {
    msg: 'chore(publish): 署名声明、发布前体检与个人信息脱敏\n\n- NOTICE.md：原作者 Derpyu520、上游仓库、基于 v0.1.5/dea3ce8、许可证状态与免责声明\n- README 顶部加「个人衍生副本」署名块\n- scripts/preflight-publish.mjs：提交前扫描真实凭据与个人信息\n- scripts/redact-personal.mjs：按映射表（state/personal-ids.json，已被 gitignore）把群号/QQ/昵称/本机用户名替换成占位符；脚本自身不含真实 ID',
    files: ['NOTICE.md', 'README.md', 'scripts/preflight-publish.mjs', 'scripts/redact-personal.mjs']
  }
];

for (const g of groups) {
  const existing = g.files.filter((f) => {
    try { execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd: process.cwd(), stdio: 'ignore' }); return true; } catch { return false; }
  });
  if (DRY) { console.log(`\n[dry] ${g.msg.split('\n')[0]}  → ${g.files.length} 个文件`); continue; }
  if (g.files.length) git(['add', '--', ...g.files]);
  try {
    git(['commit', '-m', g.msg]);
    console.log(`✅ ${g.msg.split('\n')[0]}（${g.files.length} 个文件${existing.length ? `，其中 ${existing.length} 个是已跟踪文件的修改` : ''}）`);
  } catch (error) {
    console.log(`⚠️ 提交失败：${g.msg.split('\n')[0]} → ${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`);
  }
}

if (!DRY) {
  // 剩下的（控制台、bridge、MCP、预设、人设、其它脚本）一起提交
  git(['add', '-A']);
  try {
    git(['commit', '-m', 'feat(bridge,console,preset): 群管理/表情包/生图的接线与文档\n\n- src/bridge.js：群管理钩子、表情包路由、生图回执与失败状态、owner 私聊审批、recentMentions、请求拒绝日志\n- src/mcp-snowluma-safe.js：qq_send_meme / qq_group_admin_info / qq_request_mute / qq_propose_announcement\n- public/console.html：群管理面板 + memes 参数区\n- dsh/agent-presets/qq-chat-v2：规则 26.1 / 29.3.1 / 29.6.1 / 32.x（群管理与生图口径）\n- roles/小鲸鱼.md：第十三节群管理；RULES.md 4.1；config.example.json；INSTALL_NOTES.md 运维笔记\n- 其余运维/探活脚本']);
    console.log('✅ 接线与文档（剩余全部）');
  } catch (error) {
    console.log(`⚠️ 最后一次提交失败：${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`);
  }
}
console.log('\n--- git log ---');
console.log(git(['log', '--oneline', '-8']));
console.log('--- 剩余未提交 ---');
console.log(git(['status', '--porcelain']) || '（工作区干净）');
