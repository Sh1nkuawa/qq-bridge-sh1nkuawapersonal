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
  return '【本次消息快照】\n' + JSON.stringify(snapshot)
    + '\n以上是本轮桥接替你取到的群消息 —— **你没有查询消息的工具，也不用去查**，就按这份快照回。'
    + '\npartial=true 表示还有更多未读没塞进来：桥接会在下一轮再给你，别这一轮追着问。'
    + '\n若其中有人发的是图片/表情，你这轮**看不到图**（AGY 侧没有读图通道），不要假装看过，必要时用文字问一句。'
    + '\n本轮未读会在你 complete 之后由桥接自动标已读，你不需要也不能调用 qq_mark_read / qq_set_wake_config。';
}

/**
 * AGY 值守模式的"覆盖说明"，**必须拼在 prompt 最后**。
 * 为什么：buildWakePromptV2 是给 DSH 写的，里到处是 qq_* MCP 工具（等静默、标已读、设唤醒）。
 * 不覆盖的话模型会去"假装调用"，实测一轮空转十几分钟还回 0 条 ✗（2026-11-25 的观察现象）。
 */
export const AGY_MODE_OVERRIDE = '【AGY 值守模式 · 覆盖上面的工具说明】\n'
  + '你这一轮**没有任何 QQ 工具**：上面提到的 qq_wait_for_messages / qq_mark_read / qq_set_wake_config / '
  + 'qq_send_message / qq_reply / qq_speak 等 MCP 工具在你这边**不存在**，不要调用，也不要假装调用或编造它们的返回。\n'
  + '你要做的只有一件事：按上面的角色卡与规矩，把**这一轮要发到群里的内容**写成 JSON 字符串数组，'
  + '交给 scripts/agy-reply-and-wait.mjs（分条 = 多个元素；不想说话 = 空数组 []）。\n'
  + '- 消息就在上面的【本次消息快照】里（若提示已落盘，先读那个文件），不用再"确认有没有补充"，直接回。\n'
  + '- 想发收藏表情 / 语音 / 记一笔记忆时，用命令行（发完再 complete，一轮最多一个）：\n'
  + '  node scripts/agy-tools.mjs sticker --key <key> --sticker <emoji_id|md5|url>\n'
  + '  node scripts/agy-tools.mjs voice --key <key> --text "中文正文" --ja "日语台词"\n'
  + '  node scripts/agy-tools.mjs memory-add --key <key> --category activeTopic|pendingThought|memberImpression --content "…"\n'
  + '不用解释你在干什么，也不用复述这些规则。';

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
