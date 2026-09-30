// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  assert.match(persona.config.suffix, /\{\{cwd\}\}/);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('one closing action can acknowledge the read watermark after the full observation', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  assert.match(prefix, /qq_wait_for_messages\(timeoutMs=300000\)/);
  assert.match(prefix, /短等待不能代替/);
  assert.match(prefix, /preSleepWaitRemainingMs[^。]*继续等待/);
  assert.match(prefix, /若你参与回复[^。]*重新观察/);
});

test('pre-reply quiet checks, waiting for replies and pre-sleep observation have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /不要再重开一次普通长等待/);
  assert.match(prefix, /预算到但 quiet=false 不等于对方说完/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=30000~60000/);
  assert.match(prefix, /【回复后】[^\n]*qq_wait_for_messages\(purpose="messages"\)[^\n]*一轮最多等这一次/);
  assert.match(prefix, /短静默不算沉睡前观察/);
  assert.match(prefix, /5 分钟观察不是回复的前置条件/);
  assert.match(prefix, /只有准备收尾时[^。]*preSleepWaitRemainingMs/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    // 2026-09-29：语音开关打开后，第 16 条从「默认没开、别重试」改成「什么时候该发 + 频率上限」。
    '发语音（管理员已开启）', '音效/梗段', '一天最多 3 条', '绝不连发', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 沉睡前观察唯一的逃生口：明确结束语可以跳过 5 分钟等待。
    '除非对方明确“不聊了/晚安/下了/拜拜”等结束语',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

test('the wake prompt offers the voice library every turn and can count today\'s usage', () => {
  // 为什么单独钉住：语音没有自然的触发时机 —— 只把用法写在预设/工具描述里，模型几乎不会用。
  // 2026-09-29 的做法是照贴纸/表情包，在每轮唤醒提示里注入「有什么可用 + 什么时候用 + 今天几条」，
  // 这条契约防止以后有人顺手把它删掉（删了不会让任何其它测试变红）。
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /const voiceLine = \(\(\) => \{/);
  assert.match(bridge, /【语音】语音库现有：/);
  assert.match(bridge, /\+ voiceLine \+/);
  // 今日配额：发送记录要打标记，计数函数要存在
  assert.match(bridge, /entry\.sentVoice = true;/);
  assert.match(bridge, /function countVoiceSentTodayV2\(st\)/);
});

test('cost rules: 少空转/少重复喂上下文（2026-09-30 省 token 改造 1~4）', () => {
  // 为什么钉住：实测每步要重发 36~52k tokens 的上下文，成本 ≈ 上下文 × 步数 × 回合数。
  // 这条契约保证"省着点用"的规则不会被顺手删掉，同时保证桥接侧的护栏（静默时段/步数上限/
  // 回复检查收紧/黑话错峰）都在。
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  // 1) 削步数：等一轮只等一次 + 单轮步数上限
  assert.match(prefix, /一轮最多等这一次/);
  assert.match(prefix, /一次发送用数组/);
  assert.match(prefix, /发完再 `qq_get_unread_messages`/);
  assert.match(bridge, /turnMaxSteps/);
  assert.match(bridge, /v2TurnSteps/);
  // 上限值要留够余量（本群活跃时段正常回合就能到 20~25 步：2026-09-30 14:28/14:56 就是被 20 切了两次）
  assert.match(bridge, /turnMaxSteps: 30,/);
  // 而且「回合被中止」的内部提示**一律不发群**（owner 2026-09-30 明确要求）
  assert.ok(!/sendToQQ\(key, '⏹️ 已停止'\)/.test(bridge), '中止提示不该再发到群里');
  assert.match(bridge, /回合被中止（\$\{capped \? '单轮步数上限' : '外部停止'\}）：不往群里发提示/);
  // 2) 削上下文：上下文限额收紧（工具返回条数 + 唤醒内联条数）
  assert.match(prefix, /拉消息要小份/);
  // 记忆/缓冲窗口**没动**（见下面的说明）；只收窄了"返回给模型"与"内联进提示"的部分
  assert.match(bridge, /recentLimit: 100/);
  assert.match(bridge, /unreadLimit: 30/);
  assert.match(bridge, /wakeMessageLimit: 8/);
  assert.match(bridge, /wakeRecentLimit: 3/);
  assert.match(bridge, /promptMaxStickers: 4/);
  // 3) 减回合：主动检查静默时段 + 回复检查只在欠人一句话时 + 重试上限 1
  assert.match(bridge, /quietHours/);
  assert.match(bridge, /autoReplyCheckOnlyWhenExpected/);
  assert.match(bridge, /跳过回复检查/);
  assert.match(bridge, /malformedMax: 1/);
  // 4) 黑话学习错峰 + 攒批
  assert.match(bridge, /offPeakOnly/);
  assert.match(bridge, /researchMinPending/);
  assert.match(bridge, /researchBatchMax/);
  // 等待默认时长也缩短了（每次等待都是一步）
  assert.match(bridge, /defaultMs: 10000/);
  // 注意（2026-09-30 决定）：**没有**去压 recentLimit / unreadLimit —— 这两个数是机器人自己的
  // 记忆/缓冲窗口（不是"只影响喂给模型多少"），压小会让人感知到"漏消息/忘掉半小时前"，
  // 而且 test-token-economy.mjs 的 eviction + 水位回归钉的就是这套语义。省 token 只动了
  // "唤醒提示里内联多少"（wakeMessageLimit/wakeRecentLimit/wakeMaxChars）与表情/梗图候选数。
  // 5) 系统状态提示一律不发群（owner：「加上就不太像群友了」）—— 统一走 systemNotice()
  for (const forbidden of [
    "sendToQQ(key, '⏰ 等待回答超时，已取消该请求')",
    "sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。')",
    "sendToQQ(key, '⚠️ 我这边卡了一下，这条没处理成功，稍后再试。')",
    'sendToQQ(key, `⚠️ 消息未被接受：',
    "sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息"
  ]) {
    assert.ok(!bridge.includes(forbidden), `系统提示不该再发群：${forbidden}`);
  }
  assert.match(bridge, /function systemNotice\(key, text/);
  assert.match(bridge, /系统提示（不发群）/);
});

test('game daily jobs (arknights / endfield) are triggered only by the owner exact sentence', () => {
  // 为什么单独钉住：这两个功能会操作真实游戏账号 ——
  //   ① 触发面必须极窄：owner + 对着机器人说 + 与命令**严格相等**（判定在 src/arknights-command.js）
  //   ② 预设里要明确"你做不到、别答应别假装"，并列出两条命令
  //   ③ 两个档案各有独立的计划任务/状态文件；流程实现在 game-daily.mjs，别再复制一份
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /帮我做明日方舟日活/);
  assert.match(bridge, /帮我做终末地日活/);
  assert.match(bridge, /function gameJobs\(\)/);
  assert.match(bridge, /async function handleGameJobRequest\(job, key, event\)/);
  assert.match(bridge, /function startGameJobReporters\(\)/);
  assert.match(bridge, /isArknightsCommand\(plainContent, j\.command\)/);
  assert.match(bridge, /const hitJob = isOwner && \(atSelfHere \|\| quoteTargetIsSelf \|\| kind === 'private'\)/);
  assert.match(bridge, /'\/Run', '\/TN', job\.taskName/);
  for (const f of ['../scripts/game-daily.mjs', '../scripts/endfield-daily.mjs', '../scripts/arknights-daily.mjs']) {
    assert.ok(fs.existsSync(new URL(f, import.meta.url)), `missing ${f}`);
  }
  const engine = fs.readFileSync(new URL('../scripts/game-daily.mjs', import.meta.url), 'utf8');
  assert.match(engine, /export const DEFAULT_ENDFIELD = \{/);
  assert.match(engine, /export const PROFILES = \{/);
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
