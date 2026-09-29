# 投喂（赞助）功能设计

> 代码：`src/feed.js`（账本 + 爱发电核验 + 余额水位）、`src/bridge.js`（接管投喂消息、私聊通知 owner、控制台接口）
> 单测：`node scripts/test-feed.mjs`（47 条断言）
> 账本：`state/feed.json`（不入库）

## 0. 先说清楚一个做不到的事

**"群友付款自动变成 DeepSeek API 余额"做不到。** DeepSeek 开放平台只有两条充值路径
（[官方 FAQ](https://raw.githubusercontent.com/thevibeworks/deepseek-docs/main/content/zh-cn/faq/category-4.md)）：

- 在线充值：实名认证后在 `platform.deepseek.com/top_up` 用支付宝/微信付；
- 对公汇款：仅企业用户，且**要求汇款方开户名与实名认证名称一致**。

没有充值 API、没有兑换码、没有余额转移。所以本功能做的是**前半段**：

```
群友付款 → 爱发电 → 群友把订单号发到群里 → 桥接核验/记账/发权益 → 私聊通知 owner
                                                              ↓
                                        owner 手动去 DeepSeek 控制台充值（唯一的人工环节）
```

## 1. 为什么用爱发电（而不是群主收款码）

| | 爱发电 | 群主收款码 |
|---|---|---|
| 核验 | 开放 API 查订单号：**存在性 + 金额 + 状态**，权威且一次性 | 只能看截图，能 P、能重复发 |
| 防冒领 | 订单号全局去重（用过的不能再记） | 无法防 |
| 风险 | 平台有抽成/条款（需自行确认）；个人码用于经营性收款会被风控 |

核验接口（来自成熟开源实现 [ifadian-qq-bot](https://github.com/faq196550-hue/ifadian-qq-bot)）：

```
POST https://ifdian.net/api/open/query-order
body = { user_id, params: '{"out_trade_no":"<订单号>"}', ts, sign }
sign = md5(`${token}params${params}ts${ts}user_id${user_id}`)
返回 { ec: 200, data: { list: [...] } }   // list 非空 = 订单存在
```

凭据获取：爱发电 → 创作者后台 → **开发者页 `https://afdian.com/dashboard/dev`** 拿 `user_id` + `token`。

> ⚠️ **域名提示（2026-09-27 实测）**：文档和很多老教程里写的 `afdian.net` **已经废弃**
> （DNS 都解析不出来，浏览器直接打不开）。现在是 `afdian.com`（同一台服务器还有 `ifdian.net`）。
> 本模块的 `feed.afdian.apiBases` 默认按 `['https://afdian.com', 'https://ifdian.net']` 顺序尝试，
> 前面的挂了自动切后面的。
>
> 实测：用假凭据 POST 两个域名都会返回 `ec=400004 (no valid token found)` ——
> 说明**接口与调用格式（user_id/params/ts/sign）都是对的**，只差真凭据。

## 2. 使用流程（群友视角）

1. 打开群主的爱发电赞助页，付一笔（金额随意）；
2. 在群里：`@小鲸鱼 投喂 <订单号>`（订单号是一串 10 位以上数字，复制过来就行）；
3. 桥接**异步**核验：查到 → 记账 → 回一句「收到！谢谢老板投喂 🐳」（**不提金额**）；
   查不到 → 「这个订单号我这边查不到，确认一下有没有复制少？」；
   重复单号 → 「这个单号我记过啦，不用重复发～」；
4. 同一时刻，**私聊群主**一条明细（谁、多少、累计）。

## 3. 权益（当前规则）

| 项 | 规则 |
|---|---|
| 好感度 | **每人每天第一笔 +5**，当天后续投喂不再加 |
| 是否占每日封顶 | **不占**。投喂那 +5 绕过好感度的 ±6 日封顶 |
| 金额是否影响权益 | 不影响（¥1 和 ¥100 给的一样）——刻意如此，避免"充得多就亲"和攀比 |
| 公示 | 群里只有道谢，**金额永不出现在群里**；金额只在「私聊 owner」和控制台可见 |

> 为什么绕过日封顶：否则"投喂 +5"会被当天聊天/发图的日常分挤掉
> （例如先聊了 +2，投喂就只剩 +4），owner 定的规则就不成立了。

## 4. 余额水位提醒（只在私聊）

- 复用与 `qq_get_balance` 相同的官方接口 `https://api.deepseek.com/user/balance`；
- 每 `checkMs`（默认 6 小时）检查一次，启动 90 秒后先查一次；
- 余额 < `threshold`（默认 ¥20）且距上次提醒超过 `alertGapMs`（默认 12 小时）→ **私聊 owner**：
  「DeepSeek 余额 ¥X，低于阈值 ¥20。有空去 platform.deepseek.com/top_up 充一下」；
- **群里绝不提钱**（人设规则 31 明确要求模型不谈钱）。

## 5. 配置（`config.json` → `socialV2.feed`）

```json
{
  "socialV2": {
    "feed": {
      "enabled": true,
      "afdian": { "userId": "你的 user_id", "token": "你的 api token", "apiBases": ["https://afdian.com", "https://ifdian.net"] },
      "dailyAffinity": 5,
      "maxAttemptsPerHour": 5,
      "notifyOwnerOnFeed": true,
      "hungry": { "enabled": true, "threshold": 20, "checkMs": 21600000, "alertGapMs": 43200000 }
    }
  }
}
```

- `enabled: false`（默认）时：**不接管**投喂消息，一切照旧走模型；
- `dailyAffinity: 0` → 投喂不给好感度（纯记账）；
- `maxAttemptsPerHour`：每人每小时最多提交几次订单号（防拿假单号刷爱发电 API）。

写入用脚本（避免手改 JSON 出错、也避免 PowerShell 的 UTF-8 坑）：

```bash
node scripts/set-afdian-key.mjs <user_id> <token>   # 配凭据并启用
node scripts/set-afdian-key.mjs --disable           # 关掉
node scripts/set-afdian-key.mjs --show              # 看当前配置（token 打码）
```

## 6. 运维

```bash
node scripts/feed-admin.mjs list                    # 汇总 + 最近订单（订单号脱敏）
node scripts/feed-admin.mjs csv > feed.csv          # 完整 CSV（对账用）
node scripts/feed-admin.mjs add <QQ> "<昵称>" <金额> [订单号]   # 手工补录（微信直转等）
node scripts/feed-admin.mjs remove <订单号>          # 撤销（退款/误记）
```

HTTP：`GET /api/socialV2/feed`（支持 `?csv=1`）、`POST /api/socialV2/feed`

## 7. 安全设计

| 措施 | 说明 |
|---|---|
| 去重 | 订单号全局唯一，用过即废；`recordOrder` 返回 `duplicate-order` |
| 限流 | 每人每小时 `maxAttemptsPerHour` 次（含失败），防刷 API |
| 脱敏 | 日志/控制台列表只显示 `2026…3171`；完整号只在 CSV 与账本文件里 |
| 凭据 | 只存在 `config.json`（gitignored）；任何报错都不回显 token/sign |
| 不让模型碰钱 | 接管后**不唤醒模型**，回执是桥接的确定性模板，杜绝幻觉与泄露 |
| 单号不外泄 | 回执、日志、群消息里都不出现完整订单号 |

## 8. 风险与合规（务必知晓）

1. **QQ 群规**：群内公开收款/诱导付费可能违规（最坏封群）→ 建议**不挂公告**，只在有人主动问/主动投喂时用固定话术。
2. **假单号/撞号**：靠爱发电 API 核验，比截图可靠；但"用别人的订单号"无法完全防（订单号只有赞助者本人能看到，泄露是他的问题）。
3. **退款**：目前只记不退款。若发生退款，用 `feed-admin.mjs remove <订单号>` 撤销（好感度不会自动回退，必要时用 `affinity-admin.mjs set` 手调）。
4. **定性**：措辞用"投喂/赞助，不承诺对价"。如果写成"付费买生图次数"就变成卖服务，可能涉及税务/资质。
5. **群里是在校学生**：建议单次金额不设诱导性档位（如"充 100 送称号"），避免有人上头。
6. **未成年人**：如群里有未成年人，建议把 `dailyAffinity` 设为 0 或直接关闭投喂。
