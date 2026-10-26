# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`scripts/` 里的命名约定是什么、哪些脚本像是过期的一次性产物。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)；**逐个文件**的说明见
> [FILE_INDEX.md](FILE_INDEX.md)。
>
> **正文一律不写行数 / 文件个数 / 扩展名构成**：这些一律引用自动生成的
> [FILE_INDEX.md](FILE_INDEX.md)（它带「行数」列与统计行）。曾经这里手抄过这些数字，
> 等发现时已经全错（行数差 30%+、文件数少 20 个）；而且"行数"本身还有口径陷阱 ——
> `wc -l` 数总行、PowerShell `Measure-Object -Line` 只数**非空行**，两者能差几百行
> （`src/bridge.js`：总行 14,108 / 非空 13,693，差的全是 415 行空行）。要引用就引用
> FILE_INDEX，别手抄、也别自己现算。
>
> 结构类事实（各目录的子目录、工作区根列出的项是否真实存在、正文提到的脚本是否还在）
> 由 `scripts/test-foldermap-facts.mjs` 断言；**加了目录/脚本请连文档一起改**，
> 然后跑 `npm run docs:file-index`。
>
> 最后核对：2026-10-05（按事实修正 7 处过时描述 + 加防漂移测试；同日再修 4 处：
> §4 的"已清理"清单、去掉正文里的数字、`.npm-cache`、补登记 `patch-dsh-base64.mjs`）。

---

## 一、顶层布局

工作区根（本机 `D:\dsh`）里与本仓库**运行/启动/回滚相关**的项：

```
D:\dsh/                       ← 工作区根（不是仓库根）
├── qq-bridge/                ← 本仓库：QQ ↔ DSH 桥接
├── snowluma/                 ← OneBot 网关本体（第三方；按账号配置 config/onebot_<QQ>.json）
├── tools/                    ← 外部启动器：桌面「启动Bot」的 start-bot.bat、卡图机器人等
└── qq-bridge-backup-*/       ← 升级/改动前的备份（config.json / state/ / 仓库 bundle）
```

> ⚠️ 上面**只列与本仓库相关的项，不是工作区全貌**：工作区根另有 40+ 项与本项目无关的目录与文件
> （游戏、模拟器、聊天记录、一堆实验脚本与文档），本节不罗列。
> 判据是"与本仓库的运行/启动/回滚有关"，所以工作区里出现新目录不会自动进这张表。
>
> 上游把独立「发语音」工具拆出了本仓库（`../voice-tool/`），**本机未安装**；本仓库的语音功能
> 不依赖它（`src/voice-core.js` 是同一份实现）。结构参考见第五节。

`qq-bridge/` 内部：

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核**：主程序、DSH 客户端、MCP server、黑话/表情/语音/好感度等共享库（每个文件干什么见 [FILE_INDEX.md](FILE_INDEX.md)） | 不能动。`bridge.js` 是主程序（**体量很大、还在长**，QSH 计划里要拆分；具体行数以 [FILE_INDEX.md](FILE_INDEX.md) 统计为准，别在本文件手抄）；`voice-core.js` 与 `snowluma-conn.js` 是**独立工具也在用的单一实现**；`voice-transcribe.js` 是**收**语音转写的共享实现（发送走 `voice-core.js`，两者方向相反、互不依赖）。**目录里只应有 `.js`**：曾经的 `bridge.js.bak-*` 会污染全局搜索并看起来像 module，2026-09-20 已移出（见下） |
| `scripts/` | 调试 / 测试 / 一次性运维脚本（见第二节命名约定） | 测试脚本不能删；`cleanup-*` / `fix-*` / `patch-*` / `diag-*` 多为历史遗留 |
| `dsh/` | 要装进 DSH 的东西：`agent-presets/qq-chat`、`agent-presets/qq-chat-v2`（preset 与工具白名单 `qq-tool-restrict.mjs`），以及 `skills/`（Codex 技能，如 `codex-image` 生图） | 改 preset 会影响所有人设行为 |
| `plugins/` | DSH 插件：`qq-mode-console`（注册 `qq-mode` 设置命名空间；**只有 host 半**，浏览器 UI 卡片未实现）、`qq-agent-presets`（把两个 preset 作为 `@deepseek-ai/dsh-agent-preset` 行插进 DSH，并携带共用的 `qq-tool-restrict` 守卫） | 改了要重装/重启 DSH |
| `public/` | 浏览器静态资源：`console.html`（桥接自带控制台，127.0.0.1:3100） | 目录里只应有这一个文件；历史备份 `console.html.bak` 已移出仓库 |
| `roles/` | 人格卡（`小鲸鱼.md` / `傲娇助手.md` / `README.md`）：控制台「人格与角色」页可编辑，保存即生效 | 用户内容，别乱动 |
| `assets/` | 仓库用图片等资源（`deepseek娘.png`；`project-intro.mp4` 已改为 Release 附件、不入库） | 别加体积大的二进制 |
| `audio/` | **语音库**（用户的真实音频）。桥接的 AI 语音工具只能发这里的文件；独立 `voice-tool` 默认也指向这里 | **用户文件，绝不删除/移动** |
| `state/` | **运行时数据**（会话映射、模式、角色、黑话库、日志、锁、令牌）。`.gitignore` 排除 | **用户数据，绝不删除/移动** |
| `docs/` | 全部文档，按用途分子目录（见第三节） | 见第三节 |
| `node_modules/` | 依赖（`.gitignore` 排除）。⚠️ npm 缓存**不在仓库里**（本仓库只有 `.npmrc` 这项设置；`.gitignore` 里那条 `.npm-cache/` 是给别处可能出现的缓存目录兜底的） | 忽略 |
| `config.json` | 运行配置（真实配置**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

---

## 二、`scripts/` 命名约定

脚本的数量与扩展名构成**会变，本文不写**——见 `npm run docs:file-index` 生成的
[FILE_INDEX.md](FILE_INDEX.md)（带「行数」列与统计行）。按前缀区分用途：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | **自动化测试**。其中被 `scripts/test-audit.mjs` 列进 `tests[]` 的那些会跑在 `npm run test:audit` 里（离线、不发真 QQ 消息、不用生产凭据） | 保留，改动需同步 test-audit 清单 |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-protocol` / `-security` / `-setup` 及其 `-helpers`/`-guards`），被上一个直接运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/`（含 `.html` 基线，如 `fixtures/console.before.html`） | 控制台**离线浏览器回归**与基线（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 保留（基线只在后端契约真变时才重录） |
| `send-*.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具（`send-voice.mjs` 走桥接；`send-test-group.mjs` 发测试群） | 保留，但注意会真的发消息 |
| `setup-*.mjs` | **安装/初始化**：把 preset、MCP 挂载写进目标设备的 DSH（`setup-dsh.mjs`，幂等） | 保留 |
| `verify-*.mjs` | **一致性校验**：`verify-dsh-015-adaptation.mjs`（DSH 适配）、`verify-persona-config.mjs`（人格配置） | 保留 |
| `probe-*.mjs` | **一次性探针**：用来问 DSH/SnowLuma「实际支持什么」（RPC 形状、工具清单、事件流、工作区、模型） | 多半已用完；见第四节 |
| `audit-bridge-harness.mjs` | 虚拟网关 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` 使用） | 保留 |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `watchdog-bridge.mjs`（+ `test-watchdog-bridge.mjs`、仓库根的 `watchdog.cmd`） | **外部看门狗**：每 30s 探一次桥接控制台 `/api/status`，连续 3 次无响应就判定「假死」→ 留证（`state/watchdog.log` + `state/watchdog-incident-*.json`，含进程 CPU/内存与 `bridge.log` 尾巴）→ 杀掉卡死进程 → 等 `start.bat` 自己拉回来，30s 没回来就自己拉。**必须住在桥接进程外**（进程内的定时器会跟着一起卡死），由 `watchdog.cmd` / 桌面启动器 `start-bot.bat` 拉起，日志 `state/watchdog.log`，暂停用空文件 `state/watchdog.pause` | 保留（运维常驻；2026-09-29 假死事故的直接对策，见 INSTALL_NOTES 16.3 / 16.4） |
| `dsh-modules.mjs` | 小工具：按路径加载 DSH 安装内的模块 | 保留 |
| `game-daily.mjs`（+ `arknights-daily.mjs` / `endfield-daily.mjs` 薄 wrapper、`game-daily-setup.ps1`、`test-arknights-daily.mjs` / `test-endfield-daily.mjs`） | **游戏日活（提权）**：一个引擎、两个档案（`DEFAULT_ARKNIGHTS` / `DEFAULT_ENDFIELD`，见 `PROFILES`）。流程＝预检 → **先起官方 PC 端**（`Arknights.exe` / `Endfield.exe`，两者清单都是 `requireAdministrator`；桌面图标只开启动器）→ 等窗口就绪 → 起工具（MAA 直接继承提权；**MAAEND 经 `explorer.exe` 降权到普通权限**，因为它自己不需要管理员）→ 盯日志等「跑完」（方舟 `AllTasksCompleted`；终末地 `Tasker.Task.Succeeded` 数到当前实例任务数）→ 跑完即停、30 分钟兜底 → 关工具与游戏 → 写 `state/<游戏>-daily.json`。`game-daily-setup.ps1 -Profile …` 是**一次性提权安装**（注册最高权限计划任务 + 声明式补丁把工具设成"启动即跑"，必须 UTF-8 with BOM）。触发判定/回报措辞的纯函数在 `src/arknights-command.js`；桥接**自身不提权**，只在 owner 发那两句命令时确定性接管并 `schtasks /Run` | 保留（见 INSTALL_NOTES 16.5 / 16.5.1 / 16.5.2 / 16.5.3 / 16.6） |
| `check-onebot-status.mjs` | 手工排查：查 OneBot 连通性 | 保留（运维常用） |
| `list-affinity.mjs` | **只读列出某会话的全员好感度**（排名/档位/当日变动/最近互动 + 印象备注 + 档位人数统计）。档位判定直接复用 `src/affinity.js` 的 `tierOf()`，与提示词、控制台口径一致。用途：owner 巡检、回答"现在大家多少分"、排查某人是不是被扣分。**好感度是内部状态，输出别贴群里**。用法 `node scripts/list-affinity.mjs [group:群号]` | 保留（owner 运维） |
| `probe-affinity-clock.mjs` | 诊断：打印每个成员的时间字段（`dailyDate` / `dailyDelta` / `lastInteractAt` / `lastScoreAt`）与"现在"，对超出当前时间 60s 的标 ⚠。用途：分辨"真没人互动"与"时间戳错位"（时钟被改 / state 被写脏 / 测试注入假时间）导致的分不涨、不衰减。只读。与 `list-affinity.mjs` 分工：那个看排名，这个看时间基准 | 保留（诊断） |
| `check-announcement-draft.mjs` | 提交群公告前的**本地预检**：过一遍 `validateAnnouncement`（字数 ≤600 / UTF-8 ≤1400 字节 / 禁链接 / 禁 @全体 / 禁本机路径特征），并打印**与现行公告的逐行差异**。用途：避免草稿被 QQ 服务端或桥接直接拒（实测 603 字被拒）。用法 `node scripts/check-announcement-draft.mjs <草稿文件>` | 保留（公告流程） |
| `probe-current-notice.mjs` | 只读查看**群里当前公告正文**与是否还有待审草稿（走桥接控制台 `/api/socialV2/admin-status`，需 `state/console-token`）。用途：确认上一版公告是否已被替换、机器人是不是管理员、草稿有没有卡住 | 保留（公告流程） |
| `gen-file-index.mjs` | **生成 [FILE_INDEX.md](FILE_INDEX.md)**：逐文件一句话（优先取文件自身的开头注释，其次内置 OVERLAY 表，两者都没有就如实写「待补」，不猜）。`--check` 比对漂移（退出 1，可挂回归）、`--stdout` 只打印。npm：`docs:file-index` / `docs:file-index:check`。**FILE_INDEX.md 是生成物，别手改** | 保留（文档基建） |
| `probe-endfield-launch.mjs` | 抓一次「终末地到底是怎么被拉起来的」（只读，不启动游戏）：记录 `Endfield.exe` 的完整命令行 / 父进程 / 启动瞬间被新增改动的文件。2026-10-23 就是靠它抓到 `U8Data\config\Launcher.meta` 这张启动器票据，从而确认「直启被拒」是启动器侧的校验、不是参数问题。启动器改版后先跑它再改 `game-daily` | 保留（游戏日活排障） |
| `probe-doc-coverage.mjs` | 诊断：统计各目录「有多少文件在文档里被点名」，用来量化文档腐化程度（当初就是靠它发现 272 个文件里只有 62 个在 FOLDER_MAP 里点名、132 个在任何文档里都找不到）。只读 | 保留（文档体检） |
| `test-foldermap-facts.mjs` | **防本文漂移的回归**：断言 `dsh/` `plugins/` `docs/` 的子目录与 docs/ 根级 md 都被本文点到、§1 目录树里每一项在磁盘上真实存在、`voice-tool` 不存在时本文必须写"本机未安装"、**正文不许再手抄行数/文件总数**（出现即失败），并顺带跑一次 `gen-file-index --check`。自动被 `run-offline-tests.mjs` 收录 | 保留（改目录/文档后必跑） |
| `probe-foldermap-facts.mjs` | 上面那个测试的**人读版**：把同样的核对项打印成一张对照表（文档写什么 / 实际多少），用于手工体检或写报告。只读 | 保留（文档体检） |
| `*.ps1` | **提权/运维脚本**（非 Node）：`game-daily-setup.ps1`、`arknights-setup.ps1`、`endfield-setup.ps1`（日活工具的一次性提权安装，必须 UTF-8 with BOM）、`backup-before-upgrade.ps1`（升级前备份）、`close-dsh.ps1`（旧版关 DSH；现多用 `close-dsh.mjs`，因为 WMI 起的 powershell `-File` 在本机会静默不执行） | 保留（按需） |
| `patch-*.mjs` | **补丁**（含 `postinstall` 的 `patch-snowluma-sdk.mjs`：修 `@snowluma/sdk` 的 ESM 打包 bug） | `patch-snowluma-sdk.mjs` **必须保留**（postinstall 依赖）；其余见第四节 |
| `patch-dsh-base64.mjs` | 给**全局安装的 DSH 包**打本地补丁：把会爆栈的 base64 校验正则换成线性校验（`(?:…)*` 在 V8 里递归实现，4.4MB base64 ≈3.3MB 的图就抛 `Maximum call stack size exceeded`，DSH 于是把图降级成 `[image unavailable…]`，群里的表现是"这张图死活读不出来"）。幂等、自动备份 `.bak-qqbridge`；`--check` 只看状态、`--revert` 还原 | **保留**；⚠️ `npm i -g @deepseek-ai/dsh` 之后补丁会被覆盖，**要重跑**（详见 INSTALL_NOTES） |
| `cleanup-*.mjs` | **清理一次性残留**（probe 会话/工作区、测试会话） | 见第四节 |
| `fix-*.mjs` | **一次性修复**（针对某次运行产生的脏数据） | 见第四节 |
| `diag-*.mjs` | **诊断**（如归档并清理日志） | 见第四节 |
| `debug-*.mjs` | **调试**（如白名单逻辑对照） | 见第四节 |
| `CONSOLE-UI-TESTING.md` | 已移到 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | — |

---

## 三、`docs/` 结构

**现状（2026-10-05 核对，子目录只剩 `guides/`）**：

```
docs/
├── README.md            # 文档索引（每篇一句话 + 是否仍然有效）  ← 先看这个
├── FOLDER_MAP.md        # 本文件
├── FILE_INDEX.md        # 逐文件索引（**生成物**，别手改）
├── PROJECT_GUIDE.md     # 权威项目说明书（旧位置是 guides/PROJECT_GUIDE.md，整理后落到根级）
├── AFFINITY.md          # 好感度（关系）系统
├── FEED.md              # 投喂（赞助）
├── MEMES.md             # 本地表情包库
├── MODERATION.md        # 群管理（禁言 / 公告 / 审核）
├── 群公告-新版草稿.md    # 群公告草稿（发布走的正文另见仓库根的 群公告.md）
└── guides/              # 面向使用者/运维：DSH_SETUP / VOICE / TOKEN_USAGE_CONSOLE /
                         #   CONSOLE-UI-TESTING / PRIVACY / SECURITY_BASELINE
```

> ⚠️ 本节此前写的 `design/` `research/` `audits/` `legacy/` **四个子目录已不存在**（文档整理时被合并/删除），
> 曾经"根目录只留三个文档、其余一律进子目录"的规则也与现状不符：现在根级有 9 个 md。
> **待 owner 决定**：是把 `AFFINITY`/`FEED`/`MEMES`/`MODERATION` 收进子目录（如 `docs/features/`）并恢复那条规则，
> 还是就此改成"根级放总览与功能说明、`guides/` 放操作指南"。本文只如实描述现状，不替你做这个决定。
>
> 无论怎么放，**新文档都要在 [README.md](README.md) 索引里登记一行**（含「仍然有效 / 被谁取代」）。

---

## 四、过期脚本：**已清理的**与**仍在的**

### 4.1 已清理（**这些文件现在不存在**，2026-09 整理时清掉）

> 列在这里只是留个记录，防止有人照旧版文档去 `scripts/` 找 —— 会全部落空。
> 当时的判断依据：`.gitignore` 已把它们列为「Local one-off dev/debug/patch scripts
> （machine-specific paths/IDs, or bound to artifacts of a single probe run under `state/`）」，
> 加上脚本内容绑定某一次运行留下的 `state/` 残留。
> **下面故意不写 `scripts/` 前缀**：这些路径已经不存在，写成路径形式会让人以为能点开。

| 曾经的脚本 | 当时的理由 |
| --- | --- |
| cleanup-probe-sessions / cleanup-probe-workspaces / cleanup-test-sessions | 清理某次 probe 在 DSH 里建的会话 / 工作区 / 自测会话；probe 产物已不在 |
| fix-probe-workspace-title | 修某次 probe 工作区标题的脏数据；一次性 |
| diag-archive | 诊断 + 归档日志；归档已手工完成 |
| debug-whitelist | 白名单逻辑对照调试；与 `test-audit-*` 的白名单用例重复 |
| patch-qq-chat-v2-presleep / patch-qq-chat-v2-stickers / patch-qq-chat-v2-collect-memory | 给 `qq-chat-v2` preset 打一次性补丁；内容现已直接在 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 里，重跑会重复插入 |
| patch-web-mcp-timeout | 给 DSH 的 web MCP 配置打超时补丁；属对**外部 DSH 安装**的一次性改动，重启/升级后语义就变了 |

### 4.2 仍在仓库里，但属"按需重跑 / 手工排查"

| 脚本 | 说明 |
| --- | --- |
| `scripts/probe-015.mjs` | 针对 DSH 0.1.5 的探针；结论已被 `verify-dsh-015-adaptation.mjs` 取代 |
| `scripts/probe-rpc-compat.mjs` / `probe-models.mjs` / `probe-workspace.mjs` | 一次性协议/能力探针：问完「DSH 现在长什么样」就没用了 |
| `scripts/probe-events.mjs` / `probe-tools.mjs` | 同上，但挂在 `npm run probe:*` 上，**保留、按需重跑** |
| `scripts/test-onebot-connection.mjs` / `test-mcp-exec.mjs` / `test-mcp-host.mjs` / `test-mcp-safe.mjs` / `test-mcp-web-search.mjs` | 手工排查脚本（不在 `test-audit.mjs` 清单里）；功能上被 `check-onebot-status.mjs` / `test-audit-security-mcp.mjs` 覆盖。⚠️ 名字容易与**必需的** `test-audit-*` 混淆，删之前先确认 |

### 4.3 千万别当"过期脚本"清掉

- `scripts/patch-snowluma-sdk.mjs`（`postinstall` 依赖，删了 `npm install` 就坏）
- `scripts/patch-dsh-base64.mjs`（修全局 DSH 的 base64 爆栈；**每次 `npm i -g @deepseek-ai/dsh` 后都要重跑**）
- `scripts/test-audit.mjs` 清单里的每一个
- `scripts/console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/`（控制台回归基线）
- `scripts/audit-bridge-harness.mjs`、`scripts/dsh-modules.mjs`（被测试/工具引用）

---

## 五、独立工具 `voice-tool/`（**本机未安装**；上游已把它拆出本仓库）

> 本机（2026-10-05 核对）工作区根**没有** `voice-tool/`，也没有曾经的
> `发语音-图形界面.cmd` / `重启DSH-加载语音工具.cmd` 两个启动器。下面这张表是**上游结构参考**，
> 用来对照"如果装了它，东西长什么样 / 与本仓库怎么共享代码"，**不是本机现状**。
> 日常发语音不需要它：仓库内有 `npm run send-voice`（CLI）、控制台「语音库与语音发送」面板，
> 以及 AI 侧的 `qq_send_voice`／`qq_list_voices` 工具。

| 路径 | 作用 |
| --- | --- |
| `voice-tool/voice-cli.mjs` | 命令行：交互菜单 / `send` / `list` / `check` / `remove` / `status` |
| `voice-tool/voice-gui.mjs` | 图形界面：只监听 127.0.0.1 的本地小服务 + 一次性令牌 + 浏览器 UI |
| `voice-tool/public/voice.html` | 图形界面前端（拖拽上传、试听、音量、发送、历史） |
| `voice-tool/发语音.cmd` | 命令行启动器（纯 ASCII，双击即用） |
| `voice-tool/config.json` | 工具自己的配置（**可选**）。本机显式把 `voice.voiceDir` 指向 `../qq-bridge/audio`，让已有音频继续可见 |
| `voice-tool/config.example.json` | 配置模板 |
| `voice-tool/state/` | 运行时：`voice-gui-url.txt`（当前界面地址 + 一次性令牌） |

共享内核**不复制**：工具经 `../qq-bridge/src/voice-core.js` 与 `../qq-bridge/src/snowluma-conn.js`
引同一份实现（qq-bridge 里的 `src/send-voice-lib.js` 也是转发这同一份）。

## 附：docs/ 根级文档一览（含新增）

- docs/SHARE.md —— 把这个项目交给朋友用：三种给法、绝对不能给的东西、他要准备什么、启动顺序、语音版权注意、六个常见坑。
