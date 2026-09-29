# 群管理：禁言 + 群公告

一句话：**机器人当上群管理员之后**，它多两项能力——对恶意刷屏/持续辱骂它的群友禁言 1~10 分钟，以及（经群主确认后）发布群公告。除此之外它什么都做不了：**不许踢人、不许全员禁言、不许设/撤管理员、不许改群名片或群名、不许碰群相册或群文件**。

## 1. 前提：机器人必须是群管理员

- 现在这个 QQ 号（`100000002`）在群里是**普通成员**，禁言和发公告都会被 QQ 拒绝。
- 需要群主在群里把机器人设成管理员。检查命令：`node scripts/probe-group-admin.mjs`。
- 即使在管理员位，桥接执行前还会**实时核对一次身份**（`get_group_member_info`，10 分钟缓存），不是管理员就跳过并私聊提醒群主（每小时最多提醒一次）。

## 2. 硬边界（代码级，不是提示词级）

| 能做的 | 只有这两个动作 |
| --- | --- |
| 禁言 | `set_group_ban`，时长强制 `clamp(60, 600)` 秒；`duration=0`（解禁）只允许群主手动命令 |
| 群公告 | `_send_group_notice`（发布）、`_get_group_notice`（读取） |
| 查身份 | `get_group_member_info` |

**明确禁止**（`src/moderation.js` 的 `FORBIDDEN_ACTIONS`，单测会扫描 `bridge.js` / `mcp-snowluma-safe.js` / `console.html` 确保它们不出现）：
踢人、批量踢人、全员禁言、设/撤管理员、改群名片、改群名、改群头像、匿名相关、退群、处理加群请求、**群文件全部动作**、**群相册全部动作**、删除群公告。

任何群管理动作都必须过 `assertAllowedAction()`，不在白名单里直接抛错（fail-closed）。即使将来机器人变成群主，这条也不会松。

## 3. 禁言：什么时候动手

判定全部是**确定性规则**（在 `src/moderation.js` 里，纯函数、可单测）：

| 触发 | 条件（默认值，可配） | 首次时长 |
| --- | --- | --- |
| 重复刷屏（文本） | 同一个人 **2 分钟**内重复发**完全同一句**话 ≥ **5** 次（忽略空格/标点/emoji/大小写） | 3 分钟 |
| 重复刷屏（图片） | 同一个人的**同一张图**（指纹 = QQ 图片 `file`；无则用去掉签名参数的 url）≥ **5** 次 | 3 分钟 |
| 攻击机器人 | **10 分钟**内，**针对机器人**（@它 / 引用它 / 带它名字）的辱骂累计 ≥ **3** 条 | 5 分钟 |

阶梯：24 小时内第 2 次 +2 分钟，第 3 次及以后 +4 分钟（`base + step × 已禁言次数`），最后 clamp 到 **1~10 分钟**。

**明确不动手的情况**：观点不同、抬杠、开玩笑调侃、说它笨、骂别人、一次口角、同图发两三次。判定要求"同内容重复"或"针对机器人的辱骂"，不做泛化的言论审查。

### 豁免与限流（防误伤 / 防风控）

- **永不禁言**：ownerQQ、群主、**所有群管理员**、机器人自己、`admin.whitelist` 里的 QQ。
- 每人冷却 30 分钟；每人每天最多 2 次；全局每小时 3 次、每天 10 次。
- 已禁言中的人不会被重复判定。
- 同一人同类触发 5 分钟内只判一次（去抖）。

### 执行与通知

1. 命中 → 查机器人身份 + 目标身份 → 查豁免 → 查限流 → （干跑则只记录）→ 执行。
2. 审计写 `state/moderation.json`（谁、何时、触发类型、证据片段、时长、是否干跑、成功与否），同时进 `state/qq-activity.log`。
3. **私聊通知群主**（每人 10 分钟最多一条）：`【群管理·已执行】… 禁言 甲(123) 3 分钟（重复发同一句话 ×5）证据：「在吗」「在吗」「在吗」`。
4. `admin.announceInGroup` 打开时（**当前为开**），会在群里说一句**按人设的短话**：从 `announceTemplates`（刷屏）/ `announceTemplatesAttack`（攻击）里随机抽一条并填 `{name}`/`{minutes}`，例如「复读机啊，先歇 3 分钟」「行行行，甲 去喝口水，3 分钟后回来」。语气是"人味"，不是管理员通告；模板里**不带脏字**，也不说教。同时会给下一次唤醒留一张小纸条（`st.moderationNote`），让它知道刚发生了什么、可以自然接话，但**不许重复宣布、不许炫耀权限**。
5. **干跑可以定时自动关闭**：`admin.dryRunUntil`（毫秒时间戳）。`dryRun=true` 且设了截止时间 → 到点**自动转为生效**，并在日志 + 私聊里通知一次；想继续观察就把控制台「干跑」重新勾上并清空截止时间。
   - 命令：`node scripts/set-admin-config.mjs --dryrun 24h`（或 `30m` / `off` / `0`）。

### 模型侧：只能"提议"

- 模型没有直接禁言的工具。它只能调 `qq_request_mute(userId, reason)`，桥接**自己重新核验证据**（按人过滤重跑检测），核验不过 → 403 + 审计里记一条"证据不足被拒"。
- 所以"模型想禁言谁"不是权限，只是一个线索；结论永远由桥接的规则给出。

## 4. 群公告：起草 → 群主确认 → 发布

```
机器人/群主起草（qq_propose_announcement，或群主私聊直接给正文）
   ↓ 桥接校验：长度上限、默认禁链接、禁 @全体、禁本机路径/凭据特征
存为待审草稿（state/admin-pending.json，同时私聊群主：草稿全文 + 与当前公告的差异）
   ↓ 群主回复「通过」/「拒绝」（或控制台点按钮）
桥接发布 _send_group_notice(pinned=1, confirm_required=1)
   ↓ 群里出现新公告；私聊回执
```

- 只有 **ownerQQ 的私聊** 或 **控制台** 能批；群友、管理员、模型都不行。
- ⚠️ **owner 私聊必须先于白名单处理**：reserved2 模式下 `allow.private` 默认是空的，如果按普通流程走，
  群主回复的「通过」会在 `modeAllowed()` 那一关被直接丢掉（2026-09-28 实测：日志 `忽略未授权会话 private:100000001`，
  草稿一直卡在待审）。现在 `handleIncoming` 开头就会把「owner 私聊 + 审批词/`/公告*`/`/禁言记录`」交给
  `handleOwnerPrivateCommand()`，回执用 `sendOwnerDM()`（`sendToQQ` 同样会被白名单拦）。
  验证：`node scripts/test-owner-dm.mjs`（走控制台专用的 `/api/socialV2/owner-dm-simulate`，不需要 owner 真的发消息）。
- ⚠️ **QQ 公告正文有服务端长度上限**：实测 603 字被拒（`ec=9 text length error`），511 字（1365 字节）能过，
  原公告 502 字也是能发的。所以校验默认卡在 **600 字 / 1400 字节**（`announcement.maxChars` / `maxBytes`），
  超了在提交草稿阶段就报错，而不是等发布时被 QQ 拒绝。
- **发布失败会保留草稿**（不消费），方便改完直接再批一次；发布成功才清空待审。
- 草稿 30 分钟未批自动作废；同一时间只允许 1 份待审草稿。
- 发布参数：`pinned`（默认置顶）、`confirmRequired`（默认 **0** = 不要求成员点"确认收到"，避免全群被弹确认框；控制台有这个勾选框）。
- 命令行入口：`node scripts/propose-notice.mjs <正文文件>`（提交草稿）、`node scripts/show-notice.mjs`（看现行公告全文）。
- ⚠️ 自检脚本的教训：`test-admin-routes.mjs` 原来会 propose 一份测试草稿再 reject —— 结果把 owner 正在审的真实草稿一起作废了。
  现在它会先检查有没有待审草稿：有就**只做只读检查**，绝不 propose/reject 别人的草稿。
- **QQ 群公告没有"原地编辑"**：`_send_group_notice` 是"发一条新公告"，新公告成为群里显示的那条，旧公告留在历史里。要做到像"替换"，得删旧公告——`_del_group_notice` 属于破坏性动作，**默认不开放**（也在禁止清单里）。
- 群主手动命令：`/公告`（看当前公告 + 草稿状态）、`/公告通过`、`/公告拒绝`。

## 5. 群主手动命令（桥接直接执行，不经过模型）

| 命令 | 作用 |
| --- | --- |
| `/禁言 <QQ> [分钟]` | 手动禁言（1~10 分钟，默认 3），同样要过豁免与身份检查 |
| `/解禁 <QQ>` | 解除禁言 |
| `/禁言记录 [N]` | 看最近 N 条群管理记录（默认 5） |
| `/公告` / `/公告通过` / `/公告拒绝` | 查看公告与草稿状态 / 发布 / 放弃 |

## 6. 配置（`config.json` → `socialV2.admin`）

```json
"admin": {
  "enabled": true,
  "dryRun": true,                     // 干跑起步：只记录 + 通知，不动手
  "groupIds": [],                     // 空 = 用 allow.groups
  "spam":   { "enabled": true, "sameTextCount": 5, "sameImageCount": 5, "windowMs": 120000, "minTextChars": 1 },
  "attack": { "enabled": true, "count": 3, "windowMs": 600000, "mustAddressBot": true, "keywords": ["傻逼", "..."] },
  "mute":   { "minSec": 60, "maxSec": 600, "spamBaseSec": 180, "attackBaseSec": 300, "stepSec": 120,
              "repeatWindowHours": 24, "perMemberCooldownMs": 1800000, "maxPerMemberPerDay": 2 },
  "limits": { "maxPerHour": 3, "maxPerDay": 10 },
  "whitelist": [],
  "announceInGroup": true,
  "announceTemplate": "@{name} 刷屏了，先安静 {minutes} 分钟",
  "announceTemplates": ["@{name} 复读机啊，先歇 {minutes} 分钟", "..."],
  "announceTemplatesAttack": ["{name}，骂够了没，{minutes} 分钟后再来", "..."],
  "dryRunUntil": 0,
  "notifyOwner": true,
  "maxRecords": 500,
  "announcement": { "enabled": true, "maxChars": 2000, "allowLinks": false, "pinned": 1,
                    "confirmTimeoutMs": 1800000, "requireOwnerApproval": true }
}
```

工具开关（`socialV2.tools`）：`requestMute` / `proposeAnnouncement` / `adminInfo`（默认 true）。
`attack.keywords` 会与好感度系统的 `rudeKeywords` 合并使用。

## 7. 控制台「群管理」面板

- 参数区：开关、干跑、阈值、时长阶梯、限流、白名单、公告参数（改完保存后**重启桥接**生效，`cfg` 启动时读入）。
- **刷新群管理状态**：我在群里的身份、能不能管、当前公告全文、待审草稿、最近记录。
- **手动禁言 / 解禁**：填 QQ 与分钟数（给 owner 做测试和应急用）。
- **通过并发布 / 拒绝草稿**：和私聊回复「通过/拒绝」等价。

## 8. 自检

```powershell
node scripts/test-moderation.mjs        # 55 组断言：检测规则/阶梯/豁免/限流/公告校验/禁止动作扫描
node scripts/probe-group-admin.mjs      # 只读：机器人在群里的身份、群主与管理员名单、接口可用性
node scripts/check-preset-admin-rules.mjs  # 预设规则（32.x 群管理段）是否齐、两份 preset 是否同步
node scripts/check-console-ui.mjs       # 控制台控件接线
```

## 9. 上线顺序

1. 单测全绿 + `probe-group-admin` 确认接口可用（已做）。
2. 桥接重启（新代码生效），保持 `dryRun: true`，观察一两天：私聊里会收到"本会禁言谁、多久、证据是什么"。
3. 群主把机器人设为**管理员**。
4. 想立刻验证：控制台「手动禁言」拿一个愿意配合的号试 1 分钟，再解禁。
5. 满意后把 `dryRun` 关掉，正式生效。公告功能不需要等（它本来就要群主逐次确认）。

## 9.1 2026-09-28 的真实记录

- 机器人已被群主设为**管理员**（`probe-group-admin.mjs` → `role=admin`）。
- **真机禁言已验证**：`node scripts/test-mute-live.mjs 200000003 60` →
  `set_group_ban` 返回 `ok:true seconds=60`，随后立刻 `unmute` 也 `ok:true`，审计里两条记录齐全。
  （选这个号是因为 owner 指定；禁言后当场解禁，避免真影响对方。）
- **干跑自动生效已验证**：把 `dryRunUntil` 临时设成过去 → 重启后 `admin-status` 报 `dryRun=false`、
  日志出现「干跑已到期…转为生效」，且私聊通知送达。
- 验证过程中踩到的两个自己写的 bug（都已修）：
  1. `notifyOwner()` 原本走 `sendToQQ`，reserved2 下 `allow.private` 为空 → **私聊通知全被静默拦掉**
     （投喂通知/余额水位也一样受影响）。改成 `sendOwnerDM()`：直接 OneBot `send_private_msg`，
     目标写死 ownerQQ，不接受任何外部输入。
  2. `startAdminTimers()` 一开始放在启动早期，早于 `const bot = ...` → 到期通知报
     `Cannot access 'bot' before initialization`（TDZ）。已挪到 bot 初始化之后。

## 9.2 2026-09-28 群公告改造（bot 第一人称）

- owner 要求把群公告改成 **bot 第一人称** 版本。现行公告（原 502 字）→ 新版 **511 字**，
  2026-09-28 19:00:45 由桥接发布（群里第 5 条公告，置顶、不要求成员确认收到）。
- 内容：生图 / 搜索 / "我是个群友不是客服" / 表情包 / 别刷屏别骂我（写明 1~10 分钟禁言、不踢人不解散不记仇）/ 赞助（改为"问群主，我不掺和、不发链接"）。
- 两处刻意偏离原文：删掉「@哦鲸鲸 投喂+订单号」（机器人自己教人打钱＝风控高发 + 与人设规则冲突），
  以及不再出现"好感度系统"字样（改成"我是个群友，不是客服"，信息量不减、机制不外泄）。
- 草稿与改动对照留在 `docs/群公告-新版草稿.md`（该文件是提交时的 603 字版本，实际发布版被压缩到 511 字）。

## 10. 已知限制

- **管理员免疫**：当前群里的管理员是群友A、群友C——机器人禁言不了他们（这是刻意的）。要管他们只能群主手动，或先撤掉管理员。
- **QQ 风控**：频繁禁言/发公告可能触发风控，所以有每小时/每天上限；公告建议"真有事才发"。
- **误判可能**：大家接龙刷同一句话、或者玩梗连发同一张图，也会命中"重复"。所以窗口只有 2 分钟、每人每天最多 2 次，并且建议先干跑观察。
- **禁言不等于封口**：被禁言的人还能私聊你和群友；机器人不会去追着说教。
