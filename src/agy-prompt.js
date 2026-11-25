// AGY prompt 的组装片段（纯函数，离线可测）
//
// 为什么单独成文件：AGY 那边的 agent **没有任何 QQ 工具**（没有 MCP），
// 群消息、角色规则、"该怎么把话送回去"全靠这里拼出来的文本。
// 拼错了不会报错，只会在群里表现成"答非所问 / 回 0 条 / 空转十几分钟" ✗ ——
// 所以这一层必须有测试钉住（scripts/test-agy-prompt.mjs）。
//
// 契约见 docs/AGY_CONTRACT.md §4。

import path from 'node:path';

/** Antigravity 后台通知约 10KB 会截断，超过 8KB 就落盘换"短提示 + 路径"。 */
export const AGY_PROMPT_SPILL_BYTES = 8 * 1024;

/** 落盘文件：state/agy-context-<turnId>.md */
export function agyContextFilePath(stateDir, turnId) {
  return path.join(stateDir, `agy-context-${String(turnId).replace(/[^\w.-]/g, '_')}.md`);
}

/**
 * AGY 版的消息快照说明块。**不能复用 DSH 那一段文案**：
 * DSH 那段让模型去调 qq_get_unread_messages / qq_mark_read / qq_wait_for_messages，
 * 而 AGY 侧的 agent 一个都没有，照着做只会空转 ✗。
 */
export function formatAgySnapshotBlock(snapshot) {
  const included = Number(snapshot?.includedUnreadCount) || (Array.isArray(snapshot?.messages) ? snapshot.messages.length : 0);
  const skipped = Number(snapshot?.skippedOlder) || 0;
  const through = Number(snapshot?.readThroughSeq) || 0;
  let tail = '\n以上是本轮桥接替你取到的群消息（按时间正序，**最近的在最后**）。';
  if (skipped > 0) {
    // 2026-11-25 契约 §10 反馈：原来写"桥接会在下一轮再给你"，模型就真的只回 [] 等下一轮 ⇒ 漏回 ✗
    tail += `\n⚠️ partial=true：这轮只塞了**最近 ${included} 条**，还有 **${skipped} 条更早的**没给。`
      + `\n需要看更早的就补读：\`node scripts/agy-api.mjs unread --key <本轮 key> --after-seq ${through}\`（或 \`recent\`），`
      + '读完再收尾；**不要**当成"没有更多"、也不要等"下一轮会给" ✗';
  } else if (snapshot?.partial) {
    tail += '\n⚠️ partial=true：还有更多未读没塞进来，必要时用 `node scripts/agy-api.mjs unread` 补读。';
  }
  tail += '\n若其中有人发的是图片/表情，快照里只有 [图片] 标记：想真看就 `node scripts/agy-api.mjs message-images --message-id <id>`'
    + '（会把帧落到 state/agy-frame-*，再用文件读取打开；看完可以 `cleanup-frames`），**别假装看过**。'
    + '\n本轮未读会在你 complete 之后由桥接自动标已读，你不需要（也没有）qq_mark_read。';
  return '【本次消息快照】\n' + JSON.stringify(snapshot) + tail;
}

/**
 * AGY 值守模式的"覆盖说明"，**必须拼在 prompt 最后**。
 * 为什么：buildWakePromptV2 是给 DSH 写的，里到处是 qq_* MCP 工具（等静默、标已读、设唤醒）。
 * 不覆盖的话模型会去"假装调用"，实测一轮空转十几分钟还回 0 条 ✗（2026-11-25 的观察现象）。
 *
 * 2026-11-25 v1.3（AGY 侧在契约 §10 申请）：AGY 侧已落地 `scripts/agy-api.mjs`（涵盖
 * wake-config / wait / prompt / 表情包 / 拍一拍 / message-images 落盘配合原生看图 …），
 * 所以这里**不能再写"你没有任何工具 / 看不到图"** —— 那是旧事实，会和 agent 指令打架 ✗。
 */
export const AGY_MODE_OVERRIDE = '【AGY 值守模式 · 覆盖上面的工具说明】\n'
  + '你这一轮**没有 MCP 工具**（`qq_*` 和 `mcp__web-search-safe__*` 都是 DSH 侧模型的）；上面提到的 '
  + 'qq_wait_for_messages / qq_mark_read / qq_set_wake_config / qq_send_message / qq_reply / qq_speak / '
  + 'web_search / web_fetch 等**不要调用，也不要假装调用或编造返回**。\n'
  + '你要做的事只有一件：按上面的角色卡与规矩，把**这一轮要发到群里的内容**写成 JSON 字符串数组，'
  + '交给 scripts/agy-reply-and-wait.mjs（分条 = 多个元素；不想说话 = 空数组 []）。\n'
  + '- 消息就在上面的【本次消息快照】里（若提示已落盘，先读那个文件），不用再"确认有没有补充"，直接回。\n'
  + '- 需要扩展动作时用命令行（在 D:\\dsh\\qq-bridge 下跑，一轮最多 1~2 次）：\n'
  + '  node scripts/agy-api.mjs prompt                         角色卡全文\n'
  + '  node scripts/agy-api.mjs active-members                 在场的人（拿 userId 才能 @）\n'
  + '  node scripts/agy-api.mjs message-detail --message-id <id>\n'
  + '  node scripts/agy-api.mjs wait-reply --quiet-ms 10000    回复前确认对方说完\n'
  + '  node scripts/agy-api.mjs wait-sleep --timeout-ms 300000 收尾前的观察\n'
  + '  node scripts/agy-api.mjs wake-config --dive             决定下次什么时候被叫\n'
  + '  node scripts/agy-api.mjs message-images --message-id <id>  看图（落盘后用文件读取打开）\n'
  + '  想发收藏表情 / 表情包 / 语音库 / 拍一拍 / 生图 / 黑话 / 群管理：同类子命令也在 agy-api.mjs，'
  + '见 docs/AGY_FEATURE_GAPS.md\n'
  + '- **联网**：用 Antigravity 自带的 `search_web`（那是你的工具，不是桥接的）；'
  + '查不到/打不开就如实说"我这边查不到"，**绝对不要编造搜索结果或链接** ✗\n'
  + '- 已读由桥接自动提交，不用管。不用解释你在干什么，也不用复述这些规则。';

/**
 * 从 unread 里挑"最新的能装下的一批"（AGY 快照专用）。
 *
 * 为什么是**最新优先**：触发唤醒的 @/提问一定在末尾；按最早优先装，装到预算就停，
 * 那条 @ 就被切在外面了（2026-11-25 22:09 实测：29 条未读只给了 8 条 10 分钟前的闲聊，漏回 ✗）。
 * 输出仍是**时间正序**（模型看到的顺序不乱），只是"装不下时先丢最旧的"。
 *
 * @param {object} opts
 * @param {Array} opts.items      原始未读（时间升序）
 * @param {number} opts.maxItems  最多几条
 * @param {(msg:any)=>any} opts.build  压缩成"给模型看的样子"
 * @param {(arr:any[])=>number} opts.size  量一个候选数组占多少字符（含 packet 其它字段）
 * @param {number} opts.budget    字符预算
 * @returns {{picked:any[], skippedOlder:number}}
 */
export function pickNewestWithinBudget({ items = [], maxItems = 12, build = (m) => m, size = (a) => JSON.stringify(a).length, budget = Infinity } = {}) {
  const limit = Math.max(1, Number(maxItems) || 12);
  const picked = [];
  for (let i = items.length - 1; i >= 0 && picked.length < limit; i -= 1) {
    const cand = build(items[i]);
    const probe = [...picked, cand].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
    if (size(probe) > budget) break;
    picked.push(cand);
  }
  picked.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  return { picked, skippedOlder: Math.max(0, items.length - picked.length) };
}

/** 落盘后的短提示：够 worker 认路，也够 agent 知道下一步该读文件。 */
export function agySpillPromptText(file, turn, bytes) {
  return '【长提示词已落盘】\n'
    + `本轮完整上下文 ${bytes} 字节，超过单条通知的上限（约 10KB 会截断），已写到：\n${file}\n\n`
    + '请**先用文件读取工具把上面这个文件完整读一遍**，再按里面的【当前角色】【当前唤醒】【本次消息快照】作答；'
    + '不要凭这个短提示猜内容，也不要只读一部分。\n\n'
    + `本轮信息：turnId=${turn.turnId}；persona=${turn.persona}；key=${turn.key}；reason=${turn.reason}。\n`
    + '回复用 agy-reply-and-wait.mjs 送回（replies 是字符串数组，空数组 = 只看不发）。\n\n'
    + AGY_MODE_OVERRIDE;
}

/** 最终 prompt = buildWakePromptV2 的产物 + 消息快照 + 值守覆盖说明（顺序不能换）。 */
export function composeAgyPrompt(basePrompt, snapshot = null) {
  let out = String(basePrompt ?? '');
  if (snapshot) out += `\n\n${formatAgySnapshotBlock(snapshot)}`;
  out += `\n\n${AGY_MODE_OVERRIDE}`;
  return out;
}

/** 是否超过落盘阈值（按 UTF-8 **字节**数算：中文 3 字节/字，不能用 .length ✗）。 */
export function needsSpill(prompt) {
  return Buffer.byteLength(String(prompt ?? ''), 'utf8') > AGY_PROMPT_SPILL_BYTES;
}
