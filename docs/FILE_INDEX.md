# 文件索引（FILE_INDEX）

> **本文件由脚本生成，不要手改**：`node scripts/gen-file-index.mjs`（`npm run docs:file-index`）。
> 漂移检查：`node scripts/gen-file-index.mjs --check`（不一致时退出 1，可挂进回归）。
>
> 「作用」一列优先取**文件自己的开头注释**（`文件自带`）；没有注释的由生成器内置表补写（`人工补写`）；
> 两者都没有就如实写「（无注释，待补）」——**不猜内容**。目录级/前缀级的说明见 [FOLDER_MAP.md](FOLDER_MAP.md)。

统计：共 **272** 个被跟踪文件 —— 文件自带说明 **249**、人工补写 **23**、待补 **0**。

## （仓库根）

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`_snowluma-catalog.json`](../_snowluma-catalog.json) | SnowLuma 上游接口/事件目录快照（对照用） | 人工补写 |
| [`.gitignore`](../.gitignore) | 忽略清单：config.json / state/ / audio/ / node_modules 等本机数据与依赖 | 人工补写 |
| [`.npmrc`](../.npmrc) | npm 行为设置（本仓库用于安装源/缓存相关开关） | 人工补写 |
| [`群公告.md`](../群公告.md) | 【小鲸鱼使用说明】持续更新 | 文件自带（正文首句） |
| [`config.example.json`](../config.example.json) | 运行配置模板（真实 config.json 不入库）。每一项的语义见 README「配置」一节 | 人工补写 |
| [`INSTALL_NOTES.md`](../INSTALL_NOTES.md) | qq-bridge 安装记录（本机 D:\dsh\qq-bridge） | 文件自带（标题） |
| [`LICENSE`](../LICENSE) | MIT 许可证正文 | 人工补写 |
| [`NOTICE.md`](../NOTICE.md) | 第三方组件与许可声明（含 SnowLuma EULA 相关的合规说明） | 人工补写 |
| [`package-lock.json`](../package-lock.json) | 依赖锁定（npm 生成，别手改） | 人工补写 |
| [`package.json`](../package.json) | 包定义与 npm 脚本入口（test:*/verify:*/probe:*/postinstall 都在这里） | 人工补写 |
| [`README.en.md`](../README.en.md) | QQ ↔ DeepSeek Harness Bridge (qq-bridge) | 文件自带（标题） |
| [`README.md`](../README.md) | QQ ↔ DeepSeek Harness 桥接 | 文件自带（标题） |
| [`restart.bat`](../restart.bat) | 先杀旧守护窗口与旧桥接（按锁文件 PID + 命令行兜底），确认退出后再拉起守护窗口 | 人工补写 |
| [`RULES.md`](../RULES.md) | QQ 桥接权限与安全规则（RULES） | 文件自带（标题） |
| [`start.bat`](../start.bat) | 桥接守护启动器：先收紧 state/ 权限，再在 :loop 里跑 bridge.js，退出 5 秒后自动重启 | 人工补写 |
| [`watchdog.cmd`](../watchdog.cmd) | 外部看门狗启动器（双击即用；必须住在桥接进程外，见 FOLDER_MAP / INSTALL_NOTES 16.4） | 人工补写 |

## assets

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`deepseek娘.png`](../assets/deepseek娘.png) | 仓库用的形象图资源（README/文档引用） | 人工补写 |

## docs

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`群公告-新版草稿.md`](../docs/群公告-新版草稿.md) | 群公告（bot 第一人称版） | 文件自带（标题） |
| [`AFFINITY.md`](../docs/AFFINITY.md) | 好感度（关系）系统设计 —— 阶段 1 | 文件自带（标题） |
| [`FEED.md`](../docs/FEED.md) | 投喂（赞助）功能设计 | 文件自带（标题） |
| [`FOLDER_MAP.md`](../docs/FOLDER_MAP.md) | 仓库目录地图（FOLDER_MAP） | 文件自带（标题） |
| [`MEMES.md`](../docs/MEMES.md) | 本地表情包库（memes：接入 dsh-meme 图库） | 文件自带（标题） |
| [`MODERATION.md`](../docs/MODERATION.md) | 群管理：禁言 + 群公告 | 文件自带（标题） |
| [`PROJECT_GUIDE.md`](../docs/PROJECT_GUIDE.md) | DSH QQ 桥接（qq-bridge）项目说明书 | 文件自带（标题） |
| [`README.md`](../docs/README.md) | 文档索引（docs/README.md） | 文件自带（标题） |

## docs/guides

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`CONSOLE-UI-TESTING.md`](../docs/guides/CONSOLE-UI-TESTING.md) | 控制台离线预览与回归测试 | 文件自带（标题） |
| [`DSH_SETUP.md`](../docs/guides/DSH_SETUP.md) | DSH 端安装说明（本机或另一台设备） | 文件自带（标题） |
| [`PRIVACY.md`](../docs/guides/PRIVACY.md) | 发布前隐私检查（PRIVACY） | 文件自带（标题） |
| [`SECURITY_BASELINE.md`](../docs/guides/SECURITY_BASELINE.md) | 安全基线与威胁模型（qq-bridge → QSH） | 文件自带（标题） |
| [`TOKEN_USAGE_CONSOLE.md`](../docs/guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板 | 文件自带（标题） |

## dsh/agent-presets/qq-chat

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`agent.cordis.yml`](../dsh/agent-presets/qq-chat/agent.cordis.yml) | The `qq-chat` agent preset: QQ 群聊机器人（最低权限面）。 | 文件自带 |
| [`preset.yml`](../dsh/agent-presets/qq-chat/preset.yml) | name: QQ 聊天角色 | 文件自带 |
| [`qq-tool-restrict.mjs`](../dsh/agent-presets/qq-chat/qq-tool-restrict.mjs) | re-export 壳：qq-tool-restrict 的权威实现只有一份，在 | 文件自带 |

## dsh/agent-presets/qq-chat-v2

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`agent.cordis.yml`](../dsh/agent-presets/qq-chat-v2/agent.cordis.yml) | The `qq-chat-v2` agent preset: 二代仿真模式（reserved2）专用。 | 文件自带 |
| [`preset.yml`](../dsh/agent-presets/qq-chat-v2/preset.yml) | name: QQ 聊天角色（二代仿真） | 文件自带 |
| [`qq-tool-restrict.mjs`](../dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs) | re-export 壳：qq-tool-restrict 的权威实现只有一份，在 | 文件自带 |

## dsh/skills/codex-image

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`SKILL.md`](../dsh/skills/codex-image/SKILL.md) | 生图技能说明（Codex CLI 出图，走 owner 的 ChatGPT 订阅，无需 API key） | 人工补写 |

## dsh/skills/codex-image/scripts

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`codex-image.ps1`](../dsh/skills/codex-image/scripts/codex-image.ps1) | 生图技能实现：调 codex exec 生成图片并拷到指定路径（自动探测系统代理） | 人工补写 |

## plugins/qq-agent-presets

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`package.json`](../plugins/qq-agent-presets/package.json) | qq-bridge 的 DSH agent preset bundle：把 qq-chat / qq-chat-v2 作为 @deepseek-ai/dsh-agent-preset 行插入（DSH 0.1.7+ 的 preset 机制），并携带两个 preset 共用的 qq-tool-restrict 安全守卫 | 文件自带（JSON 字段） |
| [`qq-tool-restrict.mjs`](../plugins/qq-agent-presets/qq-tool-restrict.mjs) | QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。 | 文件自带 |

## plugins/qq-agent-presets/presets

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`qq-chat-v2.patch.yml`](../plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml) | 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。 | 文件自带 |
| [`qq-chat.patch.yml`](../plugins/qq-agent-presets/presets/qq-chat.patch.yml) | 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。 | 文件自带 |

## plugins/qq-mode-console

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`cordis.patch.yml`](../plugins/qq-mode-console/cordis.patch.yml) | entry 的 **id 必须等于插件注册的设置命名空间名**（`qq-mode`，见 lib/index.js 的 | 文件自带 |
| [`package.json`](../plugins/qq-mode-console/package.json) | QQ bridge mode console for DeepSeek Harness settings UI (chat / closed-agent / reserved / reserved2) | 文件自带（JSON 字段） |

## plugins/qq-mode-console/lib

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`index.js`](../plugins/qq-mode-console/lib/index.js) | QQ 桥接模式控制台（host 插件，仅注册 settings 命名空间）。 | 文件自带 |

## public

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`console.html`](../public/console.html) | 桥接自带控制台前端（127.0.0.1:3100）：设置、状态、二代会话面板、语音试发等 | 人工补写 |

## roles

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`傲娇助手.md`](../roles/傲娇助手.md) | 傲娇助手 | 文件自带（标题） |
| [`小鲸鱼.md`](../roles/小鲸鱼.md) | 角色卡：DeepSeek 小鲸鱼 —— QQ 群友版 | 文件自带（标题） |
| [`README.md`](../roles/README.md) | 人格卡目录说明与写法约定 | 人工补写 |

## scripts

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`add-balance-rule.mjs`](../scripts/add-balance-rule.mjs) | 在 qq-chat-v2 预设里加入第 28 条：余额查询 | 文件自带 |
| [`add-image-rule.mjs`](../scripts/add-image-rule.mjs) | 在 qq-chat-v2 预设里加入第 29 条：生图 | 文件自带 |
| [`affinity-admin.mjs`](../scripts/affinity-admin.mjs) | 用 Node 调好感度接口（原生 UTF-8，避免 PowerShell 5.1 的 -Body 编码坑） | 文件自带 |
| [`affinity-file-admin.mjs`](../scripts/affinity-file-admin.mjs) | 离线改好感度：直接改 state/social-v2.json（桥接没开时用；开着会被内存覆盖，请停桥上用或改用 HTTP 接口） | 文件自带 |
| [`affinity-report.mjs`](../scripts/affinity-report.mjs) | 群友好感度报表（只读）：从运行中的桥接拉当前分数，附今日变动与最近原因。 | 文件自带 |
| [`apply-allowlists.mjs`](../scripts/apply-allowlists.mjs) | 按核实过的号写入两个项目的白名单配置 | 文件自带 |
| [`arknights-daily.mjs`](../scripts/arknights-daily.mjs) | !/usr/bin/env node | 文件自带 |
| [`arknights-setup.ps1`](../scripts/arknights-setup.ps1) | 「明日方舟日活」一次性提权安装 | 文件自带 |
| [`audit-bridge-harness.mjs`](../scripts/audit-bridge-harness.mjs) | Execute the real bridge initialization/functions against temporary files and fake peers. | 文件自带 |
| [`backup-before-upgrade.ps1`](../scripts/backup-before-upgrade.ps1) | 升级前完整备份：仓库运行数据 + preset + DSH 配置 + git bundle | 文件自带 |
| [`build-agent-preset-patches.mjs`](../scripts/build-agent-preset-patches.mjs) | !/usr/bin/env node | 文件自带 |
| [`check-announcement-draft.mjs`](../scripts/check-announcement-draft.mjs) | 提交前本地校验：公告正文是否过得了桥接的 validateAnnouncement（长度/链接/@全体/敏感特征）。 | 文件自带 |
| [`check-braces.mjs`](../scripts/check-braces.mjs) | 精确一点的 JS 括号平衡检查：正确处理字符串、模板字面量（含 ${} 嵌套）、注释与正则字面量。 | 文件自带 |
| [`check-bridge-identifiers.mjs`](../scripts/check-bridge-identifiers.mjs) | 静态自检：找出"被当作函数调用、但既没声明也没导入"的标识符。 | 文件自带 |
| [`check-console-ui.mjs`](../scripts/check-console-ui.mjs) | 控制台页面自检：新增的 memes 控件是否 html/js 都接上了（排查手写 UI 漏接）。 | 文件自带 |
| [`check-onebot-status.mjs`](../scripts/check-onebot-status.mjs) | 查询 SnowLuma 网关与 QQ 会话状态：HTTP API + WebSocket | 文件自带 |
| [`check-preset-admin-rules.mjs`](../scripts/check-preset-admin-rules.mjs) | 只读校验：预设里的规则编号/关键规则是否齐（手写 YAML 容易漏或串号）。 | 文件自带 |
| [`check-preset-rules.mjs`](../scripts/check-preset-rules.mjs) | 校验两个 preset 的规则完整性（YAML 可解析 + 关键规则都在） | 文件自带 |
| [`cleanup-stale-sessions.mjs`](../scripts/cleanup-stale-sessions.mjs) | !/usr/bin/env node | 文件自带 |
| [`close-dsh.mjs`](../scripts/close-dsh.mjs) | !/usr/bin/env node | 文件自带 |
| [`close-dsh.ps1`](../scripts/close-dsh.ps1) | close-dsh.ps1 - started by the QQ agent on user request: wait a bit, then stop the DSH web process. | 文件自带 |
| [`console-status.mjs`](../scripts/console-status.mjs) | 读桥接控制台状态，定位「会话繁忙」的原因 | 文件自带 |
| [`console-ui-contracts.json`](../scripts/console-ui-contracts.json) | 控制台 UI 契约基线（npm run test:console-ui 用；只有后端契约真变时才重录） | 人工补写 |
| [`console-ui-fixture.mjs`](../scripts/console-ui-fixture.mjs) | !/usr/bin/env node | 文件自带 |
| [`console-ui-legacy-ids.json`](../scripts/console-ui-legacy-ids.json) | 控制台历史元素 id 清单（回归用：确保老 id 没被悄悄删掉） | 人工补写 |
| [`debug-auth.mjs`](../scripts/debug-auth.mjs) | 隔离测试：用配置里的 cookie 分别走 raw fetch 和 NodeApiClient，看差在哪 | 文件自带 |
| [`dsh-modules.mjs`](../scripts/dsh-modules.mjs) | 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。 | 文件自带 |
| [`dsh-with-token.mjs`](../scripts/dsh-with-token.mjs) | 启动 DSH 并自动捕获 launch token 写入 config.json | 文件自带 |
| [`dump-session-reasoning.mjs`](../scripts/dump-session-reasoning.mjs) | 打印某个 DSH 会话里模型每一步的 reasoning 摘要（做"它为什么没做某件事"的复盘用）。 | 文件自带 |
| [`dump-session-tail.mjs`](../scripts/dump-session-tail.mjs) | 解码某个 DSH 会话（zstd 分帧）并打印最近的工具调用/结果，用于还原"模型到底看到了什么" | 文件自带 |
| [`endfield-daily.mjs`](../scripts/endfield-daily.mjs) | !/usr/bin/env node | 文件自带 |
| [`endfield-setup.ps1`](../scripts/endfield-setup.ps1) | 「明日方舟：终末地日活」一次性提权安装 | 文件自带 |
| [`feed-admin.mjs`](../scripts/feed-admin.mjs) | 投喂账本命令行（HTTP 调桥接接口，UTF-8 安全，别用 PowerShell 发中文） | 文件自带 |
| [`find-brace-drift.mjs`](../scripts/find-brace-drift.mjs) | 用「锚点前缀扫描」定位合并后括号失衡（多一个 { 或少一个 }）出现的区间。 | 文件自带 |
| [`find-syntax-error.mjs`](../scripts/find-syntax-error.mjs) | 用 DSH 自带的 @babel/parser 精确定位语法错误（node --check 只报个笼统位置）。 | 文件自带 |
| [`fix-preset-order.mjs`](../scripts/fix-preset-order.mjs) | 把 qq-chat-v2 preset 里误插到 26 前面的 27 条移到 26 后面，并统一缩进 | 文件自带 |
| [`fix-stuck-session.mjs`](../scripts/fix-stuck-session.mjs) | 看桥接的挂起队列 / 处理情况，必要时重置卡住的会话 | 文件自带 |
| [`forge-dsh-cookie.mjs`](../scripts/forge-dsh-cookie.mjs) | 用 DSH 持久 secret 自签浏览器会话 cookie，并写入桥接配置（免 launch token） | 文件自带 |
| [`game-daily-setup.ps1`](../scripts/game-daily-setup.ps1) | 游戏日活：**一次性**提权安装（必须用管理员身份运行本脚本） | 文件自带 |
| [`game-daily.mjs`](../scripts/game-daily.mjs) | !/usr/bin/env node | 文件自带 |
| [`gen-image-worker.mjs`](../scripts/gen-image-worker.mjs) | !/usr/bin/env node | 文件自带 |
| [`get-agent-token.mjs`](../scripts/get-agent-token.mjs) | 取当前会话的 agent token（仅用于本地验证限制逻辑） | 文件自带 |
| [`harden-state-acl.mjs`](../scripts/harden-state-acl.mjs) | state/ 目录权限收紧的「可提权」入口。 | 文件自带 |
| [`inspect-meme-pack.mjs`](../scripts/inspect-meme-pack.mjs) | 只读：打印 dsh-meme 图库索引结构与样例（排查用） | 文件自带 |
| [`install-skills.mjs`](../scripts/install-skills.mjs) | !/usr/bin/env node | 文件自带 |
| [`list-affinity.mjs`](../scripts/list-affinity.mjs) | list-affinity.mjs —— 只读列出某个会话的**全员好感度**（owner 巡检 / 回答"现在大家多少分"用） | 文件自带 |
| [`make-config.mjs`](../scripts/make-config.mjs) | 从 config.example.json 生成 config.json（已存在则跳过、绝不覆盖） | 人工补写 |
| [`meme-flow-test.mjs`](../scripts/meme-flow-test.mjs) | 本地表情包链路自检（不依赖桥接进程）。 | 文件自带 |
| [`patch-dsh-base64.mjs`](../scripts/patch-dsh-base64.mjs) | !/usr/bin/env node | 文件自带 |
| [`patch-snowluma-sdk.mjs`](../scripts/patch-snowluma-sdk.mjs) | 修复 @snowluma 系列 npm 包的发布打包 bug：dist 内的相对导入缺少 .js 扩展名， | 文件自带 |
| [`preflight-publish.mjs`](../scripts/preflight-publish.mjs) | 发布前体检：把"将要提交的文件"里可能泄漏的内容扫一遍（不会修改任何东西）。 | 文件自带 |
| [`privacy-rules.example.json`](../scripts/privacy-rules.example.json) | 本地专用规则模板。复制为 privacy-rules.json 后填写你自己的真实标识；privacy-rules.json 必须加进 .gitignore（它含你的 QQ 号/路径）。本模板本身不含真实数据，可以入库。 | 文件自带（JSON 字段） |
| [`privacy-scan.mjs`](../scripts/privacy-scan.mjs) | 发布前隐私与敏感信息扫描（**离线、只读、不联网**）。 | 文件自带 |
| [`probe-015.mjs`](../scripts/probe-015.mjs) | 探测 DSH 0.1.5-rc.1 的 Web API 协议表面（只读，不改动 DSH 状态）。 | 文件自带 |
| [`probe-afdian.mjs`](../scripts/probe-afdian.mjs) | 爱发电凭据自检：验证 token 是否有效 + 拉一页历史订单（订单号脱敏，不回显 token） | 文件自带 |
| [`probe-affinity-clock.mjs`](../scripts/probe-affinity-clock.mjs) | probe-affinity-clock.mjs —— 检查好感度数据里的**时间字段是否错位**（排查"分数不涨/不衰减"用） | 文件自带 |
| [`probe-affinity-prompt.mjs`](../scripts/probe-affinity-prompt.mjs) | 检查最新 QQ 会话里有没有注入好感度（关系）面板，并打印片段 | 文件自带 |
| [`probe-balance-tool.mjs`](../scripts/probe-balance-tool.mjs) | 用 MCP stdio 协议实测：服务器能否启动、是否列出 qq_get_balance、调用是否返回余额 | 文件自带 |
| [`probe-ban-plumbing.mjs`](../scripts/probe-ban-plumbing.mjs) | 只读探活：只验证"禁言动作能不能被 QQ 侧正确理解"，不会禁言任何真人。 | 文件自带 |
| [`probe-bridge.mjs`](../scripts/probe-bridge.mjs) | 只读探活：桥接控制台是否在跑、什么模式、AI 是否暂停、表情包库状态。 | 文件自带 |
| [`probe-codex-logs.mjs`](../scripts/probe-codex-logs.mjs) | 一次性排查脚本：看 codex CLI 自己的日志库里最近发生了什么 | 文件自带 |
| [`probe-codex-recent.mjs`](../scripts/probe-codex-recent.mjs) | 看 codex 日志库里最近 N 分钟的记录（判断 codex exec 卡在哪一步） | 文件自带 |
| [`probe-codex-strings.mjs`](../scripts/probe-codex-strings.mjs) | 在 codex.exe 里找 "refresh_strategy" 附近的字符串，看有没有可配置项/环境变量能跳过联网刷新模型列表 | 文件自带 |
| [`probe-codex-strings2.mjs`](../scripts/probe-codex-strings2.mjs) | 打印 codex.exe 里 refresh_strategy / cache_ttl 附近的完整字符串块，推断配置键名 | 文件自带 |
| [`probe-console-ui.mjs`](../scripts/probe-console-ui.mjs) | 控制台 UI 体检：确认「我们本地的面板」确实在**桥接实际发出的页面**里，并报告它们所在的 | 文件自带 |
| [`probe-current-notice.mjs`](../scripts/probe-current-notice.mjs) | 看一眼群里当前公告正文（走桥接控制台 API，只读）。 | 文件自带 |
| [`probe-dsh-token.mjs`](../scripts/probe-dsh-token.mjs) | 验证 DSH launch token：GET /?token=XXX 看是否返回 set-cookie | 文件自带 |
| [`probe-engines.mjs`](../scripts/probe-engines.mjs) | 直接探测各搜索引擎的可用性（不经 MCP） | 文件自带 |
| [`probe-events.mjs`](../scripts/probe-events.mjs) | 端到端验证：remote.mux 事件流 + turn 收集 + 工具调用事件形状。 | 文件自带 |
| [`probe-group-admin.mjs`](../scripts/probe-group-admin.mjs) | 只读探活：机器人在群里的身份（能否禁言/发公告）+ 群管理结构 + SnowLuma 相关动作可用性。 | 文件自带 |
| [`probe-headers.mjs`](../scripts/probe-headers.mjs) | 测不同 UA / 请求头下各引擎能否返回结果 | 文件自带 |
| [`probe-image-tool-auth.mjs`](../scripts/probe-image-tool-auth.mjs) | 验证「生图工具的调用形状」是否被桥接接受（只跑不扣配额的前置校验 consume:false）。 | 文件自带 |
| [`probe-live-features.mjs`](../scripts/probe-live-features.mjs) | 升级后的「活体功能自检」：只读地打桥接控制台的各个本地特性端点，确认它们在 0.1.7 上仍然活着。 | 文件自带 |
| [`probe-mcp-server.mjs`](../scripts/probe-mcp-server.mjs) | 通用 MCP 探测：启动一个 stdio MCP 服务，列出工具名，可选调用一次 | 文件自带 |
| [`probe-mcp-tools.mjs`](../scripts/probe-mcp-tools.mjs) | 探针：当前 src/mcp-snowluma-safe.js 实际注册了哪些工具（按 config.json 的开关过滤后）。 | 文件自带 |
| [`probe-models.mjs`](../scripts/probe-models.mjs) | 读取 DSH 的 settings/describe，列出所有 namespace 与可选模型（只读）。 | 文件自带 |
| [`probe-relevance.mjs`](../scripts/probe-relevance.mjs) | 诊断：为什么搜索结果不相关 | 文件自带 |
| [`probe-rpc-compat.mjs`](../scripts/probe-rpc-compat.mjs) | 对比探测：逐条验证桥接实际使用的 RPC 参数形状在新版 DSH 上是否被接受。 | 文件自带 |
| [`probe-search-fields.mjs`](../scripts/probe-search-fields.mjs) | 只打印 web_search 的关键字段（source / relevance / 前几条标题），避免被长 snippet 截断 | 文件自带 |
| [`probe-search-quality.mjs`](../scripts/probe-search-quality.mjs) | 诊断搜索质量：分别看 Bing RSS / Bing HTML / 百度 三条链路对同一条中文查询的真实返回 | 文件自带 |
| [`probe-session-search.mjs`](../scripts/probe-session-search.mjs) | 在所有 QQ 会话里搜关键词，打印命中会话里的 web_search / web_fetch 调用与结果（用来判断搜索质量） | 文件自带 |
| [`probe-snowluma-actions.mjs`](../scripts/probe-snowluma-actions.mjs) | 只读：列出 SnowLuma 支持的群相关动作，确认有没有"转让群主"之类的接口。 | 文件自带 |
| [`probe-speaker-wake.mjs`](../scripts/probe-speaker-wake.mjs) | 只读排查：AI 什么时候给谁设过「指定成员唤醒」(triggers.speakerIds)。 | 文件自带 |
| [`probe-tools.mjs`](../scripts/probe-tools.mjs) | 端到端验证 QQ preset 的「工具面」与「工具协议」： | 文件自带 |
| [`probe-voice-send.mjs`](../scripts/probe-voice-send.mjs) | 语音链路体检（经桥接，**不发送**）：用「只校验不发送」跑一遍 /api/voice/send， | 文件自带 |
| [`probe-voice-status.mjs`](../scripts/probe-voice-status.mjs) | 语音功能现状体检：MCP 工具是否注册、控制台语音面板在哪一组、配置与依赖是否就绪。 | 文件自带 |
| [`probe-webfetch.mjs`](../scripts/probe-webfetch.mjs) | 实测 web_fetch 的 HTML 提取效果：用 agent 当时抓失败的页面 | 文件自带 |
| [`probe-websearch.mjs`](../scripts/probe-websearch.mjs) | 测 web_search 的实际返回 | 文件自带 |
| [`probe-workspace.mjs`](../scripts/probe-workspace.mjs) | 验证 workspace/session RPC 参数形状与返回值结构（对照 bridge.js 实际用法）。 | 文件自带 |
| [`propose-notice.mjs`](../scripts/propose-notice.mjs) | 把草稿正文提交到桥接的「待审公告」队列（owner 私聊回「通过」/控制台点按钮后才会发布）。 | 文件自带 |
| [`read-dsh-session-log.mjs`](../scripts/read-dsh-session-log.mjs) | 读 DSH 的会话记录（session.v4.jsonl.zstd）并打印尾部事件，用于诊断端到端用例里模型做了什么。 | 文件自带 |
| [`redact-personal.mjs`](../scripts/redact-personal.mjs) | 发布前脱敏：把真实群号/QQ/昵称/本机用户名替换成占位符。 | 文件自带 |
| [`replay-dsh-attempt.mjs`](../scripts/replay-dsh-attempt.mjs) | 复盘一次失败的 assistant/attempt：把流式 chunk 汇总成「块类型 / 工具名 / 工具入参原文 / 结束原因」。 | 文件自带 |
| [`run-offline-tests.mjs`](../scripts/run-offline-tests.mjs) | 本机离线回归总入口：顺序跑 scripts/test-*.mjs，跳过依赖外部环境的用例 | 文件自带 |
| [`scan-dsh-session-errors.mjs`](../scripts/scan-dsh-session-errors.mjs) | 扫 DSH 会话记录（session.v4.jsonl.zstd）找报错：解压后按行解析，挑出 error / tool input / | 文件自带 |
| [`send-test-card.mjs`](../scripts/send-test-card.mjs) | 发一张卡图到指定群，验证网关发图链路（用本地文件的 base64，兼容性最好） | 文件自带 |
| [`send-test-group.mjs`](../scripts/send-test-group.mjs) | 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。 | 文件自带 |
| [`send-voice.mjs`](../scripts/send-voice.mjs) | !/usr/bin/env node | 文件自带 |
| [`set-admin-config.mjs`](../scripts/set-admin-config.mjs) | 配置群管理：开关干跑、设置干跑截止时间、禁言播报模板、白名单等（离线改，需重启桥接生效）。 | 文件自带 |
| [`set-afdian-key.mjs`](../scripts/set-afdian-key.mjs) | 写入/更新投喂相关配置（config.json 在 .gitignore 里，不入库） | 文件自带 |
| [`set-onebot-token.mjs`](../scripts/set-onebot-token.mjs) | 把 SnowLuma 的 OneBot HTTP/WS accessToken 统一设为指定令牌，并同步给两个机器人 | 文件自带 |
| [`set-tavily-key.mjs`](../scripts/set-tavily-key.mjs) | 把外部 API 密钥写进 config.json（该文件已在 .gitignore 里，不入库） | 文件自带 |
| [`setup-dsh.mjs`](../scripts/setup-dsh.mjs) | !/usr/bin/env node | 文件自带 |
| [`show-notice.mjs`](../scripts/show-notice.mjs) | 只读：打印当前群公告全文（含所有历史公告的标题/时间），供改写参考。 | 文件自带 |
| [`show-recent.mjs`](../scripts/show-recent.mjs) | 只读：把最近 N 条群消息按时间正序打出来（谁说的、内容、是否引用/带图、是否 @ 机器人）。 | 文件自带 |
| [`sync-onebot-tokens.mjs`](../scripts/sync-onebot-tokens.mjs) | 把 SnowLuma 的 HTTP / WS 两个 token 分别同步到桥接配置 | 文件自带 |
| [`sync-snowluma-token.mjs`](../scripts/sync-snowluma-token.mjs) | 把 SnowLuma 的 OneBot accessToken 同步进 qq-bridge 配置，并实测连接 | 文件自带 |
| [`test-admin-routes.mjs`](../scripts/test-admin-routes.mjs) | 群管理路由验收（不会真的禁言；公告只走"起草→校验→作废"，不发布）。 | 文件自带 |
| [`test-affinity.mjs`](../scripts/test-affinity.mjs) | 好感度引擎单测：node scripts/test-affinity.mjs | 文件自带 |
| [`test-agent-preset-patches.mjs`](../scripts/test-agent-preset-patches.mjs) | 钉住 DSH 0.1.7 preset 装配的「防漂移」契约（纯离线，不需要 DSH 在跑）： | 文件自带 |
| [`test-arknights-command.mjs`](../scripts/test-arknights-command.mjs) | arknights-command 纯函数回归（触发命令判定 + 状态描述）：不联网、不碰 MAA/QQ。 | 文件自带 |
| [`test-arknights-daily.mjs`](../scripts/test-arknights-daily.mjs) | arknights-daily 执行器的离线回归：不联网、不起 MAA、不杀进程（全部注入假实现）。 | 文件自带 |
| [`test-audit-bridge.mjs`](../scripts/test-audit-bridge.mjs) | test-audit 子模块：桥接行为审计（跑在 audit-bridge-harness 的虚拟网关上） | 人工补写 |
| [`test-audit-protocol-helpers.mjs`](../scripts/test-audit-protocol-helpers.mjs) | test-audit 子模块：协议审计的公共辅助函数 | 人工补写 |
| [`test-audit-protocol.mjs`](../scripts/test-audit-protocol.mjs) | Offline regression tests. No real DSH/QQ endpoints or local credentials are read. | 文件自带 |
| [`test-audit-security-mcp.mjs`](../scripts/test-audit-security-mcp.mjs) | Exercise MCP callbacks with a fake transport: no network, config or stdio server. | 文件自带 |
| [`test-audit-security.mjs`](../scripts/test-audit-security.mjs) | Offline regression tests: no sockets, QQ messages, production config or secrets. | 文件自带 |
| [`test-audit-setup-guards.mjs`](../scripts/test-audit-setup-guards.mjs) | Execute both real preset plugins against a captured tools service, without DSH/QQ. | 文件自带 |
| [`test-audit-setup.mjs`](../scripts/test-audit-setup.mjs) | Offline integration tests. Every setup invocation receives its own repository and DSH_HOME. | 文件自带 |
| [`test-audit.mjs`](../scripts/test-audit.mjs) | Safe audit suite: fixtures and mocks only, never production QQ/DSH. | 文件自带 |
| [`test-console-encoding.mjs`](../scripts/test-console-encoding.mjs) | 验证「Windows 控制台乱码 + chcp 修复」的机制是否成立。 | 文件自带 |
| [`test-console-static.mjs`](../scripts/test-console-static.mjs) | 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。 | 文件自带 |
| [`test-console-ui.mjs`](../scripts/test-console-ui.mjs) | !/usr/bin/env node | 文件自带 |
| [`test-console.mjs`](../scripts/test-console.mjs) | 控制台增强功能综合测试（node 直接调 API） | 文件自带 |
| [`test-dsh-auth.mjs`](../scripts/test-dsh-auth.mjs) | DSH 鉴权适配回归测试（0.1.7 起）。 | 文件自带 |
| [`test-dsh-v2-wait.mjs`](../scripts/test-dsh-v2-wait.mjs) | 二代等待逻辑的「实时」端到端测试：真建一个 qq-chat-v2 会话并向 DSH 提问， | 文件自带 |
| [`test-encoding.mjs`](../scripts/test-encoding.mjs) | 启动器与编码自检： | 文件自带 |
| [`test-endfield-daily.mjs`](../scripts/test-endfield-daily.mjs) | 终末地档案（MAAEND/MXU）的离线回归：档案默认值、声明式补丁、多日志监听、计数式完成判据。 | 文件自带 |
| [`test-face-media.mjs`](../scripts/test-face-media.mjs) | QQ 内置表情（face）取图回落：faceImageUrlCandidates 的单元测试 + bridge 接线检查 | 文件自带 |
| [`test-feed.mjs`](../scripts/test-feed.mjs) | 投喂模块单测：node scripts/test-feed.mjs（不联网，网络部分用假 fetch） | 文件自带 |
| [`test-forward.mjs`](../scripts/test-forward.mjs) | 合并转发消息能力自检脚本： | 文件自带 |
| [`test-hardening.mjs`](../scripts/test-hardening.mjs) | 2026-09-20 体检修复的回归测试。 | 文件自带 |
| [`test-image-ack.mjs`](../scripts/test-image-ack.mjs) | 生图开始提示（ack）验收：渲染预览 + 配置生效检查（不会往群里发消息）。 | 文件自带 |
| [`test-image-skill.mjs`](../scripts/test-image-skill.mjs) | 生图技能「入库」验收： | 文件自带 |
| [`test-image-state.mjs`](../scripts/test-image-state.mjs) | 生图状态口径验收（只读 + 单元）：失败后模型不能再被"没有状态"误导着说"正在画"。 | 文件自带 |
| [`test-mcp-agent-token.mjs`](../scripts/test-mcp-agent-token.mjs) | 回归：MCP 里每个「智能体调用」都必须带 x-agent-token 头。 | 文件自带 |
| [`test-mcp-exec.mjs`](../scripts/test-mcp-exec.mjs) | 测试 @snowluma/mcp 的 write 模式：模拟 DSH MCP 客户端完整握手 | 文件自带 |
| [`test-mcp-host.mjs`](../scripts/test-mcp-host.mjs) | 测试桥接自带的 snowluma-host MCP server（status/start/stop） | 文件自带 |
| [`test-mcp-safe.mjs`](../scripts/test-mcp-safe.mjs) | 测试安全版 QQ MCP server：工具清单 + 白名单发送校验 | 文件自带 |
| [`test-mcp-servers-stdio.mjs`](../scripts/test-mcp-servers-stdio.mjs) | 模拟 DSH 的 dsh-mcp-client：以 stdio 拉起桥接的 MCP server，握手并列出工具， | 文件自带 |
| [`test-mcp-web-search.mjs`](../scripts/test-mcp-web-search.mjs) | 测试安全 Web Search / Fetch MCP server： | 文件自带 |
| [`test-md-to-plain.mjs`](../scripts/test-md-to-plain.mjs) | md-to-plain 纯函数回归测试（不依赖 SnowLuma / DSH / QQ）。 | 文件自带 |
| [`test-meme-prompt.mjs`](../scripts/test-meme-prompt.mjs) | 只读验收：确认唤醒提示/Prompt 里真的带上了「本地表情包库」段落。 | 文件自带 |
| [`test-meme-routes.mjs`](../scripts/test-meme-routes.mjs) | 桥接「本地表情包」路由验收（只读/只做校验路径，不会真发消息到 QQ）。 | 文件自带 |
| [`test-memes.mjs`](../scripts/test-memes.mjs) | meme-lib 单元测试：纯函数 + 真实图库只读自检。 | 文件自带 |
| [`test-moderation.mjs`](../scripts/test-moderation.mjs) | moderation.js 单元测试：检测规则 / 时长阶梯 / 豁免 / 限流 / 公告校验 / 动作白名单。 | 文件自带 |
| [`test-mute-live.mjs`](../scripts/test-mute-live.mjs) | 真机禁言验证：对指定 QQ 禁言 N 秒，确认成功后**立即解禁**（默认 60 秒 → 验证完就解开）。 | 文件自带 |
| [`test-mux-reconnect.mjs`](../scripts/test-mux-reconnect.mjs) | 事件流重连回归测试：DSH 重启 / WS 断开后，**已有会话必须被重新 follow**。 | 文件自带 |
| [`test-onebot-connection.mjs`](../scripts/test-onebot-connection.mjs) | 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关， | 文件自带 |
| [`test-owner-dm.mjs`](../scripts/test-owner-dm.mjs) | 验证「owner 私聊命令」链路（用控制台模拟器，不需要 owner 真的发消息）。 | 文件自带 |
| [`test-persona-lines.mjs`](../scripts/test-persona-lines.mjs) | persona-lines.js 单元测试：桥接"替机器人说的话"（禁言播报 / 生图开始提示）。 | 文件自带 |
| [`test-preset-local-tools.mjs`](../scripts/test-preset-local-tools.mjs) | 铁律 L7 的注册期断言：仿真会话的 preset **不得包含本地执行能力**。 | 文件自带 |
| [`test-preset-prompt.mjs`](../scripts/test-preset-prompt.mjs) | 仿真提示词改写（src/preset-prompt.js）的离线单测。 | 文件自带 |
| [`test-qq-mode-plugin.mjs`](../scripts/test-qq-mode-plugin.mjs) | 静态验证 qq-mode-console 插件在新版 DSH API 下是否仍可注册设置命名空间。 | 文件自带 |
| [`test-qq-model-view.mjs`](../scripts/test-qq-model-view.mjs) | 端到端用例：确认模型侧看到的 QQ 工具清单/会话视图符合预期（在 npm run test:token 里） | 人工补写 |
| [`test-qq-preset-contract.mjs`](../scripts/test-qq-preset-contract.mjs) | reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。 | 文件自带 |
| [`test-reply-wait.mjs`](../scripts/test-reply-wait.mjs) | First-reply quiet-window regressions. Real bridge handlers, fixture peers only. | 文件自带 |
| [`test-role-card.mjs`](../scripts/test-role-card.mjs) | 人格卡按仿真模式取用（src/role-card.js）的离线单测。 | 文件自带 |
| [`test-setup-dsh-idempotent.mjs`](../scripts/test-setup-dsh-idempotent.mjs) | setup-dsh.mjs 幂等性测试：在一个临时 DSH_HOME 里连跑两次， | 文件自带 |
| [`test-slang-learn.mjs`](../scripts/test-slang-learn.mjs) | 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。 | 文件自带 |
| [`test-snowluma-conn.mjs`](../scripts/test-snowluma-conn.mjs) | SnowLuma 账号/token 自发现自检。 | 文件自带 |
| [`test-snowluma-liveness.mjs`](../scripts/test-snowluma-liveness.mjs) | SnowLuma 链路存活看门狗验收。 | 文件自带 |
| [`test-stickers.mjs`](../scripts/test-stickers.mjs) | 表情包体系自检： | 文件自带 |
| [`test-token-economy.mjs`](../scripts/test-token-economy.mjs) | Exercise real bridge HTTP handlers and prompt delivery with isolated files, | 文件自带 |
| [`test-token-usage.mjs`](../scripts/test-token-usage.mjs) | Token 用量账本 + 价目表测试。 | 文件自带 |
| [`test-turn-retry.mjs`](../scripts/test-turn-retry.mjs) | 回合级重试策略单测：工具参数写成非法 JSON（MALFORMED_RESPONSE）时该不该自动重发。 | 文件自带 |
| [`test-v2-wait.mjs`](../scripts/test-v2-wait.mjs) | 二代“对面没说完 / 结束前等待”逻辑测试。 | 文件自带 |
| [`test-vision-media.mjs`](../scripts/test-vision-media.mjs) | 视觉/图片链路自检脚本： | 文件自带 |
| [`test-voice-edge.mjs`](../scripts/test-voice-edge.mjs) | 并发与边界体检：确认语音系统在「同时多个请求 / 异常输入 / 重名 / 缺目录」下不炸、不乱。 | 文件自带 |
| [`test-voice-gui.mjs`](../scripts/test-voice-gui.mjs) | 图形界面（voice-gui.mjs + public/voice.html）自检： | 文件自带 |
| [`test-voice-preview.mjs`](../scripts/test-voice-preview.mjs) | 图形界面音量端点验证（live）：/api/preview 必须真的按音量产出不同音频。 | 文件自带 |
| [`test-voice-system.mjs`](../scripts/test-voice-system.mjs) | 语音系统整体自检（结构层）：把「独立工具 + qq-bridge 语音系统」的所有入口、依赖、 | 文件自带 |
| [`test-voice-transcribe.mjs`](../scripts/test-voice-transcribe.mjs) | voice-transcribe（收到语音 → 转写文本）纯函数 + 假网关回归测试：不依赖 SnowLuma / DSH / QQ。 | 文件自带 |
| [`test-voice-volume.mjs`](../scripts/test-voice-volume.mjs) | 音量调节自检： | 文件自带 |
| [`test-voice.mjs`](../scripts/test-voice.mjs) | 语音发送自检： | 文件自带 |
| [`test-watchdog-bridge.mjs`](../scripts/test-watchdog-bridge.mjs) | watchdog-bridge（外部看门狗）纯函数 + 假探针回归测试：不联网、不杀进程、不启动桥接。 | 文件自带 |
| [`trace-depth.mjs`](../scripts/trace-depth.mjs) | 找出 main() 的 body 在哪里被提前闭合（括号深度第一次回到 0 的那一行）。 | 文件自带 |
| [`unify-onebot-token.mjs`](../scripts/unify-onebot-token.mjs) | 把 SnowLuma 的 OneBot HTTP/WS accessToken 统一成同一个值，并触发配置重载 + 复测 | 文件自带 |
| [`upgrade-dsh-017.mjs`](../scripts/upgrade-dsh-017.mjs) | !/usr/bin/env node | 文件自带 |
| [`verify-agent-presets-017.mjs`](../scripts/verify-agent-presets-017.mjs) | 验证 DSH 0.1.7 的 agent preset 是否真的装上了（只读探测 + 断言）。 | 文件自带 |
| [`verify-dsh-015-adaptation.mjs`](../scripts/verify-dsh-015-adaptation.mjs) | DSH 适配总验证（0.1.5 建立，0.1.7 迁移后继续沿用文件名以免打断既有调用）： | 文件自带 |
| [`verify-ids.mjs`](../scripts/verify-ids.mjs) | 核实 ownerQQ / 群号：查机器人账号、好友、群列表、指定群是否存在 | 文件自带 |
| [`verify-onebot.mjs`](../scripts/verify-onebot.mjs) | 用官方 SDK 通过 OneBot WebSocket 验证：登录的是哪个号、群列表、能否发消息（只读调用，不发送） | 文件自带 |
| [`verify-persona-config.mjs`](../scripts/verify-persona-config.mjs) | 用 DSH 自身的 dsh-persona 配置 schema 校验修复后的 preset persona 配置。 | 文件自带 |
| [`verify-preset-rule.mjs`](../scripts/verify-preset-rule.mjs) | 校验 preset YAML 可解析，检查 27 条是否生效，并同步回仓库源 | 文件自带 |
| [`watchdog-bridge.mjs`](../scripts/watchdog-bridge.mjs) | !/usr/bin/env node | 文件自带 |
| [`zstd-frames.mjs`](../scripts/zstd-frames.mjs) | 读 DSH 的会话记录文件（session.v4.jsonl.zstd）。这些文件是**多帧 zstd 拼接**的， | 文件自带 |

## scripts/fixtures

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`console.before.html`](../scripts/fixtures/console.before.html) | QQ 桥接控制台 | 文件自带（title） |

## src

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`affinity.js`](../src/affinity.js) | affinity.js — 群友好感度（关系）引擎：**纯函数**，不依赖桥接内存，方便单测。 | 文件自带 |
| [`arknights-command.js`](../src/arknights-command.js) | 明日方舟日活：**触发命令的判定**（纯函数，可离线测试）。 | 文件自带 |
| [`bridge.js`](../src/bridge.js) | QQ ↔ DeepSeek Harness 桥接主程序。 | 文件自带 |
| [`dsh-client.js`](../src/dsh-client.js) | Node 环境的 DSH Web API 客户端。 | 文件自带 |
| [`feed.js`](../src/feed.js) | feed.js — 投喂（赞助）账本 + 爱发电订单核验 + DeepSeek 余额水位 | 文件自带 |
| [`forward.js`](../src/forward.js) | 合并转发消息（合并聊天记录）相关纯函数： | 文件自带 |
| [`image-ack.js`](../src/image-ack.js) | image-ack.js —— 生图请求的文本识别 + 回执去重（纯函数，可单测）。 | 文件自带 |
| [`mcp-host-server.js`](../src/mcp-host-server.js) | SnowLuma 网关状态查询 MCP server（stdio）。 | 文件自带 |
| [`mcp-qq-wait.js`](../src/mcp-qq-wait.js) | mcp-qq-wait.js — **只**暴露 qq_wait_for_messages 的独立 MCP stdio 服务。 | 文件自带 |
| [`mcp-snowluma-safe.js`](../src/mcp-snowluma-safe.js) | 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。 | 文件自带 |
| [`mcp-web-search-safe.js`](../src/mcp-web-search-safe.js) | 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。 | 文件自带 |
| [`md-to-plain.js`](../src/md-to-plain.js) | 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。 | 文件自带 |
| [`meme-lib.js`](../src/meme-lib.js) | 本地表情包库（dsh-meme 图库接入）——纯函数 + 只读索引。 | 文件自带 |
| [`model-prices.js`](../src/model-prices.js) | DeepSeek 官方价目表与峰谷分时判定（桥接侧自行维护）。 | 文件自带 |
| [`moderation.js`](../src/moderation.js) | moderation.js —— 群管理（禁言 / 群公告）的**确定性内核**：纯函数 + 只读文件工具。 | 文件自带 |
| [`persona-lines.js`](../src/persona-lines.js) | persona-lines.js —— 桥接"替机器人说的一句话"（群里播报）的模板池与挑选器。 | 文件自带 |
| [`preset-prompt.js`](../src/preset-prompt.js) | 二代仿真预设提示词（「仿真」层）的读取与安全改写。 | 文件自带 |
| [`qq-model-view.js`](../src/qq-model-view.js) | Only the model-facing view is compacted. Stored messages and console/API data | 文件自带 |
| [`role-card.js`](../src/role-card.js) | 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。 | 文件自带 |
| [`safe-fetch.js`](../src/safe-fetch.js) | 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。 | 文件自带 |
| [`self-test.js`](../src/self-test.js) | 自测脚本：不依赖 SnowLuma / QQ，只验证 DSH 侧链路—— | 文件自带 |
| [`send-voice-lib.js`](../src/send-voice-lib.js) | 语音发送共享库 —— 薄转发层（唯一实现在 voice-core.js）。 | 文件自带 |
| [`sensitive.js`](../src/sensitive.js) | 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。 | 文件自带 |
| [`slang-learner.js`](../src/slang-learner.js) | 群聊黑话/网络用语学习与迭代模块。 | 文件自带 |
| [`snowluma-conn.js`](../src/snowluma-conn.js) | SnowLuma 连接自发现：解决「换 QQ 账号后 token 变了，工具就 401」的问题。 | 文件自带 |
| [`snowluma-liveness.mjs`](../src/snowluma-liveness.mjs) | SnowLuma 链路存活判定（纯函数，便于单测）。 | 文件自带 |
| [`state-acl.mjs`](../src/state-acl.mjs) | state/ 目录 ACL 收紧的**唯一实现**。 | 文件自带 |
| [`sticker-lib.js`](../src/sticker-lib.js) | 表情包体系（二代仿真模式）——本地表情知识库与策略提示纯函数。 | 文件自带 |
| [`token-ledger.js`](../src/token-ledger.js) | Token 用量账本：把 DSH 会话事件里的 provider usage 落成「按会话 × 按回合」的可查明细， | 文件自带 |
| [`turn-retry.mjs`](../src/turn-retry.mjs) | 回合级错误的重试策略（纯函数，便于单测）。 | 文件自带 |
| [`v2-wait.js`](../src/v2-wait.js) | 二代仿真模式：等待/结束回合相关的轻量判断工具。 | 文件自带 |
| [`voice-core.js`](../src/voice-core.js) | 语音发送的共享内核：独立工具（上级 voice-tool/ 的 voice-cli.mjs / voice-gui.mjs）与桥接都用同一套规则。 | 文件自带 |
| [`voice-transcribe.js`](../src/voice-transcribe.js) | 收到的语音 → 文字（「听懂语音」）。 | 文件自带 |

## src/core

| 文件 | 作用 | 来源 |
| --- | --- | --- |
| [`session-router.mjs`](../src/core/session-router.mjs) | Per-conversation policy routing for the QQ bridge. | 文件自带 |
| [`session-router.test.mjs`](../src/core/session-router.test.mjs) | src/core/session-router.mjs 的单测 | 人工补写 |
