# 文件索引（FILE_INDEX）

> **本文件由脚本生成，不要手改**：`node scripts/gen-file-index.mjs`（`npm run docs:file-index`）。
> 漂移检查：`node scripts/gen-file-index.mjs --check`（不一致时退出 1，可挂进回归）。
>
> 「作用」一列优先取**文件自己的开头注释**（`文件自带`）；没有注释的由生成器内置表补写（`人工补写`）；
> 两者都没有就如实写「（无注释，待补）」——**不猜内容**。目录级/前缀级的说明见 [FOLDER_MAP.md](FOLDER_MAP.md)。
>
> 「行数」是**总行数（含空行）**，即 `wc -l` 的口径。⚠️ 别和 PowerShell 的
> `Get-Content … | Measure-Object -Line` 混用：那个只数**非空行**，会小几百行
> （2026-10-05 实例：`src/bridge.js` 总行 14,108 / 非空行 13,693，差 415 行空行）。
> **要在文档里写行数，就引用这里，别手抄**；二进制文件与生成物自己（本文件）不列行数（显示 `—`）。

统计：共 **326** 个被跟踪文件（其中 324 个文本文件、合计 **71,940** 行） —— 文件自带说明 **303**、人工补写 **23**、待补 **0**。

## （仓库根）

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`_snowluma-catalog.json`](../_snowluma-catalog.json) | 1,675 | SnowLuma 上游接口/事件目录快照（对照用） | 人工补写 |
| [`.gitignore`](../.gitignore) | 79 | 忽略清单：config.json / state/ / audio/ / node_modules 等本机数据与依赖 | 人工补写 |
| [`.npmrc`](../.npmrc) | 1 | npm 行为设置（本仓库用于安装源/缓存相关开关） | 人工补写 |
| [`群公告.md`](../群公告.md) | 67 | 【小鲸鱼使用说明】持续更新 | 文件自带（正文首句） |
| [`config.example.json`](../config.example.json) | 468 | 运行配置模板（真实 config.json 不入库）。每一项的语义见 README「配置」一节 | 人工补写 |
| [`INSTALL_NOTES.md`](../INSTALL_NOTES.md) | 2,212 | qq-bridge 安装记录（本机 D:\dsh\qq-bridge） | 文件自带（标题） |
| [`LICENSE`](../LICENSE) | 149 | MIT 许可证正文 | 人工补写 |
| [`NOTICE.md`](../NOTICE.md) | 43 | 第三方组件与许可声明（含 SnowLuma EULA 相关的合规说明） | 人工补写 |
| [`package-lock.json`](../package-lock.json) | 1,748 | 依赖锁定（npm 生成，别手改） | 人工补写 |
| [`package.json`](../package.json) | 62 | 包定义与 npm 脚本入口（test:*/verify:*/probe:*/postinstall 都在这里） | 人工补写 |
| [`README.en.md`](../README.en.md) | 149 | QQ ↔ DeepSeek Harness Bridge (qq-bridge) | 文件自带（标题） |
| [`README.md`](../README.md) | 280 | QQ ↔ DeepSeek Harness 桥接 | 文件自带（标题） |
| [`restart.bat`](../restart.bat) | 26 | 先杀旧守护窗口与旧桥接（按锁文件 PID + 命令行兜底），确认退出后再拉起守护窗口 | 人工补写 |
| [`RULES.md`](../RULES.md) | 163 | QQ 桥接权限与安全规则（RULES） | 文件自带（标题） |
| [`start.bat`](../start.bat) | 19 | 桥接守护启动器：先收紧 state/ 权限，再在 :loop 里跑 bridge.js，退出 5 秒后自动重启 | 人工补写 |
| [`watchdog.cmd`](../watchdog.cmd) | 24 | 外部看门狗启动器（双击即用；必须住在桥接进程外，见 FOLDER_MAP / INSTALL_NOTES 16.4） | 人工补写 |

## assets

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`deepseek娘.png`](../assets/deepseek娘.png) | — | 仓库用的形象图资源（README/文档引用） | 人工补写 |

## docs

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`群公告-新版草稿.md`](../docs/群公告-新版草稿.md) | 51 | 群公告（bot 第一人称版） | 文件自带（标题） |
| [`AFFINITY.md`](../docs/AFFINITY.md) | 149 | 好感度（关系）系统设计 —— 阶段 1 | 文件自带（标题） |
| [`FEED.md`](../docs/FEED.md) | 137 | 投喂（赞助）功能设计 | 文件自带（标题） |
| [`FILE_INDEX.md`](../docs/FILE_INDEX.md) | — | 文件索引（FILE_INDEX） | 文件自带（标题） |
| [`FOLDER_MAP.md`](../docs/FOLDER_MAP.md) | 186 | 仓库目录地图（FOLDER_MAP） | 文件自带（标题） |
| [`MEMES.md`](../docs/MEMES.md) | 157 | 本地表情包库（memes：接入 dsh-meme 图库） | 文件自带（标题） |
| [`MODERATION.md`](../docs/MODERATION.md) | 178 | 群管理：禁言 + 群公告 | 文件自带（标题） |
| [`PROJECT_GUIDE.md`](../docs/PROJECT_GUIDE.md) | 371 | DSH QQ 桥接（qq-bridge）项目说明书 | 文件自带（标题） |
| [`README.md`](../docs/README.md) | 92 | 文档索引（docs/README.md） | 文件自带（标题） |

## docs/guides

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`CONSOLE-UI-TESTING.md`](../docs/guides/CONSOLE-UI-TESTING.md) | 74 | 控制台离线预览与回归测试 | 文件自带（标题） |
| [`DSH_SETUP.md`](../docs/guides/DSH_SETUP.md) | 113 | DSH 端安装说明（本机或另一台设备） | 文件自带（标题） |
| [`PRIVACY.md`](../docs/guides/PRIVACY.md) | 95 | 发布前隐私检查（PRIVACY） | 文件自带（标题） |
| [`SECURITY_BASELINE.md`](../docs/guides/SECURITY_BASELINE.md) | 147 | 安全基线与威胁模型（qq-bridge → QSH） | 文件自带（标题） |
| [`TOKEN_USAGE_CONSOLE.md`](../docs/guides/TOKEN_USAGE_CONSOLE.md) | 159 | 控制台「令牌与花费」看板 | 文件自带（标题） |

## dsh/agent-presets/qq-chat

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`agent.cordis.yml`](../dsh/agent-presets/qq-chat/agent.cordis.yml) | 93 | The `qq-chat` agent preset: QQ 群聊机器人（最低权限面）。 | 文件自带 |
| [`preset.yml`](../dsh/agent-presets/qq-chat/preset.yml) | 3 | name: QQ 聊天角色 | 文件自带 |
| [`qq-tool-restrict.mjs`](../dsh/agent-presets/qq-chat/qq-tool-restrict.mjs) | 7 | re-export 壳：qq-tool-restrict 的权威实现只有一份，在 | 文件自带 |

## dsh/agent-presets/qq-chat-v2

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`agent.cordis.yml`](../dsh/agent-presets/qq-chat-v2/agent.cordis.yml) | 241 | The `qq-chat-v2` agent preset: 二代仿真模式（reserved2）专用。 | 文件自带 |
| [`preset.yml`](../dsh/agent-presets/qq-chat-v2/preset.yml) | 3 | name: QQ 聊天角色（二代仿真） | 文件自带 |
| [`qq-tool-restrict.mjs`](../dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs) | 7 | re-export 壳：qq-tool-restrict 的权威实现只有一份，在 | 文件自带 |

## dsh/skills/codex-image

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`SKILL.md`](../dsh/skills/codex-image/SKILL.md) | 75 | 生图技能说明（Codex CLI 出图，走 owner 的 ChatGPT 订阅，无需 API key） | 人工补写 |

## dsh/skills/codex-image/scripts

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`codex-image.ps1`](../dsh/skills/codex-image/scripts/codex-image.ps1) | 211 | 生图技能实现：调 codex exec 生成图片并拷到指定路径（自动探测系统代理） | 人工补写 |

## plugins/qq-agent-presets

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`package.json`](../plugins/qq-agent-presets/package.json) | 15 | qq-bridge 的 DSH agent preset bundle：把 qq-chat / qq-chat-v2 作为 @deepseek-ai/dsh-agent-preset 行插入（DSH 0.1.7+ 的 preset 机制），并携带两个 preset 共用的 qq-tool-restrict 安全守卫 | 文件自带（JSON 字段） |
| [`qq-tool-restrict.mjs`](../plugins/qq-agent-presets/qq-tool-restrict.mjs) | 201 | QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。 | 文件自带 |

## plugins/qq-agent-presets/presets

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`qq-chat-v2.patch.yml`](../plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml) | 78 | 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。 | 文件自带 |
| [`qq-chat.patch.yml`](../plugins/qq-agent-presets/presets/qq-chat.patch.yml) | 54 | 本文件由 scripts/build-agent-preset-patches.mjs 生成，请勿手工编辑。 | 文件自带 |

## plugins/qq-mode-console

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`cordis.patch.yml`](../plugins/qq-mode-console/cordis.patch.yml) | 11 | entry 的 **id 必须等于插件注册的设置命名空间名**（`qq-mode`，见 lib/index.js 的 | 文件自带 |
| [`package.json`](../plugins/qq-mode-console/package.json) | 16 | QQ bridge mode console for DeepSeek Harness settings UI (chat / closed-agent / reserved / reserved2) | 文件自带（JSON 字段） |

## plugins/qq-mode-console/lib

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`index.js`](../plugins/qq-mode-console/lib/index.js) | 21 | QQ mode settings use loader entry id `qq-mode` and Config, not runtime registration. | 文件自带 |

## public

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`console.html`](../public/console.html) | 5,190 | 桥接自带控制台前端（127.0.0.1:3100）：设置、状态、二代会话面板、语音试发等 | 人工补写 |

## roles

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`傲娇助手.md`](../roles/傲娇助手.md) | 7 | 傲娇助手 | 文件自带（标题） |
| [`小鲸鱼.md`](../roles/小鲸鱼.md) | 215 | 角色卡：DeepSeek 小鲸鱼 —— QQ 群友版 | 文件自带（标题） |
| [`README.md`](../roles/README.md) | 89 | 人格卡目录说明与写法约定 | 人工补写 |

## scripts

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`add-balance-rule.mjs`](../scripts/add-balance-rule.mjs) | 56 | 在 qq-chat-v2 预设里加入第 28 条：余额查询 | 文件自带 |
| [`add-image-rule.mjs`](../scripts/add-image-rule.mjs) | 49 | 在 qq-chat-v2 预设里加入第 29 条：生图 | 文件自带 |
| [`affinity-admin.mjs`](../scripts/affinity-admin.mjs) | 65 | 用 Node 调好感度接口（原生 UTF-8，避免 PowerShell 5.1 的 -Body 编码坑） | 文件自带 |
| [`affinity-file-admin.mjs`](../scripts/affinity-file-admin.mjs) | 105 | 离线改好感度：直接改 state/social-v2.json（桥接没开时用；开着会被内存覆盖，请停桥上用或改用 HTTP 接口） | 文件自带 |
| [`affinity-report.mjs`](../scripts/affinity-report.mjs) | 79 | 群友好感度报表（只读）：从运行中的桥接拉当前分数，附今日变动与最近原因。 | 文件自带 |
| [`apply-allowlists.mjs`](../scripts/apply-allowlists.mjs) | 33 | 按核实过的号写入两个项目的白名单配置 | 文件自带 |
| [`archive-dsh-sessions.mjs`](../scripts/archive-dsh-sessions.mjs) | 140 | 归档 DSH 会话：把不再使用的会话目录搬到 ~/.dsh/sessions-archive/ 下（**可逆**，不删任何东西）。 | 文件自带 |
| [`arknights-daily.mjs`](../scripts/arknights-daily.mjs) | 14 | !/usr/bin/env node | 文件自带 |
| [`arknights-setup.ps1`](../scripts/arknights-setup.ps1) | 5 | 「明日方舟日活」一次性提权安装 | 文件自带 |
| [`audit-bridge-harness.mjs`](../scripts/audit-bridge-harness.mjs) | 183 | Execute the real bridge initialization/functions against temporary files and fake peers. | 文件自带 |
| [`backup-before-upgrade.ps1`](../scripts/backup-before-upgrade.ps1) | 57 | 升级前完整备份：仓库运行数据 + preset + DSH 配置 + git bundle | 文件自带 |
| [`bili-login.mjs`](../scripts/bili-login.mjs) | 75 | !/usr/bin/env node | 文件自带 |
| [`bili-transcribe.py`](../scripts/bili-transcribe.py) | 214 | !/usr/bin/env python3 | 文件自带 |
| [`build-agent-preset-patches.mjs`](../scripts/build-agent-preset-patches.mjs) | 172 | !/usr/bin/env node | 文件自带 |
| [`check-announcement-draft.mjs`](../scripts/check-announcement-draft.mjs) | 25 | 提交前本地校验：公告正文是否过得了桥接的 validateAnnouncement（长度/链接/@全体/敏感特征）。 | 文件自带 |
| [`check-braces.mjs`](../scripts/check-braces.mjs) | 90 | 精确一点的 JS 括号平衡检查：正确处理字符串、模板字面量（含 ${} 嵌套）、注释与正则字面量。 | 文件自带 |
| [`check-bridge-identifiers.mjs`](../scripts/check-bridge-identifiers.mjs) | 144 | 静态自检：找出"被当作函数调用、但既没声明也没导入"的标识符。 | 文件自带 |
| [`check-console-ui.mjs`](../scripts/check-console-ui.mjs) | 50 | 控制台页面自检：新增的 memes 控件是否 html/js 都接上了（排查手写 UI 漏接）。 | 文件自带 |
| [`check-onebot-status.mjs`](../scripts/check-onebot-status.mjs) | 68 | 查询 SnowLuma 网关与 QQ 会话状态：HTTP API + WebSocket | 文件自带 |
| [`check-preset-admin-rules.mjs`](../scripts/check-preset-admin-rules.mjs) | 62 | 只读校验：预设里的规则编号/关键规则是否齐（手写 YAML 容易漏或串号）。 | 文件自带 |
| [`check-preset-rules.mjs`](../scripts/check-preset-rules.mjs) | 18 | 校验两个 preset 的规则完整性（YAML 可解析 + 关键规则都在） | 文件自带 |
| [`cleanup-stale-sessions.mjs`](../scripts/cleanup-stale-sessions.mjs) | 87 | !/usr/bin/env node | 文件自带 |
| [`close-dsh.mjs`](../scripts/close-dsh.mjs) | 56 | !/usr/bin/env node | 文件自带 |
| [`close-dsh.ps1`](../scripts/close-dsh.ps1) | 38 | close-dsh.ps1 - started by the QQ agent on user request: wait a bit, then stop the DSH web process. | 文件自带 |
| [`console-status.mjs`](../scripts/console-status.mjs) | 41 | 读桥接控制台状态，定位「会话繁忙」的原因 | 文件自带 |
| [`console-ui-contracts.json`](../scripts/console-ui-contracts.json) | 470 | 控制台 UI 契约基线（npm run test:console-ui 用；只有后端契约真变时才重录） | 人工补写 |
| [`console-ui-fixture.mjs`](../scripts/console-ui-fixture.mjs) | 597 | !/usr/bin/env node | 文件自带 |
| [`console-ui-legacy-ids.json`](../scripts/console-ui-legacy-ids.json) | 227 | 控制台历史元素 id 清单（回归用：确保老 id 没被悄悄删掉） | 人工补写 |
| [`debug-auth.mjs`](../scripts/debug-auth.mjs) | 43 | 隔离测试：用配置里的 cookie 分别走 raw fetch 和 NodeApiClient，看差在哪 | 文件自带 |
| [`dsh-modules.mjs`](../scripts/dsh-modules.mjs) | 66 | 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。 | 文件自带 |
| [`dsh-tool-names.mjs`](../scripts/dsh-tool-names.mjs) | 83 | Read-only inventory of tool registrations in the installed DSH packages. | 文件自带 |
| [`dsh-with-token.mjs`](../scripts/dsh-with-token.mjs) | 65 | 启动 DSH 并自动捕获 launch token 写入 config.json | 文件自带 |
| [`dump-session-reasoning.mjs`](../scripts/dump-session-reasoning.mjs) | 31 | 打印某个 DSH 会话里模型每一步的 reasoning 摘要（做"它为什么没做某件事"的复盘用）。 | 文件自带 |
| [`dump-session-tail.mjs`](../scripts/dump-session-tail.mjs) | 63 | 解码某个 DSH 会话（zstd 分帧）并打印最近的工具调用/结果，用于还原"模型到底看到了什么" | 文件自带 |
| [`endfield-daily.mjs`](../scripts/endfield-daily.mjs) | 17 | !/usr/bin/env node | 文件自带 |
| [`endfield-setup.ps1`](../scripts/endfield-setup.ps1) | 5 | 「明日方舟：终末地日活」一次性提权安装 | 文件自带 |
| [`feed-admin.mjs`](../scripts/feed-admin.mjs) | 70 | 投喂账本命令行（HTTP 调桥接接口，UTF-8 安全，别用 PowerShell 发中文） | 文件自带 |
| [`find-brace-drift.mjs`](../scripts/find-brace-drift.mjs) | 74 | 用「锚点前缀扫描」定位合并后括号失衡（多一个 { 或少一个 }）出现的区间。 | 文件自带 |
| [`find-syntax-error.mjs`](../scripts/find-syntax-error.mjs) | 33 | 用 DSH 自带的 @babel/parser 精确定位语法错误（node --check 只报个笼统位置）。 | 文件自带 |
| [`fix-preset-order.mjs`](../scripts/fix-preset-order.mjs) | 49 | 把 qq-chat-v2 preset 里误插到 26 前面的 27 条移到 26 后面，并统一缩进 | 文件自带 |
| [`fix-stuck-session.mjs`](../scripts/fix-stuck-session.mjs) | 41 | 看桥接的挂起队列 / 处理情况，必要时重置卡住的会话 | 文件自带 |
| [`forge-dsh-cookie.mjs`](../scripts/forge-dsh-cookie.mjs) | 86 | 用 DSH 持久 secret 自签浏览器会话 cookie，并写入桥接配置（免 launch token） | 文件自带 |
| [`game-daily-setup.ps1`](../scripts/game-daily-setup.ps1) | 102 | 游戏日活：**一次性**提权安装（必须用管理员身份运行本脚本） | 文件自带 |
| [`game-daily.mjs`](../scripts/game-daily.mjs) | 1,509 | !/usr/bin/env node | 文件自带 |
| [`gen-file-index.mjs`](../scripts/gen-file-index.mjs) | 205 | gen-file-index.mjs —— 生成 docs/FILE_INDEX.md：**每个被跟踪文件干什么**，一句话。 | 文件自带 |
| [`gen-image-worker.mjs`](../scripts/gen-image-worker.mjs) | 419 | !/usr/bin/env node | 文件自带 |
| [`get-agent-token.mjs`](../scripts/get-agent-token.mjs) | 28 | 取当前会话的 agent token（仅用于本地验证限制逻辑） | 文件自带 |
| [`harden-state-acl.mjs`](../scripts/harden-state-acl.mjs) | 121 | state/ 目录权限收紧的「可提权」入口。 | 文件自带 |
| [`inspect-meme-pack.mjs`](../scripts/inspect-meme-pack.mjs) | 25 | 只读：打印 dsh-meme 图库索引结构与样例（排查用） | 文件自带 |
| [`install-skills.mjs`](../scripts/install-skills.mjs) | 99 | !/usr/bin/env node | 文件自带 |
| [`list-affinity.mjs`](../scripts/list-affinity.mjs) | 89 | list-affinity.mjs —— 只读列出某个会话的**全员好感度**（owner 巡检 / 回答"现在大家多少分"用） | 文件自带 |
| [`make-config.mjs`](../scripts/make-config.mjs) | 48 | 从 config.example.json 生成 config.json（已存在则跳过、绝不覆盖） | 人工补写 |
| [`meme-flow-test.mjs`](../scripts/meme-flow-test.mjs) | 125 | 本地表情包链路自检（不依赖桥接进程）。 | 文件自带 |
| [`patch-dsh-at-file-settings.mjs`](../scripts/patch-dsh-at-file-settings.mjs) | 38 | Reproducible compatibility patch for the pinned dsh-at-file 0.7.0 git build. | 文件自带 |
| [`patch-dsh-base64.mjs`](../scripts/patch-dsh-base64.mjs) | 140 | !/usr/bin/env node | 文件自带 |
| [`patch-snowluma-sdk.mjs`](../scripts/patch-snowluma-sdk.mjs) | 48 | 修复 @snowluma 系列 npm 包的发布打包 bug：dist 内的相对导入缺少 .js 扩展名， | 文件自带 |
| [`preflight-publish.mjs`](../scripts/preflight-publish.mjs) | 130 | 发布前体检：把"将要提交的文件"里可能泄漏的内容扫一遍（不会修改任何东西）。 | 文件自带 |
| [`privacy-rules.example.json`](../scripts/privacy-rules.example.json) | 16 | 本地专用规则模板。复制为 privacy-rules.json 后填写你自己的真实标识；privacy-rules.json 必须加进 .gitignore（它含你的 QQ 号/路径）。本模板本身不含真实数据，可以入库。 | 文件自带（JSON 字段） |
| [`privacy-scan.mjs`](../scripts/privacy-scan.mjs) | 282 | 发布前隐私与敏感信息扫描（**离线、只读、不联网**）。 | 文件自带 |
| [`probe-015.mjs`](../scripts/probe-015.mjs) | 85 | 探测 DSH 0.1.5-rc.1 的 Web API 协议表面（只读，不改动 DSH 状态）。 | 文件自带 |
| [`probe-afdian.mjs`](../scripts/probe-afdian.mjs) | 46 | 爱发电凭据自检：验证 token 是否有效 + 拉一页历史订单（订单号脱敏，不回显 token） | 文件自带 |
| [`probe-affinity-clock.mjs`](../scripts/probe-affinity-clock.mjs) | 50 | probe-affinity-clock.mjs —— 检查好感度数据里的**时间字段是否错位**（排查"分数不涨/不衰减"用） | 文件自带 |
| [`probe-affinity-prompt.mjs`](../scripts/probe-affinity-prompt.mjs) | 48 | 检查最新 QQ 会话里有没有注入好感度（关系）面板，并打印片段 | 文件自带 |
| [`probe-balance-tool.mjs`](../scripts/probe-balance-tool.mjs) | 63 | 用 MCP stdio 协议实测：服务器能否启动、是否列出 qq_get_balance、调用是否返回余额 | 文件自带 |
| [`probe-ban-plumbing.mjs`](../scripts/probe-ban-plumbing.mjs) | 40 | 只读探活：只验证"禁言动作能不能被 QQ 侧正确理解"，不会禁言任何真人。 | 文件自带 |
| [`probe-bili-brief.mjs`](../scripts/probe-bili-brief.mjs) | 42 | 真机验证字幕模块：抓取 → 分层精编 → 分页 → 缓存命中 | 文件自带 |
| [`probe-bili-comments.mjs`](../scripts/probe-bili-comments.mjs) | 54 | 探测 B 站评论接口：哪些在"登录态 + DoH 直连"下可用 | 文件自带 |
| [`probe-bili-direct.mjs`](../scripts/probe-bili-direct.mjs) | 38 | 决定性验证：走"B 站专用通道（DoH 直连）"，元信息 + 字幕还能不能拿到 | 文件自带 |
| [`probe-bili-needlogin.mjs`](../scripts/probe-bili-needlogin.mjs) | 44 | 同一接口、同一视频：带登录态 vs 匿名 —— 证明"空数组 + need_login_subtitle"是匿名现象 | 文件自带 |
| [`probe-bili-shortlink.mjs`](../scripts/probe-bili-shortlink.mjs) | 21 | 复现 + 验证：群里那条 B 站短链现在能不能抓（这是本次事故的核心） | 文件自带 |
| [`probe-bili-subtitle.mjs`](../scripts/probe-bili-subtitle.mjs) | 75 | 真机探针：① 登录态 ② 滑动续期有没有发生 ③ 字幕接口真实返回形状 | 文件自带 |
| [`probe-bridge.mjs`](../scripts/probe-bridge.mjs) | 53 | 只读探活：桥接控制台是否在跑、什么模式、AI 是否暂停、表情包库状态。 | 文件自带 |
| [`probe-codex-logs.mjs`](../scripts/probe-codex-logs.mjs) | 38 | 一次性排查脚本：看 codex CLI 自己的日志库里最近发生了什么 | 文件自带 |
| [`probe-codex-recent.mjs`](../scripts/probe-codex-recent.mjs) | 15 | 看 codex 日志库里最近 N 分钟的记录（判断 codex exec 卡在哪一步） | 文件自带 |
| [`probe-codex-strings.mjs`](../scripts/probe-codex-strings.mjs) | 27 | 在 codex.exe 里找 "refresh_strategy" 附近的字符串，看有没有可配置项/环境变量能跳过联网刷新模型列表 | 文件自带 |
| [`probe-codex-strings2.mjs`](../scripts/probe-codex-strings2.mjs) | 27 | 打印 codex.exe 里 refresh_strategy / cache_ttl 附近的完整字符串块，推断配置键名 | 文件自带 |
| [`probe-console-ui.mjs`](../scripts/probe-console-ui.mjs) | 69 | 控制台 UI 体检：确认「我们本地的面板」确实在**桥接实际发出的页面**里，并报告它们所在的 | 文件自带 |
| [`probe-current-notice.mjs`](../scripts/probe-current-notice.mjs) | 22 | 看一眼群里当前公告正文（走桥接控制台 API，只读）。 | 文件自带 |
| [`probe-doc-coverage.mjs`](../scripts/probe-doc-coverage.mjs) | 47 | 探针：现有文档对"每个文件的作用"覆盖到什么程度？ | 文件自带 |
| [`probe-dsh-token.mjs`](../scripts/probe-dsh-token.mjs) | 45 | 验证 DSH launch token：GET /?token=XXX 看是否返回 set-cookie | 文件自带 |
| [`probe-endfield-launch.mjs`](../scripts/probe-endfield-launch.mjs) | 113 | probe-endfield-launch.mjs —— 抓一次「终末地到底是怎么被拉起来的」（只读观察，不启动游戏） | 文件自带 |
| [`probe-engines.mjs`](../scripts/probe-engines.mjs) | 28 | 直接探测各搜索引擎的可用性（不经 MCP） | 文件自带 |
| [`probe-events.mjs`](../scripts/probe-events.mjs) | 100 | 端到端验证：remote.mux 事件流 + turn 收集 + 工具调用事件形状。 | 文件自带 |
| [`probe-foldermap-facts.mjs`](../scripts/probe-foldermap-facts.mjs) | 90 | probe-foldermap-facts.mjs —— docs/FOLDER_MAP.md 的**人读版**事实核对表（只读）。 | 文件自带 |
| [`probe-group-admin.mjs`](../scripts/probe-group-admin.mjs) | 57 | 只读探活：机器人在群里的身份（能否禁言/发公告）+ 群管理结构 + SnowLuma 相关动作可用性。 | 文件自带 |
| [`probe-headers.mjs`](../scripts/probe-headers.mjs) | 30 | 测不同 UA / 请求头下各引擎能否返回结果 | 文件自带 |
| [`probe-image-tool-auth.mjs`](../scripts/probe-image-tool-auth.mjs) | 43 | 验证「生图工具的调用形状」是否被桥接接受（只跑不扣配额的前置校验 consume:false）。 | 文件自带 |
| [`probe-live-features.mjs`](../scripts/probe-live-features.mjs) | 100 | 升级后的「活体功能自检」：只读地打桥接控制台的各个本地特性端点，确认它们在 0.1.7 上仍然活着。 | 文件自带 |
| [`probe-mcp-server.mjs`](../scripts/probe-mcp-server.mjs) | 51 | 通用 MCP 探测：启动一个 stdio MCP 服务，列出工具名，可选调用一次 | 文件自带 |
| [`probe-mcp-tools.mjs`](../scripts/probe-mcp-tools.mjs) | 44 | 探针：当前 src/mcp-snowluma-safe.js 实际注册了哪些工具（按 config.json 的开关过滤后）。 | 文件自带 |
| [`probe-models.mjs`](../scripts/probe-models.mjs) | 53 | 读取 DSH 的 settings/describe，列出所有 namespace 与可选模型（只读）。 | 文件自带 |
| [`probe-relevance.mjs`](../scripts/probe-relevance.mjs) | 34 | 诊断：为什么搜索结果不相关 | 文件自带 |
| [`probe-rpc-compat.mjs`](../scripts/probe-rpc-compat.mjs) | 104 | 对比探测：逐条验证桥接实际使用的 RPC 参数形状在新版 DSH 上是否被接受。 | 文件自带 |
| [`probe-search-fields.mjs`](../scripts/probe-search-fields.mjs) | 45 | 只打印 web_search 的关键字段（source / relevance / 前几条标题），避免被长 snippet 截断 | 文件自带 |
| [`probe-search-quality.mjs`](../scripts/probe-search-quality.mjs) | 70 | 诊断搜索质量：分别看 Bing RSS / Bing HTML / 百度 三条链路对同一条中文查询的真实返回 | 文件自带 |
| [`probe-session-search.mjs`](../scripts/probe-session-search.mjs) | 65 | 在所有 QQ 会话里搜关键词，打印命中会话里的 web_search / web_fetch 调用与结果（用来判断搜索质量） | 文件自带 |
| [`probe-snowluma-actions.mjs`](../scripts/probe-snowluma-actions.mjs) | 11 | 只读：列出 SnowLuma 支持的群相关动作，确认有没有"转让群主"之类的接口。 | 文件自带 |
| [`probe-speaker-wake.mjs`](../scripts/probe-speaker-wake.mjs) | 36 | 只读排查：AI 什么时候给谁设过「指定成员唤醒」(triggers.speakerIds)。 | 文件自带 |
| [`probe-tools.mjs`](../scripts/probe-tools.mjs) | 99 | 端到端验证 QQ preset 的「工具面」与「工具协议」： | 文件自带 |
| [`probe-voice-send.mjs`](../scripts/probe-voice-send.mjs) | 38 | 语音链路体检（经桥接，**不发送**）：用「只校验不发送」跑一遍 /api/voice/send， | 文件自带 |
| [`probe-voice-status.mjs`](../scripts/probe-voice-status.mjs) | 45 | 语音功能现状体检：MCP 工具是否注册、控制台语音面板在哪一组、配置与依赖是否就绪。 | 文件自带 |
| [`probe-webfetch.mjs`](../scripts/probe-webfetch.mjs) | 56 | 实测 web_fetch 的 HTML 提取效果：用 agent 当时抓失败的页面 | 文件自带 |
| [`probe-websearch.mjs`](../scripts/probe-websearch.mjs) | 37 | 测 web_search 的实际返回 | 文件自带 |
| [`probe-workspace.mjs`](../scripts/probe-workspace.mjs) | 65 | 验证 workspace/session RPC 参数形状与返回值结构（对照 bridge.js 实际用法）。 | 文件自带 |
| [`propose-notice.mjs`](../scripts/propose-notice.mjs) | 35 | 把草稿正文提交到桥接的「待审公告」队列（owner 私聊回「通过」/控制台点按钮后才会发布）。 | 文件自带 |
| [`read-dsh-session-log.mjs`](../scripts/read-dsh-session-log.mjs) | 26 | 读 DSH 的会话记录（session.v4.jsonl.zstd）并打印尾部事件，用于诊断端到端用例里模型做了什么。 | 文件自带 |
| [`redact-personal.mjs`](../scripts/redact-personal.mjs) | 116 | 发布前脱敏：把真实群号/QQ/昵称/本机用户名替换成占位符。 | 文件自带 |
| [`replay-dsh-attempt.mjs`](../scripts/replay-dsh-attempt.mjs) | 47 | 复盘一次失败的 assistant/attempt：把流式 chunk 汇总成「块类型 / 工具名 / 工具入参原文 / 结束原因」。 | 文件自带 |
| [`run-offline-tests.mjs`](../scripts/run-offline-tests.mjs) | 59 | 本机离线回归总入口：顺序跑 scripts/test-*.mjs，跳过依赖外部环境的用例 | 文件自带 |
| [`scan-dsh-session-errors.mjs`](../scripts/scan-dsh-session-errors.mjs) | 94 | 扫 DSH 会话记录（session.v4.jsonl.zstd）找报错：解压后按行解析，挑出 error / tool input / | 文件自带 |
| [`scan-dsh-tool-names.mjs`](../scripts/scan-dsh-tool-names.mjs) | 16 | Compare real package tool registrations with the QQ preset's restriction list. | 文件自带 |
| [`send-test-card.mjs`](../scripts/send-test-card.mjs) | 33 | 发一张卡图到指定群，验证网关发图链路（用本地文件的 base64，兼容性最好） | 文件自带 |
| [`send-test-group.mjs`](../scripts/send-test-group.mjs) | 40 | 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。 | 文件自带 |
| [`send-voice.mjs`](../scripts/send-voice.mjs) | 483 | !/usr/bin/env node | 文件自带 |
| [`set-admin-config.mjs`](../scripts/set-admin-config.mjs) | 88 | 配置群管理：开关干跑、设置干跑截止时间、禁言播报模板、白名单等（离线改，需重启桥接生效）。 | 文件自带 |
| [`set-afdian-key.mjs`](../scripts/set-afdian-key.mjs) | 62 | 写入/更新投喂相关配置（config.json 在 .gitignore 里，不入库） | 文件自带 |
| [`set-onebot-token.mjs`](../scripts/set-onebot-token.mjs) | 52 | 把 SnowLuma 的 OneBot HTTP/WS accessToken 统一设为指定令牌，并同步给两个机器人 | 文件自带 |
| [`set-tavily-key.mjs`](../scripts/set-tavily-key.mjs) | 26 | 把外部 API 密钥写进 config.json（该文件已在 .gitignore 里，不入库） | 文件自带 |
| [`setup-dsh.mjs`](../scripts/setup-dsh.mjs) | 368 | !/usr/bin/env node | 文件自带 |
| [`show-notice.mjs`](../scripts/show-notice.mjs) | 24 | 只读：打印当前群公告全文（含所有历史公告的标题/时间），供改写参考。 | 文件自带 |
| [`show-recent.mjs`](../scripts/show-recent.mjs) | 29 | 只读：把最近 N 条群消息按时间正序打出来（谁说的、内容、是否引用/带图、是否 @ 机器人）。 | 文件自带 |
| [`sync-onebot-tokens.mjs`](../scripts/sync-onebot-tokens.mjs) | 46 | 把 SnowLuma 的 HTTP / WS 两个 token 分别同步到桥接配置 | 文件自带 |
| [`sync-snowluma-token.mjs`](../scripts/sync-snowluma-token.mjs) | 88 | 把 SnowLuma 的 OneBot accessToken 同步进 qq-bridge 配置，并实测连接 | 文件自带 |
| [`test-admin-routes.mjs`](../scripts/test-admin-routes.mjs) | 108 | 群管理路由验收（不会真的禁言；公告只走"起草→校验→作废"，不发布）。 | 文件自带 |
| [`test-affinity.mjs`](../scripts/test-affinity.mjs) | 126 | 好感度引擎单测：node scripts/test-affinity.mjs | 文件自带 |
| [`test-agent-preset-patches.mjs`](../scripts/test-agent-preset-patches.mjs) | 123 | 钉住 DSH 0.1.7 preset 装配的「防漂移」契约（纯离线，不需要 DSH 在跑）： | 文件自带 |
| [`test-arknights-command.mjs`](../scripts/test-arknights-command.mjs) | 51 | arknights-command 纯函数回归（触发命令判定 + 状态描述）：不联网、不碰 MAA/QQ。 | 文件自带 |
| [`test-arknights-daily.mjs`](../scripts/test-arknights-daily.mjs) | 301 | arknights-daily 执行器的离线回归：不联网、不起 MAA、不杀进程（全部注入假实现）。 | 文件自带 |
| [`test-audit-bridge.mjs`](../scripts/test-audit-bridge.mjs) | 440 | test-audit 子模块：桥接行为审计（跑在 audit-bridge-harness 的虚拟网关上） | 人工补写 |
| [`test-audit-protocol-helpers.mjs`](../scripts/test-audit-protocol-helpers.mjs) | 42 | test-audit 子模块：协议审计的公共辅助函数 | 人工补写 |
| [`test-audit-protocol.mjs`](../scripts/test-audit-protocol.mjs) | 376 | Offline regression tests. No real DSH/QQ endpoints or local credentials are read. | 文件自带 |
| [`test-audit-security-mcp.mjs`](../scripts/test-audit-security-mcp.mjs) | 164 | Exercise MCP callbacks with a fake transport: no network, config or stdio server. | 文件自带 |
| [`test-audit-security.mjs`](../scripts/test-audit-security.mjs) | 171 | Offline regression tests: no sockets, QQ messages, production config or secrets. | 文件自带 |
| [`test-audit-setup-guards.mjs`](../scripts/test-audit-setup-guards.mjs) | 88 | Execute both real preset plugins against a captured tools service, without DSH/QQ. | 文件自带 |
| [`test-audit-setup.mjs`](../scripts/test-audit-setup.mjs) | 132 | Offline integration tests. Every setup invocation receives its own repository and DSH_HOME. | 文件自带 |
| [`test-audit.mjs`](../scripts/test-audit.mjs) | 53 | Safe audit suite: fixtures and mocks only, never production QQ/DSH. | 文件自带 |
| [`test-bili-auth.mjs`](../scripts/test-bili-auth.mjs) | 200 | B 站登录态（cookie jar 滑动续期 + 扫码续期）的离线回归。 | 文件自带 |
| [`test-bili-comments.mjs`](../scripts/test-bili-comments.mjs) | 92 | B 站热评（辅助理解）的离线回归：清洗 / 挑选 / 注入文案 / 接线 | 文件自带 |
| [`test-bili-direct.mjs`](../scripts/test-bili-direct.mjs) | 102 | B 站直连通道的离线回归：域名判定 / DoH 解析与缓存 / 回落行为 / 接线守卫 | 文件自带 |
| [`test-bili-online.mjs`](../scripts/test-bili-online.mjs) | 52 | P1/P2/P3 的源码守卫：把"在线交付 / 按需工具 / 兜底唤醒"三条路钉住 | 文件自带 |
| [`test-bili-subtitle.mjs`](../scripts/test-bili-subtitle.mjs) | 216 | B 站字幕：清洗 / 时间桶抽样 / 分层精编 / 分页 的离线回归（不联网） | 文件自带 |
| [`test-card-link.mjs`](../scripts/test-card-link.mjs) | 115 | 卡片链接解析的离线回归：各种真实形态的 QQ 卡片 JSON + 兜底路径。 | 文件自带 |
| [`test-console-encoding.mjs`](../scripts/test-console-encoding.mjs) | 69 | 验证「Windows 控制台乱码 + chcp 修复」的机制是否成立。 | 文件自带 |
| [`test-console-static.mjs`](../scripts/test-console-static.mjs) | 74 | 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。 | 文件自带 |
| [`test-console-ui.mjs`](../scripts/test-console-ui.mjs) | 589 | !/usr/bin/env node | 文件自带 |
| [`test-console.mjs`](../scripts/test-console.mjs) | 107 | 控制台增强功能综合测试（node 直接调 API） | 文件自带 |
| [`test-dsh-auth.mjs`](../scripts/test-dsh-auth.mjs) | 136 | DSH 鉴权适配回归测试（0.1.7 起）。 | 文件自带 |
| [`test-dsh-v2-wait.mjs`](../scripts/test-dsh-v2-wait.mjs) | 97 | 二代等待逻辑的「实时」端到端测试：真建一个 qq-chat-v2 会话并向 DSH 提问， | 文件自带 |
| [`test-encoding.mjs`](../scripts/test-encoding.mjs) | 54 | 启动器与编码自检： | 文件自带 |
| [`test-endfield-daily.mjs`](../scripts/test-endfield-daily.mjs) | 511 | 终末地档案（MAAEND/MXU）的离线回归：档案默认值、声明式补丁、多日志监听、计数式完成判据。 | 文件自带 |
| [`test-face-media.mjs`](../scripts/test-face-media.mjs) | 73 | QQ 内置表情（face）取图回落：faceImageUrlCandidates 的单元测试 + bridge 接线检查 | 文件自带 |
| [`test-feed.mjs`](../scripts/test-feed.mjs) | 166 | 投喂模块单测：node scripts/test-feed.mjs（不联网，网络部分用假 fetch） | 文件自带 |
| [`test-foldermap-facts.mjs`](../scripts/test-foldermap-facts.mjs) | 137 | 防漂移：docs/FOLDER_MAP.md 的**结构类事实**必须与仓库/工作区现状一致。 | 文件自带 |
| [`test-forward.mjs`](../scripts/test-forward.mjs) | 136 | 合并转发消息能力自检脚本： | 文件自带 |
| [`test-hardening.mjs`](../scripts/test-hardening.mjs) | 131 | 2026-09-20 体检修复的回归测试。 | 文件自带 |
| [`test-image-ack.mjs`](../scripts/test-image-ack.mjs) | 105 | 生图开始提示（ack）验收：渲染预览 + 配置生效检查（不会往群里发消息）。 | 文件自带 |
| [`test-image-backend.mjs`](../scripts/test-image-backend.mjs) | 178 | Agent Plan 生图后端：纯函数 + 请求构造 + 错误路径的离线回归（不联网） | 文件自带 |
| [`test-image-skill.mjs`](../scripts/test-image-skill.mjs) | 96 | 生图技能「入库」验收： | 文件自带 |
| [`test-image-state.mjs`](../scripts/test-image-state.mjs) | 58 | 生图状态口径验收（只读 + 单元）：失败后模型不能再被"没有状态"误导着说"正在画"。 | 文件自带 |
| [`test-impersonator-guard.mjs`](../scripts/test-impersonator-guard.mjs) | 91 | 冒名守卫的离线回归：只认"像 bot 名"的组合、正确生成新名片、护栏齐全 | 文件自带 |
| [`test-link-bilibili.mjs`](../scripts/test-link-bilibili.mjs) | 100 | B 站元信息摘要的离线回归（纯函数 + 不触网的早退路径）。 | 文件自带 |
| [`test-link-window.mjs`](../scripts/test-link-window.mjs) | 42 | 链接窗口必须读 v2 存储 —— 事故回归 | 文件自带 |
| [`test-mcp-agent-token.mjs`](../scripts/test-mcp-agent-token.mjs) | 74 | 回归：MCP 里每个「智能体调用」都必须带 x-agent-token 头。 | 文件自带 |
| [`test-mcp-exec.mjs`](../scripts/test-mcp-exec.mjs) | 48 | 测试 @snowluma/mcp 的 write 模式：模拟 DSH MCP 客户端完整握手 | 文件自带 |
| [`test-mcp-host.mjs`](../scripts/test-mcp-host.mjs) | 23 | 测试桥接自带的 snowluma-host MCP server（status/start/stop） | 文件自带 |
| [`test-mcp-safe.mjs`](../scripts/test-mcp-safe.mjs) | 91 | 测试安全版 QQ MCP server：工具清单 + 白名单发送校验 | 文件自带 |
| [`test-mcp-servers-stdio.mjs`](../scripts/test-mcp-servers-stdio.mjs) | 43 | 模拟 DSH 的 dsh-mcp-client：以 stdio 拉起桥接的 MCP server，握手并列出工具， | 文件自带 |
| [`test-mcp-web-search.mjs`](../scripts/test-mcp-web-search.mjs) | 37 | 测试安全 Web Search / Fetch MCP server： | 文件自带 |
| [`test-md-to-plain.mjs`](../scripts/test-md-to-plain.mjs) | 52 | md-to-plain 纯函数回归测试（不依赖 SnowLuma / DSH / QQ）。 | 文件自带 |
| [`test-meme-prompt.mjs`](../scripts/test-meme-prompt.mjs) | 47 | 只读验收：确认唤醒提示/Prompt 里真的带上了「本地表情包库」段落。 | 文件自带 |
| [`test-meme-routes.mjs`](../scripts/test-meme-routes.mjs) | 80 | 桥接「本地表情包」路由验收（只读/只做校验路径，不会真发消息到 QQ）。 | 文件自带 |
| [`test-memes.mjs`](../scripts/test-memes.mjs) | 293 | meme-lib 单元测试：纯函数 + 真实图库只读自检。 | 文件自带 |
| [`test-moderation-dedupe.mjs`](../scripts/test-moderation-dedupe.mjs) | 103 | 2026-10-20 事故回归：同一条消息被重复投递 100 次 ⇒ 刷屏判定数到 50 次 ⇒ 误禁言群友 | 文件自带 |
| [`test-moderation.mjs`](../scripts/test-moderation.mjs) | 469 | moderation.js 单元测试：检测规则 / 时长阶梯 / 豁免 / 限流 / 公告校验 / 动作白名单。 | 文件自带 |
| [`test-mood-bridge.mjs`](../scripts/test-mood-bridge.mjs) | 121 | mood-bridge（鱼的心情适配）的离线回归：只改 targetSession、不碰别的、坏文件不覆盖 | 文件自带 |
| [`test-mood.mjs`](../scripts/test-mood.mjs) | 202 | 自研心情引擎的离线回归：口径正确（心情不许因为被怼而下降）、衰减、记账门槛、注入模式 | 文件自带 |
| [`test-mute-live.mjs`](../scripts/test-mute-live.mjs) | 50 | 真机禁言验证：对指定 QQ 禁言 N 秒，确认成功后**立即解禁**（默认 60 秒 → 验证完就解开）。 | 文件自带 |
| [`test-mux-reconnect.mjs`](../scripts/test-mux-reconnect.mjs) | 81 | 事件流重连回归测试：DSH 重启 / WS 断开后，**已有会话必须被重新 follow**。 | 文件自带 |
| [`test-onebot-connection.mjs`](../scripts/test-onebot-connection.mjs) | 53 | 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关， | 文件自带 |
| [`test-owner-dm.mjs`](../scripts/test-owner-dm.mjs) | 59 | 验证「owner 私聊命令」链路（用控制台模拟器，不需要 owner 真的发消息）。 | 文件自带 |
| [`test-persona-lines.mjs`](../scripts/test-persona-lines.mjs) | 105 | persona-lines.js 单元测试：桥接"替机器人说的话"（禁言播报 / 生图开始提示）。 | 文件自带 |
| [`test-preset-local-tools.mjs`](../scripts/test-preset-local-tools.mjs) | 260 | 铁律 L7 的注册期断言：仿真会话的 preset **不得包含本地执行能力**。 | 文件自带 |
| [`test-preset-prompt.mjs`](../scripts/test-preset-prompt.mjs) | 173 | 仿真提示词改写（src/preset-prompt.js）的离线单测。 | 文件自带 |
| [`test-qq-mode-plugin.mjs`](../scripts/test-qq-mode-plugin.mjs) | 15 | DSH 0.2 obtains settings metadata from Config and never calls register(). | 文件自带 |
| [`test-qq-model-view.mjs`](../scripts/test-qq-model-view.mjs) | 273 | 端到端用例：确认模型侧看到的 QQ 工具清单/会话视图符合预期（在 npm run test:token 里） | 人工补写 |
| [`test-qq-preset-contract.mjs`](../scripts/test-qq-preset-contract.mjs) | 197 | reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。 | 文件自带 |
| [`test-quote-ref.mjs`](../scripts/test-quote-ref.mjs) | 79 | 引用消息"身份证"的离线回归（纯函数 + 源码接线守卫）。 | 文件自带 |
| [`test-quote-url.mjs`](../scripts/test-quote-url.mjs) | 59 | 引用消息里的链接必须完整 —— 事故现场回归 | 文件自带 |
| [`test-reply-wait.mjs`](../scripts/test-reply-wait.mjs) | 203 | First-reply quiet-window regressions. Real bridge handlers, fixture peers only. | 文件自带 |
| [`test-role-card.mjs`](../scripts/test-role-card.mjs) | 108 | 人格卡按仿真模式取用（src/role-card.js）的离线单测。 | 文件自带 |
| [`test-setup-dsh-idempotent.mjs`](../scripts/test-setup-dsh-idempotent.mjs) | 127 | setup-dsh.mjs 幂等性测试：在一个临时 DSH_HOME 里连跑两次， | 文件自带 |
| [`test-slang-learn.mjs`](../scripts/test-slang-learn.mjs) | 65 | 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。 | 文件自带 |
| [`test-snowluma-conn.mjs`](../scripts/test-snowluma-conn.mjs) | 115 | SnowLuma 账号/token 自发现自检。 | 文件自带 |
| [`test-snowluma-liveness.mjs`](../scripts/test-snowluma-liveness.mjs) | 87 | SnowLuma 链路存活看门狗验收。 | 文件自带 |
| [`test-speech-mode.mjs`](../scripts/test-speech-mode.mjs) | 138 | 说话姿态判定的离线回归：用真实群聊风格的话验证阈值 | 文件自带 |
| [`test-stickers.mjs`](../scripts/test-stickers.mjs) | 158 | 表情包体系自检： | 文件自带 |
| [`test-token-economy.mjs`](../scripts/test-token-economy.mjs) | 624 | Exercise real bridge HTTP handlers and prompt delivery with isolated files, | 文件自带 |
| [`test-token-usage.mjs`](../scripts/test-token-usage.mjs) | 303 | Token 用量账本 + 价目表测试。 | 文件自带 |
| [`test-tts-service.mjs`](../scripts/test-tts-service.mjs) | 120 | tts-service 的离线回归：按需拉起、并发只拉一次、空闲 30 分钟自动关 | 文件自带 |
| [`test-turn-retry.mjs`](../scripts/test-turn-retry.mjs) | 102 | 回合级重试策略单测：工具参数写成非法 JSON（MALFORMED_RESPONSE）时该不该自动重发。 | 文件自带 |
| [`test-v2-wait.mjs`](../scripts/test-v2-wait.mjs) | 92 | 二代“对面没说完 / 结束前等待”逻辑测试。 | 文件自带 |
| [`test-vision-media.mjs`](../scripts/test-vision-media.mjs) | 82 | 视觉/图片链路自检脚本： | 文件自带 |
| [`test-voice-edge.mjs`](../scripts/test-voice-edge.mjs) | 136 | 并发与边界体检：确认语音系统在「同时多个请求 / 异常输入 / 重名 / 缺目录」下不炸、不乱。 | 文件自带 |
| [`test-voice-gui.mjs`](../scripts/test-voice-gui.mjs) | 239 | 图形界面（voice-gui.mjs + public/voice.html）自检： | 文件自带 |
| [`test-voice-preview.mjs`](../scripts/test-voice-preview.mjs) | 110 | 图形界面音量端点验证（live）：/api/preview 必须真的按音量产出不同音频。 | 文件自带 |
| [`test-voice-system.mjs`](../scripts/test-voice-system.mjs) | 186 | 语音系统整体自检（结构层）：把「独立工具 + qq-bridge 语音系统」的所有入口、依赖、 | 文件自带 |
| [`test-voice-transcribe.mjs`](../scripts/test-voice-transcribe.mjs) | 172 | voice-transcribe（收到语音 → 转写文本）纯函数 + 假网关回归测试：不依赖 SnowLuma / DSH / QQ。 | 文件自带 |
| [`test-voice-volume.mjs`](../scripts/test-voice-volume.mjs) | 188 | 音量调节自检： | 文件自带 |
| [`test-voice.mjs`](../scripts/test-voice.mjs) | 343 | 语音发送自检： | 文件自带 |
| [`test-wake-backlog.mjs`](../scripts/test-wake-backlog.mjs) | 78 | 积压唤醒的离线回归：过期丢弃 + 只补最新（纯函数）+ bridge 接线守卫。 | 文件自带 |
| [`test-wake-delivered.mjs`](../scripts/test-wake-delivered.mjs) | 57 | "交付给当前回合的积压唤醒没被接住 → 回合结束要重排" 的源码守卫 | 文件自带 |
| [`test-watchdog-bridge.mjs`](../scripts/test-watchdog-bridge.mjs) | 247 | watchdog-bridge（外部看门狗）纯函数 + 假探针回归测试：不联网、不杀进程、不启动桥接。 | 文件自带 |
| [`trace-depth.mjs`](../scripts/trace-depth.mjs) | 58 | 找出 main() 的 body 在哪里被提前闭合（括号深度第一次回到 0 的那一行）。 | 文件自带 |
| [`unify-onebot-token.mjs`](../scripts/unify-onebot-token.mjs) | 76 | 把 SnowLuma 的 OneBot HTTP/WS accessToken 统一成同一个值，并触发配置重载 + 复测 | 文件自带 |
| [`upgrade-dsh-017.mjs`](../scripts/upgrade-dsh-017.mjs) | 216 | !/usr/bin/env node | 文件自带 |
| [`verify-agent-presets-017.mjs`](../scripts/verify-agent-presets-017.mjs) | 87 | 验证 DSH 0.1.7 的 agent preset 是否真的装上了（只读探测 + 断言）。 | 文件自带 |
| [`verify-dsh-015-adaptation.mjs`](../scripts/verify-dsh-015-adaptation.mjs) | 199 | DSH 适配总验证（0.1.5 建立，0.1.7 迁移后继续沿用文件名以免打断既有调用）： | 文件自带 |
| [`verify-dsh-020.mjs`](../scripts/verify-dsh-020.mjs) | 54 | Local-only smoke checks. No prompts, QQ sends, or existing-session mutations. | 文件自带 |
| [`verify-ids.mjs`](../scripts/verify-ids.mjs) | 59 | 核实 ownerQQ / 群号：查机器人账号、好友、群列表、指定群是否存在 | 文件自带 |
| [`verify-onebot.mjs`](../scripts/verify-onebot.mjs) | 47 | 用官方 SDK 通过 OneBot WebSocket 验证：登录的是哪个号、群列表、能否发消息（只读调用，不发送） | 文件自带 |
| [`verify-persona-config.mjs`](../scripts/verify-persona-config.mjs) | 74 | 用 DSH 自身的 dsh-persona 配置 schema 校验修复后的 preset persona 配置。 | 文件自带 |
| [`verify-preset-rule.mjs`](../scripts/verify-preset-rule.mjs) | 31 | 校验 preset YAML 可解析，检查 27 条是否生效，并同步回仓库源 | 文件自带 |
| [`watchdog-bridge.mjs`](../scripts/watchdog-bridge.mjs) | 431 | !/usr/bin/env node | 文件自带 |
| [`zstd-frames.mjs`](../scripts/zstd-frames.mjs) | 49 | 读 DSH 的会话记录文件（session.v4.jsonl.zstd）。这些文件是**多帧 zstd 拼接**的， | 文件自带 |

## scripts/fixtures

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`console.before.html`](../scripts/fixtures/console.before.html) | 2,195 | QQ 桥接控制台 | 文件自带（title） |

## src

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`affinity.js`](../src/affinity.js) | 329 | affinity.js — 群友好感度（关系）引擎：**纯函数**，不依赖桥接内存，方便单测。 | 文件自带 |
| [`ark-image.mjs`](../src/ark-image.mjs) | 140 | 火山方舟 **Agent Plan**（视觉模型）生图后端。 | 文件自带 |
| [`arknights-command.js`](../src/arknights-command.js) | 82 | 明日方舟日活：**触发命令的判定**（纯函数，可离线测试）。 | 文件自带 |
| [`bili-auth.js`](../src/bili-auth.js) | 316 | B 站登录态管理：① cookie jar 滑动续期 ② 失效时扫码续期（给桥接用） | 文件自带 |
| [`bili-comments.js`](../src/bili-comments.js) | 146 | B 站评论（辅助理解用）：给"看完字幕"再加一层「观众怎么看」。 | 文件自带 |
| [`bili-direct.js`](../src/bili-direct.js) | 198 | B 站专用通道：**DoH 拿真实 IP → 直连**（绕过 mihomo 的 fake-ip / 代理路由） | 文件自带 |
| [`bili-subtitle.js`](../src/bili-subtitle.js) | 286 | B 站字幕：抓取 → 清洗 → 分层压缩（长字幕适配）→ 缓存 + 按时间分页 | 文件自带 |
| [`bridge.js`](../src/bridge.js) | 14,881 | QQ ↔ DeepSeek Harness 桥接主程序。 | 文件自带 |
| [`card-link.js`](../src/card-link.js) | 231 | QQ 分享卡片 / 小程序卡片 → 抽出「来源 + 标题 + 链接」的可读文本。 | 文件自带 |
| [`dsh-client.js`](../src/dsh-client.js) | 913 | Node 环境的 DSH Web API 客户端。 | 文件自带 |
| [`feed.js`](../src/feed.js) | 389 | feed.js — 投喂（赞助）账本 + 爱发电订单核验 + DeepSeek 余额水位 | 文件自带 |
| [`forward.js`](../src/forward.js) | 220 | 合并转发消息（合并聊天记录）相关纯函数： | 文件自带 |
| [`image-ack.js`](../src/image-ack.js) | 100 | image-ack.js —— 生图请求的文本识别 + 回执去重（纯函数，可单测）。 | 文件自带 |
| [`image-failure-text.mjs`](../src/image-failure-text.mjs) | 58 | 生图失败时**给群友看的文案**：如实区分「首选后端」和「回落后端」各自的失败原因。 | 文件自带 |
| [`impersonator-guard.js`](../src/impersonator-guard.js) | 88 | 冒名守卫：群友把昵称/群名片改成"像 bot 的名字"时，自动给他改成「冒名·X」。 | 文件自带 |
| [`link-bilibili.js`](../src/link-bilibili.js) | 176 | B 站链接 → 结构化短摘要（免登录官方接口）。 | 文件自带 |
| [`mcp-host-server.js`](../src/mcp-host-server.js) | 93 | SnowLuma 网关状态查询 MCP server（stdio）。 | 文件自带 |
| [`mcp-qq-wait.js`](../src/mcp-qq-wait.js) | 105 | mcp-qq-wait.js — **只**暴露 qq_wait_for_messages 的独立 MCP stdio 服务。 | 文件自带 |
| [`mcp-snowluma-safe.js`](../src/mcp-snowluma-safe.js) | 1,722 | 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。 | 文件自带 |
| [`mcp-web-search-safe.js`](../src/mcp-web-search-safe.js) | 539 | 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。 | 文件自带 |
| [`md-to-plain.js`](../src/md-to-plain.js) | 110 | 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。 | 文件自带 |
| [`meme-lib.js`](../src/meme-lib.js) | 399 | 本地表情包库（dsh-meme 图库接入）——纯函数 + 只读索引。 | 文件自带 |
| [`model-prices.js`](../src/model-prices.js) | 290 | DeepSeek 官方价目表与峰谷分时判定（桥接侧自行维护）。 | 文件自带 |
| [`moderation.js`](../src/moderation.js) | 658 | moderation.js —— 群管理（禁言 / 群公告）的**确定性内核**：纯函数 + 只读文件工具。 | 文件自带 |
| [`mood-bridge.js`](../src/mood-bridge.js) | 73 | 「鱼的心情」(dsh-feiyu-mood) 的本地适配：把它的目标会话跟我们的会话 id 同步。 | 文件自带 |
| [`mood.js`](../src/mood.js) | 349 | 自研「心情」引擎（2026-10-23）：替代 dsh-feiyu-mood 的判断部分，**保留它的 UI**。 | 文件自带 |
| [`persona-lines.js`](../src/persona-lines.js) | 68 | persona-lines.js —— 桥接"替机器人说的一句话"（群里播报）的模板池与挑选器。 | 文件自带 |
| [`preset-prompt.js`](../src/preset-prompt.js) | 157 | 二代仿真预设提示词（「仿真」层）的读取与安全改写。 | 文件自带 |
| [`qq-model-view.js`](../src/qq-model-view.js) | 80 | Only the model-facing view is compacted. Stored messages and console/API data | 文件自带 |
| [`quote-ref.js`](../src/quote-ref.js) | 114 | 引用消息的"身份证"：把「引用的是谁、哪一条、带什么附件」写清楚，供模型直接定位。 | 文件自带 |
| [`role-card.js`](../src/role-card.js) | 108 | 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。 | 文件自带 |
| [`safe-fetch.js`](../src/safe-fetch.js) | 372 | 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。 | 文件自带 |
| [`self-test.js`](../src/self-test.js) | 116 | 自测脚本：不依赖 SnowLuma / QQ，只验证 DSH 侧链路—— | 文件自带 |
| [`send-voice-lib.js`](../src/send-voice-lib.js) | 31 | 语音发送共享库 —— 薄转发层（唯一实现在 voice-core.js）。 | 文件自带 |
| [`sensitive.js`](../src/sensitive.js) | 15 | 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。 | 文件自带 |
| [`slang-learner.js`](../src/slang-learner.js) | 373 | 群聊黑话/网络用语学习与迭代模块。 | 文件自带 |
| [`snowluma-conn.js`](../src/snowluma-conn.js) | 223 | SnowLuma 连接自发现：解决「换 QQ 账号后 token 变了，工具就 401」的问题。 | 文件自带 |
| [`snowluma-liveness.mjs`](../src/snowluma-liveness.mjs) | 63 | SnowLuma 链路存活判定（纯函数，便于单测）。 | 文件自带 |
| [`speech-mode.js`](../src/speech-mode.js) | 159 | 说话姿态（speech mode）：让 bot 区分「答题态」与「闲扯态」 | 文件自带 |
| [`state-acl.mjs`](../src/state-acl.mjs) | 140 | state/ 目录 ACL 收紧的**唯一实现**。 | 文件自带 |
| [`sticker-lib.js`](../src/sticker-lib.js) | 295 | 表情包体系（二代仿真模式）——本地表情知识库与策略提示纯函数。 | 文件自带 |
| [`token-ledger.js`](../src/token-ledger.js) | 938 | Token 用量账本：把 DSH 会话事件里的 provider usage 落成「按会话 × 按回合」的可查明细， | 文件自带 |
| [`tts-service.js`](../src/tts-service.js) | 158 | 语音服务（GPT-SoVITS API）的按需生命周期管理。 | 文件自带 |
| [`tts.js`](../src/tts.js) | 125 | 日文 TTS：把文本合成为语音文件，放进语音库目录（现有 qq_send_voice 直接可发）。 | 文件自带 |
| [`turn-retry.mjs`](../src/turn-retry.mjs) | 45 | 回合级错误的重试策略（纯函数，便于单测）。 | 文件自带 |
| [`v2-wait.js`](../src/v2-wait.js) | 27 | 二代仿真模式：等待/结束回合相关的轻量判断工具。 | 文件自带 |
| [`voice-core.js`](../src/voice-core.js) | 501 | 语音发送的共享内核：独立工具（上级 voice-tool/ 的 voice-cli.mjs / voice-gui.mjs）与桥接都用同一套规则。 | 文件自带 |
| [`voice-transcribe.js`](../src/voice-transcribe.js) | 210 | 收到的语音 → 文字（「听懂语音」）。 | 文件自带 |
| [`wake-backlog.js`](../src/wake-backlog.js) | 34 | "繁忙期间积压的唤醒"怎么挑：① 过期的丢掉 ② 只补最新那条。 | 文件自带 |

## src/core

| 文件 | 行数 | 作用 | 来源 |
| --- | ---: | --- | --- |
| [`session-router.mjs`](../src/core/session-router.mjs) | 623 | Per-conversation policy routing for the QQ bridge. | 文件自带 |
| [`session-router.test.mjs`](../src/core/session-router.test.mjs) | 353 | src/core/session-router.mjs 的单测 | 人工补写 |
