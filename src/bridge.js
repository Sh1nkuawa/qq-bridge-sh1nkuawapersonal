// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import {
  mergeAffinityConfig,
  tierOf,
  ensureMember,
  recordEvent,
  applyDecay,
  formatAffinityPanel,
  sanitizeAffinityState,
  summarizeAffinity,
  resetAllMembers
} from './affinity.js';
import {
  DEFAULT_FEED,
  mergeFeedConfig,
  loadLedger,
  saveLedger,
  extractOrderNo,
  maskOrderNo,
  shouldHandleFeed,
  buildFeedHint,
  attemptsAllowed,
  noteAttempt,
  recordOrder,
  removeOrder,
  summarize as summarizeFeed,
  ledgerCsv,
  todayKey as feedTodayKey,
  verifyAfdianOrder,
  fetchDeepseekBalance,
  shouldAlertHungry
} from './feed.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
import {
  mergeMemeConfig,
  defaultPackDirs,
  scanMemePacks,
  buildMemeCatalog,
  sampleMemes,
  findMeme,
  loadMemeStats,
  saveMemeStats,
  markMemeUsed,
  recentMemeIds,
  buildMemeContext,
  buildMemeStrategyHint,
  formatMemeCandidate,
  MEME_MOOD_DICT,
  MEME_MOODS
} from './meme-lib.js';
import {
  ADMIN_ACTIONS,
  DEFAULT_ADMIN_CFG,
  mergeAdminConfig,
  assertAllowedAction,
  detectRepeat,
  detectAttack,
  countRecentMutes,
  planMuteSeconds,
  canMuteTarget,
  checkMuteLimits,
  validateAnnouncement,
  summarizeNoticeDiff,
  emptyModerationLog,
  loadModerationLog,
  saveModerationLog,
  makeRecord,
  formatRecordLine,
  loadPendingAnnouncement,
  savePendingAnnouncement,
  pendingExpired,
  parseApproval,
  buildMuteNotice,
  pickAnnounceLine,
  isDryRun,
  dryRunRemainingMs,
  FORBIDDEN_ACTIONS
} from './moderation.js';
import { DEFAULT_IMAGE_ACK_TEMPLATES, pickImageAckLine } from './persona-lines.js';
import { analyzeImageRequest, shouldSendEarlyAck, pickImageMention } from './image-ack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const MEME_STATS_FILE = path.join(STATE_DIR, 'memes.json');
const MODERATION_FILE = path.join(STATE_DIR, 'moderation.json');
const PENDING_NOTICE_FILE = path.join(STATE_DIR, 'admin-pending.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
function appendActivity(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(ACTIVITY_LOG, `[${ts}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
    // 只保留最近 500 行
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 500) fs.writeFileSync(ACTIVITY_LOG, lines.slice(-500).join('\n'));
  } catch {}
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        // [qq-bridge 本地补丁] 余额查询工具（mcp__snowluma__qq_get_balance）的开关
        getBalance: true,
        // [qq-bridge 本地补丁] 生图工具（mcp__snowluma__qq_generate_image）的开关
        getImage: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    // [qq-bridge 本地补丁] 余额查询工具开关（旧 config.json 缺这个键时补默认值）
    getBalance: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    // [qq-bridge 本地补丁] 生图工具（mcp__snowluma__qq_generate_image）的开关
    getImage: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // [qq-bridge 本地补丁] 生图限制：必须被 @ + 正文以 prefix 开头 + 每账号每日 dailyLimit 次（owner 不限）。
  cfg.socialV2.image = {
    enabled: true,
    dailyLimit: 5,
    prefix: '生图',
    mentionFreshMs: 180000,   // 「@机器人」记录的时效窗口：3 分钟
    timeoutSec: 600,          // codex-image.ps1 的超时
    outDir: '',               // 留空则用 %TEMP%\qq-bridge-images
    ...(cfg.socialV2.image ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // 新版 DSH 的 launch token 每次启动会变；配置里没填时自动从 DSH guard 日志发现。
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
function loadState() {
  const loaded = readJsonSafe(STATE_FILE, null);
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') stale = true;
          else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）
function log(...args) {
  const line = `${new Date().toISOString().slice(11, 19)} [bridge] ${args.map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.replace(/[\r\n]+/g, ' ');
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(BRIDGE_LOG, line + '\n');
    const raw = fs.readFileSync(BRIDGE_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 2000) fs.writeFileSync(BRIDGE_LOG, lines.slice(-2000).join('\n'));
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: d.subType != null ? String(d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  acquireLock();
  loadState();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = loadSlang(SLANG_FILE);
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  let stickerEntries = loadStickerStore(STICKER_FILE);
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.httpToken || cfg.snowluma?.accessToken
              ? { authorization: `Bearer ${cfg.snowluma.httpToken || cfg.snowluma.accessToken}` }
              : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  // ── 本地表情包库（接入用户的 dsh-meme 图库） ────────────────────────────
  // QQ 收藏表情是“账号里的表情”，这套是“本地图库文件”：按情绪抽候选，直接用
  // 图片消息发出去。两者互补：挑不到合适的梗图时回落到收藏表情。
  let memeStats = loadMemeStats(MEME_STATS_FILE);
  let memeCatalogCache = { catalog: [], packs: [], builtAt: 0, dirs: [] };

  function memeCfg() {
    return mergeMemeConfig(cfg.socialV2?.memes);
  }

  function memeEnabled() {
    return memeCfg().enabled !== false;
  }

  function saveMemeStatsSafe() {
    try { saveMemeStats(MEME_STATS_FILE, memeStats); } catch (error) { log('[meme] 保存使用统计失败:', error?.message ?? error); }
  }

  // 载入/刷新图库目录（只读扫描 dsh-meme 的 index.db 与图片文件）。
  // 失败时不抛错：宁可这次没图可发，也不能影响聊天主流程。
  function ensureMemeCatalog(force = false) {
    const mc = memeCfg();
    if (mc.enabled === false) return memeCatalogCache;
    const ttlRaw = Number(cfg.socialV2?.memes?.rescanTtlMs);
    const ttl = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? ttlRaw : 300000;
    const now = Date.now();
    if (!force && memeCatalogCache.builtAt && now - memeCatalogCache.builtAt < ttl) return memeCatalogCache;
    const dirs = mc.packDirs.length ? mc.packDirs : defaultPackDirs();
    try {
      const packs = scanMemePacks(dirs, { allowIds: mc.packs });
      const catalog = buildMemeCatalog(packs, mc);
      memeCatalogCache = { catalog, packs, builtAt: now, dirs };
      log(`[meme] 本地图库已载入 ${catalog.length} 张（${packs.map((p) => `${p.id}:${p.rows.length}`).join(' ') || '无'}）`);
    } catch (error) {
      log(`[meme] 载入本地图库失败: ${error?.message ?? error}`);
      memeCatalogCache = { catalog: [], packs: [], builtAt: now, dirs };
    }
    return memeCatalogCache;
  }

  // 给 AI 的候选列表：情绪抽样 + 使用统计，只返回相对 id（不回绝对路径）。
  function memeListForV2(tag, query, limit) {
    const mc = memeCfg();
    const { catalog, packs } = ensureMemeCatalog(false);
    if (!catalog.length) {
      return { ok: false, error: '本地表情包库为空（检查 config.json 的 socialV2.memes.packDirs 或 dsh-meme 是否安装）', dirs: memeCatalogCache.dirs };
    }
    const sampled = sampleMemes(catalog, { tag, query, limit, stats: memeStats, recentAvoid: mc.recentAvoid });
    if (!sampled.mood) {
      return { ok: false, error: `先选一个情绪 tag：${MEME_MOOD_DICT}`, moods: Object.keys(MEME_MOODS) };
    }
    if (!sampled.memes.length) {
      return { ok: false, error: `情绪「${sampled.mood}」下没有图，换一个：${MEME_MOOD_DICT}`, moods: Object.keys(MEME_MOODS) };
    }
    return {
      ok: true,
      mood: sampled.mood,
      total: sampled.total,
      librarySize: catalog.length,
      packs: packs.map((p) => ({ id: p.id, name: p.name, count: p.rows.length })),
      candidates: sampled.memes.map((m) => ({
        path: m.id,
        tag: m.tag,
        mood: m.mood,
        caption: m.caption,
        pack: m.packId,
        used: Number(memeStats?.entries?.[m.id]?.useCount) || 0,
        line: formatMemeCandidate(m)
      }))
    };
  }

  // 取一张本地表情的图片字节（多模态查看用）。
  function memeImageData(ref) {
    const { catalog } = ensureMemeCatalog(false);
    const meme = findMeme(catalog, ref);
    if (!meme) throw new Error(`找不到表情包 ${ref}，请先用 qq_send_meme(action=search) 获取候选 path`);
    const buf = fs.readFileSync(meme.abs);
    const mc = memeCfg();
    if (mc.maxFileBytes && buf.length > mc.maxFileBytes) throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB）`);
    const ext = path.extname(meme.abs).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : ext === '.bmp' ? 'image/bmp'
      : 'image/jpeg';
    return { meme, mimeType, base64: buf.toString('base64'), size: buf.length };
  }

  // 发送一张本地表情包（图片消息）。回复/@/限频/记录与收藏表情保持一致。
  async function sendMemeV2(key, ref, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const { catalog } = ensureMemeCatalog(false);
    const meme = findMeme(catalog, ref);
    if (!meme) throw new Error(`找不到表情包 ${ref}，请先用 qq_send_meme(action=search) 获取候选 path`);
    const mc = memeCfg();
    let buf;
    try {
      buf = fs.readFileSync(meme.abs);
    } catch (error) {
      throw new Error(`读取表情包文件失败：${error?.message ?? error}`);
    }
    if (!buf.length) throw new Error('表情包文件为空，已拒绝发送');
    if (mc.maxFileBytes && buf.length > mc.maxFileBytes) throw new Error(`图片过大（${(buf.length / 1048576).toFixed(1)}MB）`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.httpToken || cfg.snowluma?.accessToken
              ? { authorization: `Bearer ${cfg.snowluma.httpToken || cfg.snowluma.accessToken}` }
              : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    memeStats = markMemeUsed(memeStats, meme.id, options.context ? String(options.context).slice(0, 60) : `${kind}:${id}`);
    saveMemeStatsSafe();
    return { meme, messageId: data?.message_id ?? null };
  }

  // ── 群管理（禁言 / 群公告）────────────────────────────────────────────
  // 硬边界：只允许 moderation.js 里 ADMIN_ACTIONS 定义的动作（禁言 + 发/读公告 + 查成员身份）。
  // 不许踢人、不许全员禁言、不许设管理员、不许退群、不许碰群文件/群相册（见 FORBIDDEN_ACTIONS）。
  let moderationLog = loadModerationLog(MODERATION_FILE);
  let pendingNotice = loadPendingAnnouncement(PENDING_NOTICE_FILE);
  let botSelfId = '';
  const memberRoleCache = new Map(); // `${groupId}:${userId}` -> { role, at }
  let lastAdminWarnAt = 0;

  function adminCfg() {
    return mergeAdminConfig(cfg.socialV2?.admin);
  }

  /** 当前是否处于干跑（支持 dryRunUntil 到点自动转为生效）。 */
  function adminDryRun() {
    return isDryRun(adminCfg());
  }

  /** 干跑到期检查：到点只记一次日志 + 通知 owner，之后按生效走。 */
  let dryRunExpiryAnnounced = false;
  function checkDryRunExpiry() {
    const c = adminCfg();
    if (!c.dryRun || c.dryRunUntil <= 0) return;
    if (Date.now() < c.dryRunUntil) return;
    if (dryRunExpiryAnnounced) return;
    dryRunExpiryAnnounced = true;
    log(`[admin] 干跑已到期（${new Date(c.dryRunUntil).toLocaleString('zh-CN')}），群管理转为**生效**（dryRunUntil 已过）`);
    appendActivity('[admin] 干跑到期，禁言功能转为生效');
    void notifyOwner('群管理已生效', `干跑截止时间到了（${new Date(c.dryRunUntil).toLocaleString('zh-CN')}）。从现在起，刷屏/持续骂我会**真的禁言** 1~10 分钟，执行后私聊告诉你。想继续观察就把控制台的「干跑」重新勾上并清空截止时间。`).catch(() => {});
  }

  function adminEnabled() {
    return adminCfg().enabled !== false;
  }

  function adminGroups() {
    const c = adminCfg();
    const groups = c.groupIds.length ? c.groupIds : (cfg.allow?.groups ?? []).map(String);
    return groups.map(String);
  }

  function adminAppliesToGroup(groupId) {
    return adminEnabled() && adminGroups().includes(String(groupId));
  }

  function saveModerationLogSafe() {
    try { moderationLog = saveModerationLog(MODERATION_FILE, moderationLog, adminCfg().maxRecords); } catch (error) { log('[admin] 保存群管理审计失败:', error?.message ?? error); }
  }

  function savePendingNoticeSafe() {
    try { savePendingAnnouncement(PENDING_NOTICE_FILE, pendingNotice); } catch (error) { log('[admin] 保存公告草稿失败:', error?.message ?? error); }
  }

  function pushModerationRecord(fields) {
    const rec = makeRecord(fields);
    moderationLog.records.push(rec);
    saveModerationLogSafe();
    return rec;
  }

  /** 成员身份 + 名字（含机器人自己）：10 分钟缓存；查不到返回空串（调用方保守处理）。 */
  async function getMemberInfo(groupId, userId, force = false) {
    const key = `${groupId}:${userId}`;
    const hit = memberRoleCache.get(key);
    if (!force && hit && Date.now() - hit.at < 600000) return hit;
    try {
      const res = await bot.request(ADMIN_ACTIONS.memberInfo, { group_id: Number(groupId), user_id: Number(userId), no_cache: true });
      if (res?.status === 'ok') {
        const role = String(res.data?.role ?? '');
        const name = String(res.data?.card || res.data?.nickname || '');
        if (role || name) {
          const info = { role, name, at: Date.now() };
          memberRoleCache.set(key, info);
          return info;
        }
      }
      return hit ?? { role: '', name: '', at: 0 };
    } catch (error) {
      log(`[admin] 查询成员身份失败 ${key}: ${error?.message ?? error}`);
      return hit ?? { role: '', name: '', at: 0 };
    }
  }

  async function getMemberRole(groupId, userId, force = false) {
    return (await getMemberInfo(groupId, userId, force)).role;
  }

  function getBotRole(groupId, force = true) {
    if (!botSelfId) return Promise.resolve('');
    return getMemberRole(groupId, botSelfId, force);
  }

  /** owner 提醒：机器人不是管理员时只提醒一次/小时（避免刷屏）。 */
  async function warnNotAdmin(groupId, action) {
    const now = Date.now();
    if (now - lastAdminWarnAt < 3600000) return;
    lastAdminWarnAt = now;
    log(`[admin] 机器人不是群 ${groupId} 的管理员，跳过 ${action}`);
    await notifyOwner('群管理不可用', `我在群 ${groupId} 里不是管理员，${action} 没法执行。\n在群里把我设成管理员即可（设置 → 群成员 → 我 → 设为管理员）。`);
  }

  /** 唯一的禁言出口：动作走白名单，时长强制 clamp 到 1~10 分钟。 */
  async function callMute(groupId, userId, seconds) {
    const action = assertAllowedAction(ADMIN_ACTIONS.mute);
    const c = adminCfg();
    const sec = Math.max(c.mute.minSec, Math.min(c.mute.maxSec, Math.round(Number(seconds) || c.mute.minSec)));
    const res = await bot.request(action, { group_id: Number(groupId), user_id: Number(userId), duration: sec });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`禁言失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    return sec;
  }

  /** 解禁（duration=0）：只给 owner 手动命令用。 */
  async function callUnmute(groupId, userId) {
    const action = assertAllowedAction(ADMIN_ACTIONS.mute);
    const res = await bot.request(action, { group_id: Number(groupId), user_id: Number(userId), duration: 0 });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`解禁失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    return true;
  }

  /** _get_group_notice 的文本带 HTML 实体，解码后再用。 */
  function decodeNoticeText(raw) {
    return String(raw ?? '')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /** 读当前群公告（最新一条）。返回 { ok, text, noticeId, publishTime, count }。 */
  async function fetchCurrentNotice(groupId) {
    try {
      const res = await bot.request(ADMIN_ACTIONS.noticeList, { group_id: Number(groupId) });
      if (!res || res.status !== 'ok' || res.retcode !== 0) {
        throw new Error(res?.wording || res?.retcode || 'unknown');
      }
      const list = Array.isArray(res.data) ? res.data : [];
      if (!list.length) return { ok: true, text: '', noticeId: '', publishTime: 0, count: 0 };
      const newest = [...list].sort((a, b) => Number(b?.publish_time ?? 0) - Number(a?.publish_time ?? 0))[0];
      const text = decodeNoticeText(newest?.message?.text ?? newest?.message ?? '');
      return { ok: true, text, noticeId: String(newest?.notice_id ?? ''), publishTime: Number(newest?.publish_time ?? 0) || 0, count: list.length };
    } catch (error) {
      log(`[admin] 读取群公告失败: ${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error), text: '', count: 0 };
    }
  }

  /** 发布群公告（唯一出口；正文必须已通过 validateAnnouncement）。 */
  async function publishNotice(groupId, content) {
    const action = assertAllowedAction(ADMIN_ACTIONS.noticePublish);
    const c = adminCfg();
    const check = validateAnnouncement(content, c.announcement);
    if (!check.ok) throw new Error(`公告校验未通过：${check.errors.join('；')}`);
    const res = await bot.request(action, {
      group_id: Number(groupId),
      content: check.text,
      pinned: c.announcement.pinned,
      type: 1,
      is_show_edit_card: 1,
      tip_window_type: 1,
      confirm_required: c.announcement.confirmRequired
    });
    if (!res || res.status !== 'ok' || res.retcode !== 0) {
      throw new Error(`发布公告失败: ${res?.wording || res?.retcode || 'unknown'}`);
    }
    return check.text;
  }

  // ── 群管理：确定性判定 + 执行（禁言）──────────────────────────────────
  function userNameOf(userId, messages) {
    const hit = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => String(m?.userId ?? '') === String(userId));
    return String(hit?.sender ?? hit?.nickname ?? '');
  }

  /** 只通知 owner 一次/10 分钟/人，避免干跑阶段刷屏。 */
  async function notifyOwnerModeration(rec, extra = '') {
    const c = adminCfg();
    if (!c.notifyOwner) return;
    const key = `notify:${rec.groupId}:${rec.userId}`;
    const now = Date.now();
    if (now - Number(moderationLog.ownerNotified[key] ?? 0) < 600000) return;
    moderationLog.ownerNotified[key] = now;
    saveModerationLogSafe();
    const lines = [formatRecordLine(rec)];
    if (extra) lines.push(extra);
    if (rec.evidence?.length) {
      lines.push('证据：' + rec.evidence.map((e) => `「${String(e.text ?? '').slice(0, 40)}」`).join(' '));
    }
    if (rec.dryRun) lines.push('（当前是干跑模式：只记录，没有真的禁言）');
    await notifyOwner(rec.dryRun ? '群管理·干跑' : '群管理·已执行', lines.join('\n'));
  }

  /**
   * 入站群消息的群管理判定（确定性）：刷屏 / 攻击机器人 → 禁言（或干跑记录）。
   * 由 handleIncoming 在写入会话消息之后调用；只对群生效、只对白名单群生效。
   */
  async function runModerationCheck(key, kind, id, extra = {}) {
    if (kind !== 'group') return;
    if (!adminAppliesToGroup(id)) return;
    checkDryRunExpiry();
    const c = adminCfg();
    if (!c.spam.enabled && !c.attack.enabled) return;
    const st = getSocialV2State(key);
    const messages = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    if (!messages.length) return;
    const now = Date.now();

    let trigger = null;
    if (c.spam.enabled) {
      const rep = detectRepeat(messages, { cfg: c.spam, now });
      if (rep.hit) trigger = rep;
    }
    if (!trigger && c.attack.enabled) {
      const atk = detectAttack(messages, { cfg: c.attack, now, rudeKeywords: cfg.socialV2?.affinity?.rudeKeywords });
      if (atk.hit) trigger = atk;
    }
    if (!trigger || !trigger.senderId) return;

    const userId = String(trigger.senderId);
    const userName = userNameOf(userId, messages);
    const triggerKind = trigger.kind === 'attack' ? 'attack' : (trigger.kind === 'image' ? 'image-repeat' : 'text-repeat');
    const dedupeKey = `dedupe:${id}:${userId}:${triggerKind}`;
    if (now - Number(moderationLog.ownerNotified[dedupeKey] ?? 0) < 300000) return; // 同一人同类 5 分钟内只判一次
    moderationLog.ownerNotified[dedupeKey] = now;
    saveModerationLogSafe();

    const priorMutes24h = countRecentMutes(moderationLog.records, { groupId: id, userId, now, windowHours: c.mute.repeatWindowHours });
    const plan = planMuteSeconds({ triggerKind, priorMutes24h, cfg: c });
    const base = {
      groupId: id,
      userId,
      userName,
      action: 'mute',
      trigger: triggerKind,
      seconds: plan.seconds,
      by: 'auto',
      count: trigger.count,
      keywords: trigger.keywords ?? [],
      evidence: trigger.evidence ?? [],
      reason: plan.reason
    };

    const botRole = await getBotRole(id);
    const targetRole = await getMemberRole(id, userId);
    const guard = canMuteTarget({
      targetId: userId,
      targetRole,
      botRole,
      botId: botSelfId,
      ownerQQ: cfg.ownerQQ,
      groupOwnerId: String(cfg.ownerQQ ?? ''),
      whitelist: c.whitelist
    });
    if (!guard.ok) {
      const rec = pushModerationRecord({ ...base, action: 'skip', ok: false, reason: guard.reason });
      log(`[admin] 跳过禁言 ${id}/${userId}：${guard.reason}`);
      if (rec.trigger === 'attack') await notifyOwnerModeration({ ...rec, dryRun: adminDryRun() });
      return;
    }

    const limits = checkMuteLimits({ records: moderationLog.records, mutedUntil: moderationLog.mutedUntil, groupId: id, userId, now, cfg: c });
    if (!limits.ok) {
      pushModerationRecord({ ...base, action: 'skip', ok: false, reason: limits.reason });
      log(`[admin] 触发但受限流跳过 ${id}/${userId}：${limits.reason}`);
      return;
    }

    if (adminDryRun()) {
      const rec = pushModerationRecord({ ...base, dryRun: true, ok: true });
      const left = dryRunRemainingMs(c);
      const leftText = left > 0 ? `（干跑还剩 ${Math.round(left / 3600000)} 小时自动生效）` : '（干跑中，未设截止时间）';
      log(`[admin] 干跑：本会禁言 ${id}/${userId} ${Math.round(plan.seconds / 60)} 分钟（${triggerKind} ×${trigger.count}）${leftText}`);
      appendActivity(`${key} [admin] 干跑判定：${userName}(${userId}) ${triggerKind} ×${trigger.count} → ${Math.round(plan.seconds / 60)} 分钟`);
      await notifyOwnerModeration(rec, leftText);
      return;
    }

    if (botRole !== 'admin' && botRole !== 'owner') {
      pushModerationRecord({ ...base, action: 'skip', ok: false, reason: '机器人不是管理员' });
      await warnNotAdmin(id, '禁言');
      return;
    }

    try {
      const sec = await callMute(id, userId, plan.seconds);
      moderationLog.mutedUntil[`${id}:${userId}`] = now + sec * 1000;
      const rec = pushModerationRecord({ ...base, seconds: sec, ok: true });
      log(`[admin] 已禁言 ${id}/${userId} ${Math.round(sec / 60)} 分钟（${triggerKind} ×${trigger.count}）`);
      appendActivity(`${key} [admin] 已禁言：${userName}(${userId}) ${Math.round(sec / 60)} 分钟（${triggerKind} ×${trigger.count}）`);
      // 立刻清掉缓存里的角色（下次判定重新查，避免权限变化后误判）
      memberRoleCache.delete(`${id}:${botSelfId}`);
      await notifyOwnerModeration(rec);
      // 按人设说一句（模板池随机抽，不骂人、不说教、不超过一句）
      if (c.announceInGroup) {
        const name = userName || `QQ ${userId}`;
        const line = pickAnnounceLine(c, { name, minutes: Math.round(sec / 60), kind: triggerKind });
        await sendToQQ(key, line).catch((error) => log(`[admin] 群内播报失败：${error?.message ?? error}`));
      }
      // 给下一次唤醒留一张小纸条：让它知道刚发生了什么，可以自然接话（但不许重复宣布/炫耀权限）
      const st = getSocialV2State(key);
      st.moderationNote = {
        at: now,
        userId,
        userName: userName || `QQ ${userId}`,
        kind: triggerKind,
        minutes: Math.round(sec / 60),
        count: trigger.count
      };
      saveSocialV2State();
    } catch (error) {
      pushModerationRecord({ ...base, ok: false, error: String(error?.message ?? error) });
      log(`[admin] 禁言失败 ${id}/${userId}：${error?.message ?? error}`);
      await notifyOwner('群管理失败', `禁言 ${userName}(${userId}) 失败：${error?.message ?? error}`);
    }
  }

  // ── 群管理：群公告（起草 → owner 确认 → 发布）──────────────────────────
  function currentPendingNotice() {
    if (!pendingNotice.pending) return null;
    if (pendingExpired(pendingNotice.pending, adminCfg())) {
      log('[admin] 待审公告已超时作废');
      pendingNotice = { version: 1, pending: null };
      savePendingNoticeSafe();
      return null;
    }
    return pendingNotice.pending;
  }

  async function proposeNotice(content, source = 'model', groupId = null) {
    const c = adminCfg();
    if (!c.announcement.enabled) return { ok: false, error: '公告功能已关闭' };
    const gid = String(groupId ?? adminGroups()[0] ?? '');
    if (!gid) return { ok: false, error: '没有可发布的群' };
    const check = validateAnnouncement(content, c.announcement);
    if (!check.ok) return { ok: false, error: `公告校验未通过：${check.errors.join('；')}` };
    const existing = currentPendingNotice();
    if (existing && existing.content !== check.text) {
      return { ok: false, error: `已有一份待审公告（${new Date(existing.createdAt).toLocaleString('zh-CN')} 提交），请先让管理员处理：回复「通过」或「拒绝」` };
    }
    const cur = await fetchCurrentNotice(gid);
    const pending = {
      id: crypto.randomBytes(4).toString('hex'),
      content: check.text,
      createdAt: Date.now(),
      source,
      groupId: gid,
      status: 'pending'
    };
    pendingNotice = { version: 1, pending };
    savePendingNoticeSafe();
    log(`[admin] 新公告草稿待审（${source}，${check.text.length} 字，群 ${gid}）`);
    appendActivity(`[admin] 公告草稿待审：${check.text.slice(0, 60).replace(/\n/g, ' ')}`);
    if (c.notifyOwner && c.announcement.requireOwnerApproval) {
      const diff = summarizeNoticeDiff(cur.ok ? cur.text : '', check.text);
      await notifyOwner('待审群公告', [
        `来源：${source === 'owner' ? '管理员' : '机器人起草'}`,
        `群：${gid}`,
        `与当前公告的差异：${diff}`,
        '',
        '—— 草稿全文 ——',
        check.text,
        '',
        '回复「通过」发布，回复「拒绝」放弃（30 分钟内有效）。'
      ].join('\n'));
    }
    return { ok: true, pending, diff: summarizeNoticeDiff(cur.ok ? cur.text : '', check.text) };
  }

  async function approvePendingNotice(by = 'owner') {
    const c = adminCfg();
    const pending = currentPendingNotice();
    if (!pending) return { ok: false, error: '没有待审公告（或已超时作废）' };
    if (!c.announcement.enabled) return { ok: false, error: '公告功能已关闭' };
    const botRole = await getBotRole(pending.groupId || adminGroups()[0]);
    if (botRole !== 'admin' && botRole !== 'owner') {
      await warnNotAdmin(pending.groupId || adminGroups()[0], '发布公告');
      return { ok: false, error: '机器人不是管理员，无法发布公告' };
    }
    try {
      const text = await publishNotice(pending.groupId || adminGroups()[0], pending.content);
      pendingNotice = { version: 1, pending: null };
      savePendingNoticeSafe();
      pushModerationRecord({ groupId: pending.groupId, action: 'announce', trigger: 'announcement', by, ok: true, reason: `发布群公告（${text.length} 字）` });
      log(`[admin] 群公告已发布（by ${by}，${text.length} 字）`);
      appendActivity(`[admin] 群公告已发布（by ${by}）`);
      return { ok: true, text };
    } catch (error) {
      pushModerationRecord({ groupId: pending.groupId, action: 'announce', trigger: 'announcement', by, ok: false, error: String(error?.message ?? error) });
      log(`[admin] 发布公告失败：${error?.message ?? error}`);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  function rejectPendingNotice(reason = '') {
    const pending = currentPendingNotice();
    if (!pending) return { ok: false, error: '没有待审公告' };
    pendingNotice = { version: 1, pending: null };
    savePendingNoticeSafe();
    pushModerationRecord({ groupId: pending.groupId, action: 'announce', trigger: 'announcement', by: 'owner', ok: false, reason: `管理员拒绝发布${reason ? '：' + reason : ''}` });
    log('[admin] 群公告草稿被拒绝');
    return { ok: true };
  }

  function saveSlangStore() {
    try { saveSlang(SLANG_FILE, slangEntries); } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: text.slice(0, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI/控制台的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      evidence: Array.isArray(e?.evidence) ? e.evidence.slice(-5) : [],
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // [qq-bridge 本地补丁] 直接使用已签名的会话 Cookie（见 scripts/forge-dsh-cookie.mjs）
    cookie: cfg.dsh.authCookie || ''
  });
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // [qq-bridge 本地补丁] key -> 等待开始时刻。
  // 既是「同一会话只允许一个长轮询」的锁，也用于识别**泄漏的陈旧锁**：历史上出现过
  // 客户端断开但 finishWait 没跑到（异常路径）导致锁永久占住，之后所有
  // qq_wait_for_messages / qq_mark_read / qq_set_wake_config 全被 429 挡死。
  const activeWaits = new Map();
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  //
  // [qq-bridge 本地补丁] 上面这个租约只清 pendingWakeKeys，而 isConversationBusyV2 还会看
  // collectors / v2TurnStartAt；只要 turn/end 事件丢一次，这两个标记就永远不会被清，
  // 会话会永久停在“会话繁忙”，所有 @ 都被暂存吞掉（实测踩过）。下面补一个覆盖全部标记的看门狗。
  const BUSY_WATCHDOG_MS = (Number(process.env.QQ_BRIDGE_BUSY_WATCHDOG_MIN) > 0
    ? Number(process.env.QQ_BRIDGE_BUSY_WATCHDOG_MIN)
    : 20) * 60 * 1000; // 上限（agent 正在长等待/长工具里时用）
  // [qq-bridge 本地补丁] 短阈值：没有任何已知长操作时，多少分钟无事件就去问 DSH 要 running 状态。
  // 现在这个值只是"多久查一次"的节流，不是判决依据——到点后由 DSH 的 running 字段拍板，
  // 所以可以设得比较短（2 分钟），既能让丢 turn/end 的卡死会话快速自愈，又不会误杀活回合。
  const BUSY_WATCHDOG_SHORT_MS = (Number(process.env.QQ_BRIDGE_BUSY_WATCHDOG_SHORT_MIN) > 0
    ? Number(process.env.QQ_BRIDGE_BUSY_WATCHDOG_SHORT_MIN)
    : 2) * 60 * 1000;

  /**
   * 当前这个会话允许的最长静默时间。
   * 会叠加三类"合法静默"证据：
   *   1) activeWaits：正阻塞在 qq_wait_for_messages 长轮询里（最长 10 分钟）；
   *   2) imageQuota/longTaskUntil：正在跑 qq_generate_image（codex 生图 1~4 分钟，默认上限 10 分钟），
   *      由 /api/socialV2/image-request 在扣配额时下发租约；
   *   3) 兜底上限 BUSY_WATCHDOG_MS。
   */
  function busyWatchdogLimitMs(key) {
    let limit = activeWaits.has(key) ? BUSY_WATCHDOG_MS : BUSY_WATCHDOG_SHORT_MS;
    try {
      const st = socialV2.conversations.get(key);
      const until = Number(st?.longTaskUntil) || 0;
      if (until > Date.now()) {
        limit = Math.max(limit, until - Date.now());
      } else if (until) {
        st.longTaskUntil = 0;
      }
    } catch { /* 状态异常时按默认阈值 */ }
    return limit;
  }
  const busyWatchdogAt = new Map();        // key -> 最近一次该会话有 DSH 活动的时刻
  const busyWatchdogTimer = new Map();     // key -> 定时器（到点兜底恢复）
  let watchdogSweepInFlight = false;       // 防止并发扫描（每次扫描要向 DSH 问一次）

  function markSessionActivity(key) {
    if (!key) return;
    busyWatchdogAt.set(key, Date.now());
  }

  /**
   * [qq-bridge 本地补丁] 问 DSH：哪些会话现在还有回合在跑？
   * session/list 的每一项都带 `running` 布尔值，这是权威答案。有了它，看门狗就不必再靠
   * 「多少分钟没有事件」去猜——那个猜测正是之前把正在长轮询/生图的活回合误杀的根源。
   * 返回 null 表示查询失败（调用方退回保守的时间阈值）。
   */
  async function fetchRunningSessions() {
    try {
      const list = unwrap(await api.sessions.list({}), 'watchdog session.list');
      const map = new Map();
      for (const item of list.items ?? []) map.set(String(item.sessionId), item.running === true);
      return map;
    } catch (error) {
      log(`[watchdog] 查询会话运行状态失败：${error?.message ?? error}（本轮退回按事件静默判断）`);
      return null;
    }
  }

  /** 强制清掉一个会话的全部 busy 标记（collectors / v2TurnStartAt / promptQueues / pendingWakeKeys） */
  function clearConversationBusy(key) {
    const sid = state.sessions?.[key];
    if (sid) {
      collectors.delete(sid);
      v2TurnStartAt.delete(sid);
      pendingSendToolCalls.delete(sid);
    }
    const q = promptQueues.get(key);
    if (q) promptQueues.delete(key);
    pendingWakeKeys.delete(key);
    armPendingWakeLease(key); // 重新上租约，万一这次真是慢回合，30 分钟后仍有兜底
  }

  /**
   * 看门狗：清理「本地认为 busy、但 DSH 说早就没在跑」的卡死会话，并重投期间被暂存的唤醒。
   *
   * 判定顺序（先便宜后昂贵）：
   *   1) 静默时间没到 busyWatchdogLimitMs（含长轮询/生图租约）→ 什么都不做；
   *   2) 到点了就问 DSH 要 running 权威状态：
   *        - running=true  → 活回合，只重置静默计时，绝不打断；
   *        - running=false → turn/end 事件确实丢了，清标记 + 真停旧会话 + 重投暂存唤醒；
   *        - 查询失败      → 退回保守的 BUSY_WATCHDOG_MS 长阈值再等。
   */
  async function watchdogBusyConversations() {
    if (watchdogSweepInFlight) return;
    const due = [...busyWatchdogTimer.keys()].filter((key) => {
      const idle = Date.now() - (busyWatchdogAt.get(key) ?? Date.now());
      return idle >= busyWatchdogLimitMs(key);
    });
    if (!due.length) return;
    watchdogSweepInFlight = true;
    try {
      const runningMap = await fetchRunningSessions();
      for (const key of due) {
        const idleMs = Date.now() - (busyWatchdogAt.get(key) ?? Date.now());
        if (idleMs < busyWatchdogLimitMs(key)) continue; // 等待期间又有事件/新租约，放过
        const mapped = state.sessions?.[key];
        if (runningMap) {
          if (mapped && runningMap.get(mapped) === true) {
            log(`[watchdog] ${key} 已静默 ${Math.round(idleMs / 1000)}s，但 DSH 报告该会话仍在运行 → 保留，不打断`);
            markSessionActivity(key);
            continue;
          }
        } else if (idleMs < BUSY_WATCHDOG_MS) {
          // 查不到运行状态时保守处理：等满长阈值再动手。
          continue;
        }
        const timer = busyWatchdogTimer.get(key);
        if (timer) clearTimeout(timer);
        busyWatchdogTimer.delete(key);
        busyWatchdogAt.delete(key);
        log(`[watchdog] 会话 ${key} 已静默 ${Math.round(idleMs / 1000)}s 且 DSH 报告已无运行中的回合`
          + `${runningMap ? '' : '（运行状态查询失败，按兜底阈值处理）'} → 清除 busy 标记`);
        clearConversationBusy(key);
        // [qq-bridge 本地补丁] 释放等待锁：旧回合若卡在 qq_wait_for_messages 里，这把锁会一直占着，
        // 新会话的每次等待都会被 429「已有一个等待中」挡回去（实测卡死十几分钟）。
        activeWaits.delete(key);
        // 复活该会话：下条消息会重建会话（旧会话已卡死，放弃复用）
        if (state.sessions?.[key]) {
          const dead = state.sessions[key];
          delete state.sessions[key];
          if (state.sessionPolicies) delete state.sessionPolicies[key];
          reverse.delete(dead);
          collectors.delete(dead);
          v2TurnStartAt.delete(dead);
          promptQueues.delete(key);
          try { saveState(); } catch {}
          // [qq-bridge 本地补丁] 必须真的让 DSH 停掉旧会话的回合。
          // 只解除本地映射是不够的：旧 agent 还在跑（典型表现是它继续重试 qq_wait_for_messages、
          // 继续以机器人身份发消息），而下次唤醒会新建一个会话 —— 两个 agent 同时操作同一个群，
          // 互相抢等待锁、重复发言，群里会看到"两个机器人"。
          log(`[watchdog] 已解绑卡死会话 ${dead}，并请求 DSH 停止其工作（下次唤醒将重建）`);
          try { await api.stopSessionWork(dead); }
          catch (error) { log(`⚠️ [watchdog] 停止旧会话失败 ${dead}：${error?.message ?? error}；请到 DSH 手动结束该会话的回合`); }
        }
        // 把“会话繁忙”期间被暂存的唤醒原因重新排队，避免这次 @ 被吞掉
        try {
          const st = getSocialV2State(key);
          const stale = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.splice(0) : [];
          if (!stale.length) {
            log(`[watchdog] ${key} 没有暂存的唤醒原因，等待下一条群消息`);
            continue;
          }
          const best = stale.sort((a, b) => wakePriorityV2(b?.reason) - wakePriorityV2(a?.reason))[0];
          log(`[watchdog] ${key} 重新投递唤醒：${best?.reason}（暂存 ${stale.length} 条中的最高优先级）`);
          scheduleWakeV2(key, best?.reason ?? 'atMention');
        } catch (error) {
          log(`[watchdog] ${key} 重新投递失败：${error?.message ?? error}`);
        }
      }
    } catch (error) {
      log(`[watchdog] 巡检异常：${error?.message ?? error}`);
    } finally {
      watchdogSweepInFlight = false;
    }
  }

  function armBusyWatchdog(key) {
    if (!key || busyWatchdogTimer.has(key)) return;
    busyWatchdogAt.set(key, Date.now());
    const timer = setTimeout(() => {
      void watchdogBusyConversations().catch((error) => log(`[watchdog] 巡检异常：${error?.message ?? error}`));
    }, BUSY_WATCHDOG_MS + 1000);
    timer.unref?.();
    busyWatchdogTimer.set(key, timer);
  }
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }
  function clearAllBusyWatchdogs() {
    for (const t of busyWatchdogTimer.values()) clearTimeout(t);
    busyWatchdogTimer.clear();
    busyWatchdogAt.clear();
  }
  // [qq-bridge 本地补丁] busy 看门狗周期性巡检：即使没有新消息进来（不会走 isConversationBusyV2），
  // 也能自动恢复"本地 busy 但 DSH 早已没在跑"的卡死会话。
  const busyWatchdogSweep = setInterval(() => {
    void watchdogBusyConversations().catch((error) => log(`[watchdog] 巡检异常：${error?.message ?? error}`));
  }, 30 * 1000);
  busyWatchdogSweep.unref?.();

  // [qq-bridge 本地补丁] 余额水位检查（低于阈值只私聊提醒 owner，不在群里说钱）
  try { startFeedTimers(); } catch (error) { log(`⚠️ 余额水位检查启动失败：${error?.message ?? error}`); }


  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  const VALID_MODES = ['chat', 'closed-agent', 'reserved', 'reserved2'];
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        dshDefaultPreset = presetNs.value.default;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      if (ns?.value && typeof ns.value.mode === 'string' && VALID_MODES.includes(ns.value.mode)) {
        currentMode = ns.value.mode;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    if (local?.mode && VALID_MODES.includes(local.mode)) currentMode = local.mode;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      KNOWN_AGENT_TOKENS.add(st.agentToken);
      st.bootstrapSent = false;
    }
    saveState();
    saveSocialV2State();
    void (async () => {
      try { await api.stopSessionWork(sessionId); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  const flushQueue = async () => {
    if (flushingQueue) return;
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [] });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && token === st.agentToken;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const v2ToolEnabled = (flag) => cfg.socialV2?.tools?.[flag] !== false;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
      if (consoleToken && suppliedToken !== consoleToken) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/meme-probe', '/api/socialV2/meme-test-send', '/api/socialV2/mute', '/api/socialV2/unmute', '/api/socialV2/moderation-log', '/api/socialV2/announcement/approve', '/api/socialV2/announcement/reject', '/api/socialV2/owner-dm-simulate', '/api/socialV2/image-ack-preview'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(body.mode)) {
            sendJson({ ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2' }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: body.mode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: body.mode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          if (currentMode === 'reserved' && body.mode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && body.mode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = body.mode;
          lastMode = body.mode;
          reconcileSessionPolicies();
          if (body.mode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          sendJson({ roles: listRoles(), current: rs.role ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          const name = sanitizeRoleName(body.name);
          const content = String(body.content ?? '').trim();
          if (!name) { sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return; }
          if (!content) { sendJson({ ok: false, error: '角色内容不能为空' }, 400); return; }
          if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return; }
          fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
          atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
          log(`控制台：创建人格「${name}」`);
          sendJson({ ok: true, role: name });
          return;
        }
        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readJsonSafe(configFile, null, true);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({ security: cfg.security ?? { interceptNotify: true } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const current = file.socialV2 ?? {};
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'memes', 'admin', 'image', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'getBalance', 'getImage', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'sendMeme', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'requestMute', 'proposeAnnouncement', 'adminInfo'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // memes：本地表情包库参数归一化
          if (body.memes && typeof body.memes === 'object') {
            merged.memes = { ...(current.memes ?? {}), ...body.memes };
            if (merged.memes.enabled !== undefined) merged.memes.enabled = merged.memes.enabled === true;
            if (merged.memes.includeInPrompt !== undefined) merged.memes.includeInPrompt = merged.memes.includeInPrompt === true;
            for (const k of ['promptMaxMemes', 'maxPerMinute', 'maxPerHour', 'recentAvoid', 'maxFileBytes', 'rescanTtlMs']) {
              if (merged.memes[k] !== undefined) {
                const n = Number(merged.memes[k]);
                merged.memes[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.memes?.[k] ?? 0;
              }
            }
            if (merged.memes.promptMaxMemes !== undefined) merged.memes.promptMaxMemes = Math.min(30, Math.max(1, merged.memes.promptMaxMemes));
            if (merged.memes.packDirs !== undefined) {
              merged.memes.packDirs = (Array.isArray(merged.memes.packDirs) ? merged.memes.packDirs : String(merged.memes.packDirs).split(/\r?\n/)).map(String).map((s) => s.trim()).filter(Boolean);
            }
            if (merged.memes.packs !== undefined) {
              merged.memes.packs = (Array.isArray(merged.memes.packs) ? merged.memes.packs : String(merged.memes.packs).split(/[,，\s]+/)).map(String).map((s) => s.trim()).filter(Boolean);
            }
          }
          // admin：群管理（禁言 / 群公告）参数归一化（用 mergeAdminConfig 收敛，避免控制台传入非法值）
          if (body.admin && typeof body.admin === 'object') {
            const mergedAdmin = mergeAdminConfig({ ...(current.admin ?? {}), ...body.admin });
            merged.admin = mergedAdmin;
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
            }
            const removedV2 = socialV2.conversations.get(key);
            if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          clearAllBusyWatchdogs();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            getBalance: 'qq_get_balance',
            // [qq-bridge 本地补丁] 生图（必须被 @ 且正文以"生图"开头）
            getImage: 'qq_generate_image',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            sendMeme: 'qq_send_meme',
            adminInfo: 'qq_group_admin_info',
            requestMute: 'qq_request_mute',
            proposeAnnouncement: 'qq_propose_announcement',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            memes: (() => {
              const mc = memeCfg();
              if (mc.enabled === false) return { enabled: false, total: 0, packs: [], context: '', strategy: '' };
              try {
                const { catalog, packs } = ensureMemeCatalog(false);
                return {
                  enabled: true,
                  total: catalog.length,
                  packs: packs.map((p) => ({ id: p.id, name: p.name, count: p.rows.length })),
                  moods: Object.keys(MEME_MOODS),
                  context: mc.includeInPrompt !== false ? buildMemeContext(catalog, memeStats, packs, mc.promptMaxMemes) : '',
                  strategy: mc.includeInPrompt !== false ? buildMemeStrategyHint(cfg.socialV2?.sticker?.enabled !== false) : ''
                };
              } catch (error) {
                return { enabled: true, total: 0, packs: [], error: String(error?.message ?? error), context: '', strategy: '' };
              }
            })(),
            admin: await (async () => {
              const c = adminCfg();
              checkDryRunExpiry();
              const gid = adminGroups()[0] ?? '';
              const pendingNow = c.announcement.enabled ? currentPendingNotice() : null;
              const dry = adminDryRun();
              const left = dryRunRemainingMs(c);
              return {
                enabled: c.enabled,
                dryRun: dry,
                dryRunUntil: c.dryRunUntil || 0,
                dryRunRemainingMs: left,
                groupId: gid,
                botRole: gid ? (await getBotRole(gid).catch(() => '')) : '',
                canMute: (c.enabled && !dry) ? undefined : false,
                limits: { maxPerHour: c.limits.maxPerHour, maxPerDay: c.limits.maxPerDay },
                muteRules: {
                  spamRepeatCount: c.spam.sameTextCount,
                  spamWindowMs: c.spam.windowMs,
                  attackCount: c.attack.count,
                  attackWindowMs: c.attack.windowMs,
                  muteSeconds: { min: c.mute.minSec, max: c.mute.maxSec, spamBase: c.mute.spamBaseSec, attackBase: c.mute.attackBaseSec, step: c.mute.stepSec }
                },
                neverAllowed: ['踢人', '全员禁言', '改群名/群名片', '群相册', '群文件', '设/撤管理员'],
                pendingNotice: pendingNow ? { id: pendingNow.id, createdAt: pendingNow.createdAt, length: pendingNow.content.length } : null,
                recent: moderationLog.records.slice(-5).reverse().map(formatRecordLine)
              };
            })()
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-limit) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          sendJson({ ok: true, key, messages: st.recentMessages.slice(start, end) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = st.unread.length;
          st.unread = [];
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          saveSocialV2State();
          sendWakePromptV2(key, reason);
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
          const gapMode = (isRawString && messages.length > 1) ? 'auto' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'auto');
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: text.slice(0, 200),
              plain: text.slice(0, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/meme-test-send') {
          // 仅控制台：手工发一张本地表情包，用于验证图库与发送链路（不影响 AI 的状态机）。
          if (!memeEnabled()) { sendJson({ ok: false, error: '本地表情包库已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tag = String(body.tag ?? '').trim() || 'happy';
          const query = String(body.query ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          try {
            const list = memeListForV2(tag, query, 1);
            if (!list.ok || !list.candidates?.length) { sendJson({ ok: false, error: list.error || '没抽到图' }, 404); return; }
            const picked = list.candidates[0];
            const sent = await sendMemeV2(key, picked.path, { context: 'console-test' });
            log(`[meme] 控制台测试发送 ${key}: ${picked.path}`);
            appendActivity(`${key} [meme] 控制台测试发送：${picked.caption}`);
            sendJson({ ok: true, key, mood: list.mood, meme: { path: picked.path, caption: picked.caption, pack: picked.pack }, messageId: sent.messageId ?? null });
          } catch (error) {
            sendJson({ ok: false, error: `测试发送失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 群管理（禁言 / 群公告）──────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/image-ack-preview') {
          // 仅控制台：预览"生图开始提示"会说什么（只渲染，不发群）。用来校验模板/人设口吻。
          const body = await readBody();
          const name = String(body.name ?? '甲').slice(0, 40);
          const remaining = body.remaining === undefined || body.remaining === null ? 5 : Number(body.remaining);
          const isOwner = body.isOwner === true;
          const samples = [];
          for (let i = 0; i < 6; i++) {
            // 用不同随机种子把模板池轮一遍（i/6 覆盖整池）
            const line = pickImageAckLine(cfg.socialV2?.image ?? {}, { name, remaining: isOwner ? null : remaining, isOwner, random: () => (i + 0.5) / 6 });
            if (line && !samples.includes(line)) samples.push(line);
          }
          sendJson({ ok: true, enabled: (cfg.socialV2?.image?.ackEnabled !== false), name, remaining: isOwner ? null : remaining, samples });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/owner-dm-simulate') {
          // 仅控制台：把一段文字当作"owner 私聊发来的话"走一遍同样的处理逻辑（用于验证私聊审批链路）。
          // 不新增任何能力：控制台本来就能直接 approve/reject。
          const body = await readBody();
          const text = String(body.text ?? '').trim();
          if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
          const ownerId = String(cfg.ownerQQ ?? '');
          const fakeEvent = { user_id: Number(ownerId), message: [{ type: 'text', data: { text } }] };
          const before = pendingNotice.pending?.id ?? null;
          let handled = false;
          try {
            handled = await handleOwnerPrivateCommand(`private:${ownerId}`, ownerId, fakeEvent);
          } catch (error) {
            sendJson({ ok: false, error: `模拟失败：${error?.message ?? error}` }, 500);
            return;
          }
          const after = pendingNotice.pending?.id ?? null;
          sendJson({ ok: true, text, handled, pendingBefore: before, pendingAfter: after, note: handled ? '已被 owner 私聊处理器接管' : '未被接管（会走正常白名单/会话逻辑）' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/admin-status') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          checkDryRunExpiry();
          const groupId = key.startsWith('group:') ? key.slice(6) : (adminGroups()[0] ?? '');
          const c = adminCfg();
          const botRole = groupId ? await getBotRole(groupId).catch(() => '') : '';
          const cur = groupId ? await fetchCurrentNotice(groupId) : { ok: false, text: '', count: 0 };
          const pendingNow = currentPendingNotice();
          const recent = moderationLog.records.slice(-10).reverse().map((r) => ({ ...r, line: formatRecordLine(r) }));
          sendJson({
            ok: true,
            key,
            enabled: c.enabled,
            dryRun: adminDryRun(),
            dryRunUntil: c.dryRunUntil || 0,
            dryRunRemainingMs: dryRunRemainingMs(c),
            groups: adminGroups(),
            groupId,
            botRole,
            canManage: botRole === 'admin' || botRole === 'owner',
            spendToday: moderationLog.records.filter((r) => r.action === 'mute' && r.ok !== false && r.dryRun !== true && Number(r.at) >= (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })()).length,
            muted: Object.entries(moderationLog.mutedUntil).filter(([, t]) => Number(t) > Date.now()).map(([k, t]) => ({ target: k, until: Number(t) })),
            currentNotice: { ok: cur.ok, count: cur.count ?? 0, text: String(cur.text ?? '').slice(0, 4000), publishTime: cur.publishTime ?? 0 },
            pendingNotice: pendingNow ? { id: pendingNow.id, createdAt: pendingNow.createdAt, source: pendingNow.source, content: pendingNow.content } : null,
            recent
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/moderation-log') {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          const rows = moderationLog.records.slice(-limit).reverse();
          sendJson({ ok: true, total: moderationLog.records.length, records: rows, lines: rows.map(formatRecordLine) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mute') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const userId = String(body.userId ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch || keyMatch[1] !== 'group' || !/^\d+$/.test(userId)) { sendJson({ ok: false, error: '需要 group:群号 形式的 key 和数字 userId' }, 400); return; }
          const groupId = keyMatch[2];
          const c = adminCfg();
          const minutes = Math.max(1, Math.min(10, Number(body.minutes) || 3));
          try {
            const botRole = await getBotRole(groupId);
            if (botRole !== 'admin' && botRole !== 'owner') { sendJson({ ok: false, error: '机器人不是该群管理员，禁言会被 QQ 拒绝' }, 409); return; }
            const targetInfo = await getMemberInfo(groupId, userId, true);
            const guard = canMuteTarget({ targetId: userId, targetRole: targetInfo.role, botRole, botId: botSelfId, ownerQQ: cfg.ownerQQ, groupOwnerId: String(cfg.ownerQQ ?? ''), whitelist: [] });
            if (!guard.ok) { sendJson({ ok: false, error: `不能禁言该成员：${guard.reason}` }, 403); return; }
            const sec = await callMute(groupId, userId, Math.max(c.mute.minSec, Math.min(c.mute.maxSec, minutes * 60)));
            moderationLog.mutedUntil[`${groupId}:${userId}`] = Date.now() + sec * 1000;
            const rec = pushModerationRecord({ groupId, userId, userName: targetInfo.name, action: 'mute', trigger: 'manual', by: 'owner', seconds: sec, ok: true, reason: '控制台手动禁言' });
            log(`[admin] 控制台手动禁言 ${groupId}/${userId} ${Math.round(sec / 60)} 分钟`);
            sendJson({ ok: true, seconds: sec, record: rec, line: formatRecordLine(rec) });
          } catch (error) {
            pushModerationRecord({ groupId, userId, action: 'mute', trigger: 'manual', by: 'owner', ok: false, error: String(error?.message ?? error) });
            sendJson({ ok: false, error: `禁言失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/unmute') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const userId = String(body.userId ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch || keyMatch[1] !== 'group' || !/^\d+$/.test(userId)) { sendJson({ ok: false, error: '需要 group:群号 形式的 key 和数字 userId' }, 400); return; }
          const groupId = keyMatch[2];
          try {
            await callUnmute(groupId, userId);
            delete moderationLog.mutedUntil[`${groupId}:${userId}`];
            const rec = pushModerationRecord({ groupId, userId, action: 'unmute', trigger: 'manual', by: 'owner', ok: true, reason: '控制台手动解禁' });
            sendJson({ ok: true, line: formatRecordLine(rec) });
          } catch (error) {
            sendJson({ ok: false, error: `解禁失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mute-request') {
          // 模型提议禁言：桥接必须自己核验证据，核验不过一律拒绝。
          if (!adminEnabled()) { sendJson({ ok: false, error: '群管理已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('requestMute')) { sendJson({ ok: false, error: '工具未启用：qq_request_mute' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          const userId = String(body.userId ?? '').trim();
          if (!keyMatch || keyMatch[1] !== 'group' || !/^\d+$/.test(userId)) { sendJson({ ok: false, error: '需要 group:群号 形式的 key 和数字 userId' }, 400); return; }
          const groupId = keyMatch[2];
          if (!adminAppliesToGroup(groupId)) { sendJson({ ok: false, error: '该群未启用群管理' }, 403); return; }
          const c = adminCfg();
          const st = getSocialV2State(key);
          const messages = Array.isArray(st.recentMessages) ? st.recentMessages : [];
          const reason = String(body.reason ?? '').slice(0, 200);
          const now = Date.now();
          const rep = c.spam.enabled ? detectRepeat(messages, { cfg: c.spam, now, textThreshold: c.spam.sameTextCount }) : { hit: false };
          const atk = c.attack.enabled ? detectAttack(messages, { cfg: c.attack, now, senderId: userId, rudeKeywords: cfg.socialV2?.affinity?.rudeKeywords }) : { hit: false };
          const perUser = rep.hit && String(rep.senderId) === userId ? { ...rep, kind: rep.kind } : (atk.hit ? atk : null);
          if (!perUser) {
            pushModerationRecord({ groupId, userId, action: 'skip', trigger: 'model-request', by: 'model', ok: false, reason: `模型提议被拒（证据不足）：${reason}` });
            sendJson({ ok: false, error: '证据不足：桥接没有在最近消息里核验到"同内容重复"或"针对机器人的辱骂"，已拒绝禁言', reason }, 403);
            return;
          }
          const triggerKind = perUser.kind === 'attack' ? 'attack' : (perUser.kind === 'image' ? 'image-repeat' : 'text-repeat');
          const priorMutes24h = countRecentMutes(moderationLog.records, { groupId, userId, now, windowHours: c.mute.repeatWindowHours });
          const plan = planMuteSeconds({ triggerKind, priorMutes24h, cfg: c });
          const botRole = await getBotRole(groupId);
          const targetRole = await getMemberRole(groupId, userId);
          const guard = canMuteTarget({ targetId: userId, targetRole, botRole, botId: botSelfId, ownerQQ: cfg.ownerQQ, groupOwnerId: String(cfg.ownerQQ ?? ''), whitelist: c.whitelist });
          if (!guard.ok) {
            pushModerationRecord({ groupId, userId, action: 'skip', trigger: triggerKind, by: 'model', ok: false, reason: guard.reason });
            sendJson({ ok: false, error: guard.reason }, 403);
            return;
          }
          const limits = checkMuteLimits({ records: moderationLog.records, mutedUntil: moderationLog.mutedUntil, groupId, userId, now, cfg: c });
          if (!limits.ok) {
            pushModerationRecord({ groupId, userId, action: 'skip', trigger: triggerKind, by: 'model', ok: false, reason: limits.reason });
            sendJson({ ok: false, error: limits.reason }, 429);
            return;
          }
          const base = {
            groupId, userId, userName: userNameOf(userId, messages), action: 'mute', trigger: triggerKind,
            seconds: plan.seconds, by: 'model', count: perUser.count, evidence: perUser.evidence ?? [], reason: `${plan.reason}（模型提议：${reason}）`
          };
          if (adminDryRun()) {
            const rec = pushModerationRecord({ ...base, dryRun: true, ok: true });
            log(`[admin] 干跑（模型提议）：本会禁言 ${groupId}/${userId} ${Math.round(plan.seconds / 60)} 分钟`);
            await notifyOwnerModeration(rec, '（模型提议，干跑中：只记录，没有真的禁言）');
            sendJson({ ok: true, dryRun: true, seconds: plan.seconds, line: formatRecordLine(rec) });
            return;
          }
          try {
            const sec = await callMute(groupId, userId, plan.seconds);
            moderationLog.mutedUntil[`${groupId}:${userId}`] = now + sec * 1000;
            const rec = pushModerationRecord({ ...base, seconds: sec, ok: true });
            log(`[admin] 已禁言（模型提议）${groupId}/${userId} ${Math.round(sec / 60)} 分钟`);
            await notifyOwnerModeration(rec);
            if (c.announceInGroup) {
              const line = pickAnnounceLine(c, { name: base.userName || `QQ ${userId}`, minutes: Math.round(sec / 60), kind: triggerKind });
              await sendToQQ(key, line).catch(() => {});
            }
            const st = getSocialV2State(key);
            st.moderationNote = { at: now, userId, userName: base.userName, kind: triggerKind, minutes: Math.round(sec / 60), count: perUser.count };
            saveSocialV2State();
            sendJson({ ok: true, seconds: sec, line: formatRecordLine(rec) });
          } catch (error) {
            pushModerationRecord({ ...base, ok: false, error: String(error?.message ?? error) });
            sendJson({ ok: false, error: `禁言失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/announcement') {
          const groupId = String(url.searchParams.get('groupId') ?? adminGroups()[0] ?? '');
          const cur = groupId ? await fetchCurrentNotice(groupId) : { ok: false, text: '', count: 0 };
          const pendingNow = currentPendingNotice();
          sendJson({ ok: true, groupId, current: cur, pending: pendingNow, dryRun: adminCfg().dryRun });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/announcement/propose') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('proposeAnnouncement')) { sendJson({ ok: false, error: '工具未启用：qq_propose_announcement' }, 403); return; }
          const content = String(body.content ?? '');
          if (!content.trim()) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          const groupId = String(body.groupId ?? (key.startsWith('group:') ? key.slice(6) : adminGroups()[0] ?? ''));
          const r = await proposeNotice(content, req.headers['x-agent-token'] ? 'model' : 'owner', groupId);
          sendJson(r, r.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/announcement/approve') {
          const r = await approvePendingNotice('console');
          sendJson(r, r.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/announcement/reject') {
          const body = await readBody();
          const r = rejectPendingNotice(String(body.reason ?? '控制台拒绝'));
          sendJson(r, r.ok ? 200 : 400);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/meme-probe') {
          // 仅控制台：强制重扫图库，返回实际载入结果，方便排查“为什么没图可发”。
          try {
            const mc = memeCfg();
            const { catalog, packs, dirs } = ensureMemeCatalog(true);
            const moods = {};
            for (const m of catalog) moods[m.mood || '?'] = (moods[m.mood || '?'] || 0) + 1;
            sendJson({
              ok: true,
              enabled: mc.enabled !== false,
              dirs,
              total: catalog.length,
              packs: packs.map((p) => ({ id: p.id, name: p.name, count: p.rows.length, source: p.source, dir: p.dir })),
              moods,
              recent: recentMemeIds(memeStats, 10),
              usageEntries: Object.keys(memeStats?.entries || {}).length
            });
          } catch (error) {
            sendJson({ ok: false, error: `检测图库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/meme-list') {
          if (!memeEnabled()) { sendJson({ ok: false, error: '本地表情包库已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMeme')) { sendJson({ ok: false, error: '工具未启用：qq_send_meme' }, 403); return; }
          try {
            const tag = String(url.searchParams.get('tag') ?? '').trim();
            const query = String(url.searchParams.get('query') ?? '').trim();
            const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 8));
            const result = memeListForV2(tag, query, limit);
            sendJson({ key, ...result });
          } catch (error) {
            sendJson({ ok: false, error: `读取本地图库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/meme-image') {
          if (!memeEnabled()) { sendJson({ ok: false, error: '本地表情包库已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const ref = String(url.searchParams.get('path') ?? url.searchParams.get('ref') ?? '').trim();
          if (!key || !ref) { sendJson({ ok: false, error: 'key 和 path 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMeme')) { sendJson({ ok: false, error: '工具未启用：qq_send_meme' }, 403); return; }
          try {
            const img = memeImageData(ref);
            sendJson({
              ok: true,
              key,
              meme: { path: img.meme.id, tag: img.meme.tag, mood: img.meme.mood, caption: img.meme.caption, pack: img.meme.packId },
              image: { mimeType: img.mimeType, data: img.base64, size: img.size }
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取表情包图片失败：${error?.message ?? error}` }, 404);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-meme') {
          if (!memeEnabled()) { sendJson({ ok: false, error: '本地表情包库已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const ref = String(body.path ?? body.ref ?? body.memeId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !ref) { sendJson({ ok: false, error: 'key 和 path 不能为空' }, 400); return; }
          // 一条消息只能是一张图，不能在同一气泡里附带文字说明（与收藏表情一致）。
          if (caption) {
            sendJson({ ok: false, error: '图片消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_meme 发图' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMeme')) { sendJson({ ok: false, error: '工具未启用：qq_send_meme' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const mc = memeCfg();
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(mc.maxPerMinute) || 0;
            const maxPerHour = Number(mc.maxPerHour) || 0;
            const recentMinute = (st.memeSendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.memeSendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发表情包太频繁了，先聊两句再发' }, 429);
              return;
            }
            // 表情包与文本共用总发送限频，避免“发图绕过刷屏保护”。
            const globalMaxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const globalRecentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            if (globalMaxPerMinute > 0 && globalRecentMinute + 1 > globalMaxPerMinute) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.memeSendTimes = st.memeSendTimes || [];
            st.memeSendTimes.push(now);
            if (st.memeSendTimes.length > 500) st.memeSendTimes = st.memeSendTimes.slice(-500);
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendMemeV2(key, ref, {
              replyToMessageId: actualReplyToMessageId,
              atUserId,
              context: `${key} ${String(ref).slice(0, 40)}`
            });
            const label = sent.meme?.caption || sent.meme?.rel || '表情包';
            const text = `[表情包:${String(label).slice(0, 60)}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text,
              plain: text,
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              meme: { id: sent.meme?.id || ref, caption: String(label).slice(0, 80), mood: sent.meme?.mood || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[meme] 工具发送表情包 ${key}: ${sent.meme?.id || ref}`);
            appendActivity(`${key} [meme] 工具发送表情包：${String(label).slice(0, 40)}`);
            sendJson({ ok: true, key, meme: { path: sent.meme?.id, caption: sent.meme?.caption, mood: sent.meme?.mood }, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            for (const arr of ['memeSendTimes', 'sendTimes']) {
              const list = st[arr];
              if (Array.isArray(list)) {
                const idx = list.indexOf(now);
                if (idx >= 0) list.splice(idx, 1);
              }
            }
            saveSocialV2State();
            log(`[meme] 工具发送表情包失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情包失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          let force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 但如果这把锁已经远超「单次等待可能的最长时长」，说明它是异常路径泄漏的
          // （客户端断开时 finishWait 没跑到），必须就地回收，否则该会话会永久 429。
          if (activeWaits.has(key)) {
            const startedAt = Number(activeWaits.get(key)) || 0;
            const staleMs = (Number(waitCfg.maxMs) || 600000) + 120000;
            if (startedAt && Date.now() - startedAt > staleMs) {
              log(`[reserved2] 回收陈旧的长等待锁 ${key}（已挂起 ${Math.round((Date.now() - startedAt) / 1000)}s，超过 ${Math.round(staleMs / 1000)}s）`);
              activeWaits.delete(key);
            } else {
              sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
              return;
            }
          }
          activeWaits.set(key, Date.now());
          const finishWait = () => activeWaits.delete(key);
          req.on('close', finishWait);
          let waitFinished = false;
          const finishWaitOnce = () => { if (!waitFinished) { waitFinished = true; finishWait(); } };
          try {
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          const baseline = st.lastUnreadSeq || 0;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          saveSocialV2State();
          const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !!st.preSleepWaitObservedAt,
            preSleepWaitMs,
            preSleepWaitRemainingMs: preSleepRemainingMs,
            newMessages,
            unreadCount: st.unread.length
          });
          } finally {
            // [qq-bridge 本地补丁] 无论正常返回、抛异常还是客户端提前断开，都必须释放等待锁，
            // 否则这把锁会永久占住该会话（历史上就是这样卡死十几分钟）。
            finishWaitOnce();
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = rawMessage.slice(0, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            const im = st.memberImpressions[oldTarget] || {};
            const newTarget = String(cleanNewExtra.target || oldTarget).trim();
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        // [qq-bridge 本地补丁] 生图工具用的上下文校验端点：
        // 返回「最近一次 @ 机器人」的发送者与正文，并原子地占用一次生图配额。
        // 必须带 agent token（reserved2 会话令牌），否则无法伪造。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/image-request') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const consume = body.consume === true;
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许访问该会话' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          // [qq-bridge 本地补丁] 退还配额：生图改成异步后，"到底画出来没有"只有 worker 知道，
          // 由它回调这里退次数，避免"图没出来还扣了次数"。
          if (body.action === 'refund') {
            const refundId = String(body.senderId ?? '').trim();
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            const todayRefund = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
            if (!st.imageQuota || st.imageQuota.date !== todayRefund) {
              st.imageQuota = { date: todayRefund, counts: {} };
            }
            const before = Number(st.imageQuota.counts?.[refundId] || 0);
            if (before > 0) st.imageQuota.counts[refundId] = before - 1;
            saveSocialV2State();
            sendJson({ ok: true, refunded: before > 0, used: Number(st.imageQuota.counts?.[refundId] || 0) });
            return;
          }
          const freshMs = (Number(cfg.socialV2?.image?.mentionFreshMs) || 180000);
          const dailyLimit = (Number(cfg.socialV2?.image?.dailyLimit) || 5);
          // [qq-bridge 本地补丁] 优先用"唤醒那一刻签发的票据"：被 @ 唤醒的回合开始时重新起算有效期，
          // 之后哪怕桥接排队/看门狗拖了几分钟，这一轮的生图请求依然算数。
          // 没有票据时退回"最近一次 @ + 时间窗"的老逻辑（例如 private 会话）。
          const ticket = (st.imageTicket && Number(st.imageTicket.expiresAt) > Date.now()) ? st.imageTicket : null;
          const ticketOk = ticket ? analyzeImageRequest(ticket.text, prefix).ok : false;
          // 票据只绑定"被 @ 唤醒的那一轮"，如果它对应的那条 @ 不是生图请求（比如中间夹了句无关的 @），
          // 就到最近 @ 列表里挑**最新的、真的像生图请求的那一条**（修 2026-09-28 库库那次误判）。
          const recentMention = pickImageMention(st.recentMentions, {
            now: Date.now(),
            windowMs: Math.max(freshMs, 10 * 60 * 1000),
            prefix
          });
          const m = (ticket && ticketOk ? ticket : null) || recentMention || (!ticket ? st.lastMention : null);
          const inWindow = Boolean(m) && (ticket && m === ticket ? true : Date.now() - Number(m.at || 0) <= Math.max(freshMs, 10 * 60 * 1000));
          const prefix = String(cfg.socialV2?.image?.prefix ?? '生图');
          // @ 提到的人在文本里表现为 "@昵称"，而 @ 必然在「生图」之前，所以不能直接判断
          // "以生图开头"。判断逻辑抽到 src/image-ack.js 的 analyzeImageRequest()，
          // 与"群里看到请求就即时回执"共用同一套规则，避免两处不一致。
          const rawText = String(m?.text ?? '');
          const analyzed = analyzeImageRequest(rawText, prefix);
          const startsWithPrefix = analyzed.ok;
          const text = analyzed.text;
          const senderId = String(m?.senderId ?? '');
          const ownerQQ = String(cfg.ownerQQ ?? '');
          const isOwner = Boolean(ownerQQ && senderId === ownerQQ);

          // 按**本地日期**换日：用 toISOString 会得到 UTC 日期，本地早上 8 点就重置配额，
          // 群友会看到"明明刚过零点却还能用/不能用"的怪现象。
          const today = (() => {
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
          })();
          if (!st.imageQuota || st.imageQuota.date !== today) st.imageQuota = { date: today, counts: {} };
          const used = Number(st.imageQuota.counts?.[senderId] || 0);

          const base = {
            key, senderId, senderName: m?.senderName ?? '', text: text.slice(0, 120),
            isOwner, dailyLimit, used, freshMs,
          };
          let inputImages = [];
          if (!inWindow) {
            log(`[image] 拒绝生图请求（NO_MENTION）：最近 ${Math.round(freshMs / 1000)} 秒内没有可用的「@机器人 + 生图」记录 key=${key}`);
            sendJson({ ...base, ok: false, code: 'NO_MENTION', error: `最近 ${Math.round(freshMs / 1000)} 秒内没有「@机器人」的记录，生图必须由群友 @机器人 触发` }, 403);
            return;
          }
          if (!startsWithPrefix) {
            log(`[image] 拒绝生图请求（NO_PREFIX）：命中的 @ 记录正文不是「${prefix}」开头（text=${String(text).slice(0, 40)}）`);
            sendJson({ ...base, ok: false, code: 'NO_PREFIX', error: `请求必须以「${prefix}」开头（当前：${text.slice(0, 40)}）` }, 403);
            return;
          }
          // 防蹭：@ 的那位必须仍是"最后一个说话的人"。否则别人在这 3 分钟窗口里随便打一句
          // 「生图 xxx」就能用掉上面那位的 @ 记录（配额还会记到那位头上，owner 更是等于无限次）。
          // 票据（本次 @ 召唤出来的那一轮）本身就锚定了发起人，不再需要这个判断——
          // 而且长轮询/生图期间群里有人插话不该让这一轮已经通过的请求失效。
          const stillLatest = ticket ? true : (!st.lastIncomingFrom || String(st.lastIncomingFrom) === senderId);
          if (!stillLatest) { sendJson({ ...base, ok: false, code: 'STALE_MENTION', error: '你 @ 机器人之后群里又有人发言了，这次生图请求已作废；想生图请重新 @机器人 并让消息以「生图」开头' }, 403); return; }
          if (!isOwner && used >= dailyLimit) {
            sendJson({ ...base, ok: false, code: 'QUOTA', error: `今日生图次数已用完（${used}/${dailyLimit}）` }, 429);
            return;
          }
          if (consume) {
            st.imageQuota.counts[senderId] = used + 1;
            // 生图已改为异步：worker 在后台跑，agent 回合立刻结束，不再有"长静默"，
            // 所以这里只标记一下活动时间即可（看门狗本来就以 DSH 的 running 状态为准）。
            markSessionActivity(key);
            // [qq-bridge 本地补丁] 记下"正在后台生图"，让后续唤醒提示能告诉 agent
            // "图还在画、别重复调用、也别说没出图"。
            // 起因：图 1~4 分钟后由 worker 直接发到群里，agent 期间看不到任何证据，
            // 实测它会自己编出"十分钟了图还没出来"这种假消息（图其实早就发出去了）。
            const imageTimeoutSec = Math.min(Math.max(Number(cfg.socialV2?.image?.timeoutSec) || 600, 60), 900);
            st.imageJob = {
              senderId,
              senderName: String(m?.senderName ?? ''),
              startedAt: Date.now(),
              expiresAt: Date.now() + (imageTimeoutSec + 180) * 1000
            };
            // 票据一次性：用过就作废，防止同一轮里被重复消费。
            st.imageTicket = null;
            saveSocialV2State();
            // [qq-bridge 本地补丁] 群里的即时提示："收到，画着呢"。
            // 起因（owner 2026-09-28）：生图是异步的，受理后群里 1~4 分钟没有任何动静，
            // 群友会以为机器人没反应。这里由桥接确定性回一句人设口吻的短话（不经过模型，
            // 所以不受模型回合结束/偷懒影响），worker 出图后照旧自动发图并 @ 请求者。
            void sendImageAck(key, {
              senderId,
              senderName: m?.senderName ?? '',
              isOwner,
              remaining: isOwner ? null : Math.max(0, dailyLimit - used - 1),
              requestId: m?.messageId != null ? String(m.messageId) : null
            }).catch((error) => log(`⚠️ 生图提示异常：${error?.message ?? error}`));
            // [qq-bridge 本地补丁] 带图生图：只在实际生成（consume）时取图，预检不取，避免浪费。
            let collectResult = { items: [], lostSelfImage: false };
            try {
              collectResult = await collectInputImages(key, {
                senderId,
                messageId: m?.messageId != null ? String(m.messageId) : null,
                quoteId: m?.quoteId != null ? String(m.quoteId) : null,
                text: String(text ?? '')
              });
            } catch (error) {
              log(`⚠️ 生图输入图收集失败（按纯文字生图继续）：${error?.message ?? error}`);
            }
            // 群友引用的是"我自己发过的图"，但本地原图已经不在了 → 直接报错让他重发，
            // 不要白烧一次 codex（2026-09-28 事故：codex 收到"改参考图"的提示却没有任何参考图）。
            if (!collectResult.items.length && collectResult.lostSelfImage) {
              // 退回刚扣的配额
              if (consume) {
                const before = Number(st.imageQuota.counts?.[senderId] || 0);
                if (before > 0) st.imageQuota.counts[senderId] = before - 1;
                st.imageJob = null;
                saveSocialV2State();
              }
              sendJson({
                ...base,
                ok: false,
                code: 'REF_IMAGE_LOST',
                error: '你引用的是我自己发过的图，但那张原图我本地已经清掉了（生图目录是按天清理的）。请让群友把原图重新发一遍，再 @我 生图 改。'
              }, 409);
              return;
            }
            inputImages = collectResult.items;
          }
          sendJson({
            ...base,
            ok: true,
            remaining: isOwner ? null : Math.max(0, dailyLimit - used - (consume ? 1 : 0)),
            // 带图生图：本次请求挑选到的输入图（本地临时文件路径），worker 会逐张以 -i 传给 codex
            images: inputImages.map((i) => i.path),
            ...(inputImages.length ? { imageSources: inputImages.map((i) => i.from) } : {})
          });
          return;
        }
        // [qq-bridge 本地补丁] 后台生图完成回调：只用来清掉"正在生图"标记。
        // 刻意不接受任何调用方提供的文本 —— 通知文本本身由 worker 通过
        // /api/socialV2/send-message 发出（那条路径会正常入库），
        // 免得这个接口变成"持有 token 就能伪造我-说过-什么"的后门。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/image-job') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(req.headers['x-agent-token'] ?? '').trim();
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const st = getSocialV2State(key);
          const had = Boolean(st.imageJob);
          const job = st.imageJob ?? {};
          st.imageJob = null;
          // [qq-bridge 本地补丁] 记住"最近一次生图的结果"——这是修一个真实事故：
          // 失败时原来只是把"正在生图"标记清掉，唤醒提示里**什么都不说**，
          // 模型手上没有任何权威状态，于是群友问"耍我是吧"时它自己编了句
          // "没耍你，正在画，等两分钟"（图其实 1 分钟前就失败了）。
          // 现在把失败写进状态，唤醒提示会明确告诉它"已经失败、别再翻案"。
          if (body.ok === true) {
            st.imageFail = null;
            st.imageDone = { at: Date.now(), senderId: String(job.senderId ?? ''), senderName: String(job.senderName ?? '') };
          } else {
            st.imageFail = {
              at: Date.now(),
              senderId: String(job.senderId ?? ''),
              senderName: String(job.senderName ?? ''),
              reason: String(body.reason ?? '').slice(0, 300)
            };
          }
          // worker 上报"我刚把图/失败提示发出去了"：如果是图，记下本地路径，
          // 这样群友之后【引用我发的那张图】来改图时，桥接能直接把本地原图当参考图。
          const sent = body.sentImage && typeof body.sentImage === 'object' ? body.sentImage : null;
          if (sent && sent.path) {
            const localPath = String(sent.path);
            const allowed = [path.join(process.env.TEMP || process.env.TMP || '', 'qq-bridge-images'), path.join(STATE_DIR, 'generated-images')]
              .filter(Boolean);
            const inside = allowed.some((dir) => path.resolve(localPath).startsWith(path.resolve(dir) + path.sep));
            if (inside && fs.existsSync(localPath)) {
              // 复制一份到 state/generated-images，避免 %TEMP% 被清理后引用失效
              let persistent = localPath;
              try {
                const keepDir = path.join(STATE_DIR, 'generated-images');
                fs.mkdirSync(keepDir, { recursive: true });
                persistent = path.join(keepDir, path.basename(localPath));
                if (path.resolve(persistent) !== path.resolve(localPath)) fs.copyFileSync(localPath, persistent);
              } catch (error) {
                log(`⚠️ 生图副本保存失败（继续用临时路径）：${error?.message ?? error}`);
              }
              const media = [{ kind: 'image', file: `local:${persistent}`, localPath: persistent, url: '' }];
              const msgId = sent.messageId != null ? String(sent.messageId) : null;
              if (msgId) {
                let byRef = messageMediaStore.get(key);
                if (!byRef) { byRef = new Map(); messageMediaStore.set(key, byRef); }
                byRef.set(msgId, media);
              }
              recordSelfMessage(key, '[我发的图]', { media, hasMedia: true, imageSent: true, messageId: msgId });
              log(`[image] 已记录自己发的图（可用于后续改图）：${persistent}${msgId ? ` msg_id=${msgId}` : ''}`);
            } else {
              log(`⚠️ 忽略可疑的 sentImage.path（不在允许目录或文件不存在）：${localPath}`);
            }
          }
          saveSocialV2State();
          log(`[reserved2] 后台生图结束回调 ${key}（ok=${body.ok === true}${had ? '' : '，本地无进行中标记'}${body.reason ? '，原因：' + String(body.reason).slice(0, 80) : ''}）`);
          sendJson({ ok: true, key, cleared: had });
          return;
        }
        // [qq-bridge 本地补丁] 好感度（关系）查询/手调。**仅控制台可见**：群友完全看不到，
        // 模型也只在唤醒提示里拿到"当前在场的人"的档位，没有查询工具。
        if (url.pathname === '/api/socialV2/affinity') {
          const c = mergeAffinityConfig(cfg.socialV2?.affinity);
          if (req.method === 'GET') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            const st = getSocialV2State(key);
            const members = st.affinity?.members ?? {};
            const now = Date.now();
            const rows = summarizeAffinity(members, c).map((r) => {
              const m = Object.values(members).find((x) => (x.name || x.userId) === r.name) || {};
              return {
                ...r,
                userId: m.userId ?? '',
                tone: tierOf(r.score, c).toneLevel,
                todayDelta: Number(m.dailyDelta) || 0,
                lastInteractAt: Number(m.lastInteractAt) || 0,
                idleHours: m.lastInteractAt ? Math.round((now - Number(m.lastInteractAt)) / 3600000) : null,
                nickname: m.nickname || '',
                recent: Array.isArray(m.events) ? m.events.slice(-3) : []
              };
            });
            sendJson({ ok: true, key, config: { start: c.start, min: c.min, max: c.max, dailyUp: c.dailyUp, dailyDown: c.dailyDown, decayAfterDays: c.decayAfterDays, decayTo: c.decayTo }, members: rows });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            const st = getSocialV2State(key);
            if (!st.affinity || typeof st.affinity !== 'object') st.affinity = { members: {}, updatedAt: 0 };
            if (!st.affinity.members) st.affinity.members = {};
            const userId = String(body.userId ?? '').trim();
            if (body.action === 'reset-all') {
              // 全部重置回起始分（同时清空今日额度与计数器，否则当天还是涨不动）
              const n = resetAllMembers(st.affinity.members, c);
              st.affinity.updatedAt = Date.now();
              saveSocialV2State();
              log(`控制台：好感度全部重置回 ${c.start}（${n} 人，今日额度与计数器已清空）`);
              sendJson({ ok: true, key, reset: n, score: c.start });
              return;
            }
            if (!userId) { sendJson({ ok: false, error: 'userId 不能为空' }, 400); return; }
            if (body.action === 'remove') {
              delete st.affinity.members[userId];
              saveSocialV2State();
              sendJson({ ok: true, key, removed: userId });
              return;
            }
            const member = ensureMember(st.affinity.members, userId, String(body.name ?? ''), c);
            if (typeof body.score === 'number' && Number.isFinite(body.score)) {
              member.score = Math.max(c.min, Math.min(c.max, Math.round(body.score)));
            }
            if (typeof body.delta === 'number' && Number.isFinite(body.delta)) {
              member.score = Math.max(c.min, Math.min(c.max, member.score + Math.round(body.delta)));
            }
            if (typeof body.nickname === 'string') member.nickname = body.nickname.slice(0, 20);
            member.lastScoreAt = Date.now();
            if (!Array.isArray(member.events)) member.events = [];
            member.events.push({ at: Date.now(), kind: 'manual', delta: 0, reasons: `控制台手调（${body.score ?? body.delta ?? 'set'}）` });
            st.affinity.updatedAt = Date.now();
            saveSocialV2State();
            log(`控制台：好感度手调 ${member.name || userId} → ${member.score}（${tierOf(member.score, c).label}）`);
            sendJson({ ok: true, key, userId, score: member.score, tier: tierOf(member.score, c).label });
            return;
          }
        }
        // [qq-bridge 本地补丁] 投喂账本查询/维护（控制台用；金额只在这里可见，绝不进群）
        if (url.pathname === '/api/socialV2/feed') {
          if (req.method === 'GET') {
            const csv = String(url.searchParams.get('csv') ?? '') === '1';
            if (csv) {
              res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="feed.csv"' });
              res.end('\uFEFF' + ledgerCsv(feedLedger));
              return;
            }
            const sum = summarizeFeed(feedLedger);
            sendJson({
              ok: true,
              enabled: mergeFeedConfig(cfg.socialV2?.feed).enabled,
              config: (() => { const f = mergeFeedConfig(cfg.socialV2?.feed); return { dailyAffinity: f.dailyAffinity, maxAttemptsPerHour: f.maxAttemptsPerHour, threshold: f.hungry.threshold, afdianConfigured: Boolean(f.afdian.userId && f.afdian.token) }; })(),
              totals: sum.totals,
              members: sum.members.map((m) => ({ ...m, lastAtText: m.lastAt ? new Date(m.lastAt).toLocaleString('sv') : '' })),
              orders: sum.orders.slice(0, 50).map((o) => ({ ...o, orderNo: maskOrderNo(o.orderNo), atText: new Date(o.at).toLocaleString('sv') })),
              alerts: feedLedger.alerts
            });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const fc = mergeFeedConfig(cfg.socialV2?.feed);
            // 自检用：验证"私聊 owner"这条链路（投喂通知/余额提醒都靠它）
            if (body.action === 'test-notify') {
              try {
                await notifyOwner('投喂通知自检', `这是一条测试消息。\n投喂通道：${fc.enabled ? '已启用' : '未启用'}\n累计：${(summarizeFeed(feedLedger)).totals.count} 笔\n如果你看到这条，说明投喂/余额通知能正常送达。`);
                sendJson({ ok: true, sent: true, to: String(cfg.ownerQQ ?? '') });
              } catch (error) {
                sendJson({ ok: false, error: `私聊发送失败：${error?.message ?? error}` }, 500);
              }
              return;
            }
            if (body.action === 'remove') {
              const r = removeOrder(feedLedger, String(body.orderNo ?? ''));
              if (!r.ok) { sendJson({ ok: false, error: '没找到这个订单号' }, 404); return; }
              feedLedger = saveLedger(feedLedger);
              sendJson({ ok: true, removed: maskOrderNo(String(body.orderNo)) });
              return;
            }
            // 手工补录（例如群友直接转了微信、或者你替朋友补一笔）
            const orderNo = String(body.orderNo ?? '').trim() || `manual${Date.now()}`;
            const rec = recordOrder(feedLedger, {
              orderNo, userId: String(body.userId ?? ''), name: String(body.name ?? ''),
              amount: Number(body.amount) || 0, status: null, verified: false, rawSummary: 'manual'
            }, fc);
            if (!rec.ok) { sendJson({ ok: false, error: rec.reason }, 400); return; }
            feedLedger = saveLedger(feedLedger);
            if (rec.affinity > 0 && body.userId) {
              try {
                const st = getSocialV2State(String(body.key ?? `group:${cfg.allow?.groups?.[0] ?? ''}`));
                const ac = mergeAffinityConfig(cfg.socialV2?.affinity);
                const member = ensureMember(st.affinity.members, String(body.userId), String(body.name ?? ''), ac);
                if (member) { recordEvent(member, { kind: 'feed', affinity: rec.affinity }, ac); saveSocialV2State(); }
              } catch { /* 加分失败不影响记账 */ }
            }
            sendJson({ ok: true, orderNo: maskOrderNo(orderNo), amount: rec.order.amount, affinity: rec.affinity, dailyFirst: rec.dailyFirst });
            return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (currentMode === 'reserved2' && !agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        // [qq-bridge 本地补丁] 重建会话：把某个会话的 DSH 会话退役，下次唤醒按**当前 preset** 新建。
        // 为什么需要它：preset 里的东西（人设文案、qq-tool-restrict 的工具白名单）是在
        // **会话创建时**装进该 agent scope 的，改完文件对已存在的会话不生效——
        // 实测把 qq_wait_for_messages 拆到独立 MCP 服务后，老会话的白名单只认旧前缀，
        // 等待工具被拒 → 收尾链断掉。
        // 与 /api/session/reset 的区别：reset 会连 socialV2 的记忆/配额/唤醒配置一起删，
        // 这里走 retireSession，只换 DSH 会话、保留全部记忆与配置（令牌会轮换）。
        if (req.method === 'POST' && url.pathname === '/api/session/rebuild') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          const old = state.sessions[key];
          retireSession(key);
          log(`控制台：已重建会话 ${key}（退役 ${old}）；下次唤醒会用当前 preset 新建，记忆与配额保留`);
          if (body.wake !== false) {
            try { scheduleWakeV2(key, 'bootstrap'); } catch (error) { log(`⚠️ 重建后唤醒失败：${error?.message ?? error}`); }
          }
          sendJson({ ok: true, key, retired: old, wakeScheduled: body.wake !== false });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          const removedV2 = socialV2.conversations.get(key);
          if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await api.stopSessionWork(oldSessionId); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await api.sessions.list({}), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await api.stopSessionWork(item.sessionId); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          for (const st of socialV2.conversations.values()) {
            if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
          }
          socialV2.conversations.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  /**
   * 把"我（桥接代机器人）说过的话"记进会话消息流，让唤醒提示/上下文能看到，
   * 避免模型不知道这句已经说过而重复宣布（例如禁言播报、生图开始提示）。
   */
  function recordSelfMessage(key, text, extra = {}) {
    try {
      const st = getSocialV2State(key);
      const body = String(text ?? '').slice(0, 200);
      st.recentMessages.push({
        messageId: null,
        sender: '我',
        userId: null,
        text: body,
        plain: body,
        quoteTargetIsSelf: false,
        atSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        ...extra,
        time: Date.now()
      });
      const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
      if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
      saveSocialV2State();
    } catch (error) {
      log(`⚠️ 记录自己发的消息失败：${error?.message ?? error}`);
    }
  }

  /**
   * 生图受理后的即时提示：群里先回一句"画着呢"，免得群友以为没反应（等 1~4 分钟很容易以为失败了）。
   * 文案从 persona-lines.js 的模板池随机抽，保持人设口吻；可用 ackEnabled=false 关闭。
   * @param {{early?:boolean}} options early=true 表示这是"看到请求就先回执"（不等模型回合）
   */
  async function sendImageAck(key, { senderId, senderName, isOwner, remaining, early = false, requestId = null }) {
    const ic = cfg.socialV2?.image ?? {};
    const st = getSocialV2State(key);
    // 已经回过执就别再说第二遍 —— 但**只对同一条请求**去重（按消息 id）。
    // 过去按"同一人 3 分钟内"去重，导致同一个人隔两分钟重新发一次时（上一次被拒/失败），
    // 第二次群里一句提示都没有（2026-09-28 实测）。现在换请求就照常回执。
    const lastAck = st.imageAck;
    if (lastAck) {
      const sameRequest = Boolean(requestId && lastAck.requestId && String(lastAck.requestId) === String(requestId));
      const sameSenderFresh = String(lastAck.senderId ?? '') === String(senderId ?? '')
        && Date.now() - Number(lastAck.at || 0) < 20000;
      if (sameRequest || (!requestId && sameSenderFresh)) {
        log(`[image] 跳过重复回执（${early ? '即时回执' : '受理回执'}）${key}/${senderId}：` +
          (sameRequest ? `同一条请求（id=${requestId}）` : '20 秒内同一个人') + `已回过「${lastAck.text}」`);
        return '';
      }
    }
    const line = pickImageAckLine(ic, { name: senderName || `QQ ${senderId}`, isOwner, remaining });
    if (!line) return '';
    try {
      await sendToQQ(key, line);
      recordSelfMessage(key, line, { imageAck: true });
      st.imageAck = { at: Date.now(), text: line, senderId: String(senderId ?? ''), requestId: requestId ? String(requestId) : null, early: early === true };
      saveSocialV2State();
      appendActivity(`${key} [image] 已回执${early ? '（即时）' : ''}开始生图：${line}`);
      log(`[image] 已提示开始生图${early ? '（即时）' : ''} ${key}（请求 ${requestId ?? '未知'}）：${line}`);
    } catch (error) {
      log(`⚠️ 生图开始提示发送失败：${error?.message ?? error}`);
    }
    return line;
  }

  /**
   * 群里刚看到"@我 + 生图…"时立刻回一句（不等模型回合）。
   *
   * 起因：回执原来挂在"受理接口"上，也就是等 agent 调 qq_generate_image 才回一句。
   * 但 agent 回合可能因为会话繁忙排很久，群里这段时间还是没反应 —— owner 反馈的
   * "看着没反应"就包括这种情况。现在改成：消息一到，桥接自己先判断（同一套
   * analyzeImageRequest 规则）并回一句；受理时若 3 分钟内已回过就不再重复。
   * 配额用完 / 不是 @ 我 / 不是「生图」开头 / 本人刚回过 → 都不回（免得先许诺后落空）。
   */
  async function maybeSendEarlyImageAck(key, { atSelf, quoteTargetIsSelf, text, senderId, senderName, requestId = null }) {
    const ic = cfg.socialV2?.image ?? {};
    if (ic.ackEnabled === false) return '';
    const st = getSocialV2State(key);
    const ownerQQ = String(cfg.ownerQQ ?? '');
    const isOwner = Boolean(ownerQQ && String(senderId) === ownerQQ);
    const dailyLimit = Number(ic.dailyLimit) || 5;
    const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
    const quota = (st.imageQuota && st.imageQuota.date === today) ? st.imageQuota : { date: today, counts: {} };
    const used = Number(quota.counts?.[String(senderId)] || 0);
    const gate = shouldSendEarlyAck({
      now: Date.now(),
      ackEnabled: ic.ackEnabled !== false,
      atSelf,
      quoteTargetIsSelf,
      text,
      prefix: String(ic.prefix ?? '生图'),
      isOwner,
      used,
      dailyLimit,
      imageJob: st.imageJob,
      lastAck: st.imageAck,
      senderId,
      requestId
    });
    if (!gate.ok) return '';
    return sendImageAck(key, {
      senderId,
      senderName,
      isOwner,
      remaining: isOwner ? null : Math.max(0, dailyLimit - used),
      early: true,
      requestId
    });
  }

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error))
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error));
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // [qq-bridge 本地补丁] 支持独立的 HTTP token（snowluma.httpToken）：
        // SnowLuma 的 HTTP 与 WS 可以设成不同的 accessToken，而 WS 只用于接收事件。
        ...(cfg.snowluma?.httpToken || cfg.snowluma?.accessToken
          ? { authorization: `Bearer ${cfg.snowluma.httpToken || cfg.snowluma.accessToken}` }
          : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // 单条消息图片总字节上限（与 safeFetchBuffer 默认一致）
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-image-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  /** 本地图片引用：'local:<路径>' 或 media.localPath —— 机器人自己发出去的图（worker 上报）走这条路。 */
  function localPathOfMedia(media) {
    const m = media && typeof media === 'object' ? media : {};
    const f = String(m.file ?? '');
    if (f.startsWith('local:')) return f.slice('local:'.length).trim();
    const lp = String(m.localPath ?? '').trim();
    return lp;
  }

  /** 请求文本看起来像"改上一张图"（用于决定要不要把机器人自己刚发的图当参考图）。 */
  function looksLikeEditRequest(text) {
    return /(改|换|修|再.{0,3}(点|些|大|小|长|短)|大一点|小一点|这张|那张|刚才|上一张|同一张|继续|加个|去掉|删掉|p掉|参考)/.test(String(text ?? ''));
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st && Array.isArray(st.recentMessages)) {
          const found = st.recentMessages.find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
          if (found && Array.isArray(found.media)) return found.media;
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  /**
   * [qq-bridge 本地补丁] 带图生图：收集本次请求的"输入图"并落成临时文件，
   * 交给 worker → codex-image.ps1 → `codex exec -i <file>`（实测可做真·多图参考/改图）。
   *
   * 候选来源按优先级：① 本条 @ 消息自带的图；② 它引用的那条消息里的图（**包括机器人自己发过的图**）；
   * ③ 近 pickupWindowMs 内、同一发送者发的图；④ 同窗口内其他人发的图。
   * 表情包（face）不参与；最多 maxInputImages 张、总字节不超过 maxInputImageBytes。
   * 整个收集过程有硬预算（默认 12 秒），超时就用手上的，避免把生图请求拖超时。
   *
   * @returns {Promise<{items: object[], lostSelfImage: boolean}>}
   *   lostSelfImage=true 表示"群友引用的是我自己发过的图，但本地原图已经不在了"
   *   —— 调用方应该直接报错让群友重发，而不是白烧一次 codex（2026-09-28 实测事故）。
   */
  async function collectInputImages(key, opts = {}) {
    const maxImages = Math.min(3, Math.max(0, Number(cfg.socialV2?.image?.maxInputImages ?? 3)));
    if (!maxImages) return [];
    const windowMs = Math.max(0, Number(cfg.socialV2?.image?.pickupWindowMs ?? 120000));
    const maxBytes = Math.max(256 * 1024, Number(cfg.socialV2?.image?.maxInputImageBytes ?? 6 * 1024 * 1024));
    const budgetMs = Math.max(2000, Number(cfg.socialV2?.image?.inputFetchBudgetMs ?? 12000));
    const deadline = Date.now() + budgetMs;
    const senderId = String(opts.senderId ?? '');
    const st = getSocialV2State(key);

    const picked = [];
    const seen = new Set();
    const pushMedia = (mediaList, from) => {
      for (const media of Array.isArray(mediaList) ? mediaList : []) {
        if (!media || media.kind === 'face') continue;
        const sig = String(media.file || media.url || '');
        if (!sig || seen.has(sig)) continue;
        seen.add(sig);
        picked.push({ media, from });
      }
    };

    if (opts.messageId) pushMedia(findMessageMedia(key, opts.messageId), '本条消息');
    if (opts.quoteId) pushMedia(findMessageMedia(key, opts.quoteId), '被引用的消息');
    if (windowMs > 0 && Array.isArray(st.recentMessages)) {
      const now = Date.now();
      const recent = st.recentMessages.filter((m) => m && m.hasMedia && Array.isArray(m.media)
        && m.media.some((x) => x && x.kind !== 'face') && now - Number(m.time || 0) <= windowMs);
      const mine = recent.filter((m) => !m.isSelf && senderId && String(m.userId || '') === senderId).reverse();
      const others = recent.filter((m) => !m.isSelf && (!senderId || String(m.userId || '') !== senderId)).reverse();
      for (const m of mine) pushMedia(m.media, '他刚才发的图');
      for (const m of others) pushMedia(m.media, '群里刚才的图');
      // 机器人自己刚发出去的图：只在"看起来是改图请求"或"引用了我的消息"时才当参考图，
      // 否则纯文字生图会被上一张输出污染（比如"生图 一只猫"不该接着改上一张图）。
      const selfImages = recent.filter((m) => m.isSelf).reverse();
      if (selfImages.length && (opts.quoteId || looksLikeEditRequest(opts.text))) {
        for (const m of selfImages) pushMedia(m.media, '我上一条发的图');
      }
    }
    if (!picked.length) return { items: [], lostSelfImage: false };

    const dir = path.join(process.env.TEMP || process.env.TMP || path.join(STATE_DIR, 'media'), 'qq-bridge-inputs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return { items: [], lostSelfImage: false }; }
    const out = [];
    let total = 0;
    let lostSelfImage = false;
    for (const item of picked) {
      if (out.length >= maxImages) break;
      if (Date.now() > deadline) { log(`[reserved2] 生图输入图收集超预算（已取 ${out.length} 张），不再等待`); break; }
      // 机器人自己发过的图：本地路径直接读（不经过 OneBot，避免拿到过期签名 URL）
      const localPath = localPathOfMedia(item.media);
      if (localPath) {
        try {
          if (!fs.existsSync(localPath)) { lostSelfImage = true; log(`[reserved2] 输入图本地文件已不在：${localPath}`); continue; }
          const buf = fs.readFileSync(localPath);
          if (!buf.length) { lostSelfImage = true; continue; }
          if (total + buf.length > maxBytes) { log('[reserved2] 生图输入图超出总字节上限，跳过后续'); break; }
          if (typeof looksLikeImageBuffer === 'function' && !looksLikeImageBuffer(buf)) { log(`[reserved2] 本地输入图不是图片，跳过：${localPath}`); continue; }
          total += buf.length;
          const ext = (path.extname(localPath).replace('.', '') || 'png').toLowerCase();
          out.push({ path: localPath, bytes: buf.length, mimeType: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`, from: item.from });
        } catch (error) {
          lostSelfImage = true;
          log(`⚠️ 本地输入图读取失败：${error?.message ?? error}`);
        }
        continue;
      }
      try {
        const img = await fetchOneBotImage(item.media);
        if (!img?.buffer?.length) continue;
        if (total + img.buffer.length > maxBytes) { log(`[reserved2] 生图输入图超出总字节上限，跳过后续`); break; }
        total += img.buffer.length;
        const sub = String(img.mimeType || 'image/png').split('/')[1] || 'png';
        const ext = sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/gi, '') || 'png';
        const file = path.join(dir, `in-${Date.now().toString(36)}-${out.length}.${ext}`);
        fs.writeFileSync(file, img.buffer);
        out.push({ path: file, bytes: img.buffer.length, mimeType: img.mimeType || 'image/png', from: item.from });
      } catch (error) {
        log(`⚠️ 生图输入图获取失败：${error?.message ?? error}`);
      }
    }
    if (out.length) {
      log(`[reserved2] 生图输入图 ${out.length} 张（${out.map((o) => o.from).join('/')}，共 ${Math.round(total / 1024)}KB）`);
    }
    return { items: out, lostSelfImage };
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）+ max 思考强度；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Set();
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.has(sessionId)) return;
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || 'max');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.add(sessionId);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return;
      } catch (error) {
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        await ensureChatModel(existing);
        if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
        return existing;
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // [qq-bridge 本地补丁] 群友好感度（关系）状态。
        // 对群友完全隐藏，只通过"称呼 + 语气"体现；算法在 src/affinity.js（纯函数、可单测）。
        affinity: { members: {}, updatedAt: 0 },
        // [qq-bridge 本地补丁] 最近一次被 @ 的上下文（供 qq_generate_image 校验"必须被 @ 且以生图开头"）
        lastMention: null,
        // [qq-bridge 本地补丁] 被 @ 唤醒的那一轮签发的生图票据（含 expiresAt，回合结束即作废）
        imageTicket: null,
        // [qq-bridge 本地补丁] 长任务租约截止时刻：生图期间看门狗不得判死本回合
        longTaskUntil: 0,
        lastIncomingFrom: null,
        // [qq-bridge 本地补丁] 生图配额：{ "YYYY-MM-DD": { "<QQ号>": 次数 } }
        imageQuota: null
      };
      KNOWN_AGENT_TOKENS.add(st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            lastIncomingFrom: val.lastIncomingFrom != null ? String(val.lastIncomingFrom) : null,
            imageQuota: (val.imageQuota && typeof val.imageQuota === 'object' && typeof val.imageQuota.date === 'string')
              ? { date: val.imageQuota.date, counts: (val.imageQuota.counts && typeof val.imageQuota.counts === 'object') ? { ...val.imageQuota.counts } : {} }
              : null,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            affinity: sanitizeAffinityState(val.affinity, cfg.socialV2?.affinity)
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          KNOWN_AGENT_TOKENS.add(st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        saveSocialV2State();
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          lastIncomingFrom: st.lastIncomingFrom != null ? String(st.lastIncomingFrom) : null,
          imageQuota: st.imageQuota || null,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          affinity: st.affinity && typeof st.affinity === 'object' ? st.affinity : { members: {}, updatedAt: 0 },
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = redactKnownTokensOnly(String(extra.pendingQuestion)).slice(0, 200);
      } else {
        st.activeTopics.push({
          text: text.slice(0, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: String(textContent).slice(0, 200),
      plain: String(plainText ?? textContent).slice(0, 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: String(textContent).slice(0, 200), plain: String(plainText ?? textContent).slice(0, 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  if (isSocialEnabled() || cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', hint: '' };
  function currentRoleHint() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      const roleFile = path.join(ROOT, 'roles', rs.role + '.md');
      if (!fs.existsSync(roleFile)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      const cacheKey = `${stateStat.mtimeMs}:${roleStat.mtimeMs}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.hint;
      let hint = fs.readFileSync(roleFile, 'utf8');
      if (hint.length > 6000) hint = hint.slice(0, 6000);
      roleHintCache = { key: cacheKey, hint };
      return hint;
    } catch {
      return '';
    }
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    const raw = currentRoleHint();
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议
    const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], atSelf = false) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: String(textContent).slice(0, 200),
      plain: String(plainContent ?? textContent).slice(0, 200),
      tail: String(plainContent ?? textContent).slice(-200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      atSelf: !!atSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    // [qq-bridge 本地补丁] 记录"最后一条人类消息是谁发的"，用于生图校验：
    // 只有「@ 机器人」的那位仍然是最后一个说话的人，这次生图请求才算他的，防止别人
    // 在 3 分钟窗口内蹭一次旧的 @ 记录（蹭的话配额会记到上一个人头上）。
    st.lastIncomingFrom = userId != null ? String(userId) : null;
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  function appendToolLog(entry) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      fs.appendFileSync(TOOL_LOG_FILE, JSON.stringify(safeEntry) + '\n', 'utf8');
      // 防止工具调用日志无限增长：保留最近 2000 行。
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n');
      if (lines.length > 2000) {
        fs.writeFileSync(TOOL_LOG_FILE, lines.slice(-2000).join('\n') + '\n', 'utf8');
      }
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = text.slice(0, 2000) + '…(truncated)';
    return text;
  }

  /**
   * [qq-bridge 本地补丁] 好感度记账：把一条群消息翻译成 affinity.js 需要的事件字段。
   * 只做确定性判断（谁说了什么、有没有 @ 我、有没有发图、是不是刷屏/复读、有没有踩雷），
   * 不做任何语义理解——语义那部分留给后续阶段的"有上限的模型微调"。
   */
  function scoreAffinityEvent(key, st, info) {
    const c = mergeAffinityConfig(cfg.socialV2?.affinity);
    if (!c.enabled) return;
    if (info.kind !== 'group') return; // 阶段 1 只统计群聊
    const userId = String(info?.senderId ?? '').trim();
    if (!userId || userId === '0') return;
    if (!st.affinity || typeof st.affinity !== 'object') st.affinity = { members: {}, updatedAt: 0 };
    if (!st.affinity.members || typeof st.affinity.members !== 'object') st.affinity.members = {};
    const member = ensureMember(st.affinity.members, userId, info.senderName, c);
    if (!member) return;

    // 长期不互动的懒衰减（只掉到 decayTo，不互动 ≠ 讨厌）
    try { applyDecay(member, c, Date.now()); } catch { /* 衰减失败不影响记账 */ }

    const text = String(info.text ?? '').slice(0, 200);
    const now = Date.now();
    // 刷屏/复读判定：看该发送者窗口内的消息
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && !m.isSelf && String(m.userId || '') === userId && now - Number(m.time || 0) <= c.spamWindowMs);
    const texts = recent.map((m) => String(m.plain ?? m.text ?? ''));
    const sameAsPrev = texts.filter((t) => t && t === text).length;
    const avgChars = texts.length ? texts.reduce((sum, t) => sum + t.length, 0) / texts.length : text.length;

    const result = recordEvent(member, {
      kind: 'message',
      name: info.senderName,
      text,
      attention: Boolean(info.attention),
      mediaCount: Number(info.mediaCount) || 0,
      spamCount: texts.length,
      repeatCount: sameAsPrev,
      avgChars
    }, c, now);

    if (result?.delta) {
      log(`[affinity] ${member.name || userId} ${result.delta > 0 ? '+' : ''}${result.delta} → ${member.score}（${result.reasons.join(';')}）`);
    }
    st.affinity.updatedAt = now;
  }

  // ── 投喂（赞助）：确定性处理，不走模型 ────────────────────────────────────
  // 为什么不让模型处理：涉及钱，必须可核验、可去重、可限流，不能让模型自由发挥或幻觉。
  // 事实前提：DeepSeek 没有充值 API，钱只能由 owner 手动充；这里做的是"收款→核验→记账→发权益"。
  let feedLedger = loadLedger();
  const feedGuideAt = new Map(); // QQ号 -> 上次索要投喂入口的时间（防刷屏）

  /** 处理一条"投喂"请求；返回 true 表示已接管（调用方不要再走模型唤醒） */
  function handleFeedRequest(key, st, info) {
    const fc = mergeFeedConfig(cfg.socialV2?.feed);
    if (!fc.enabled) return false;
    if (info.kind !== 'group') return false;
    const text = String(info.text ?? '');
    if (!shouldHandleFeed(text, Boolean(info.addressedToBot))) return false;
    // 已接管：后续核验是网络操作，异步跑，不阻塞消息处理
    void (async () => {
      const senderId = String(info.senderId ?? '');
      const senderName = String(info.senderName ?? '') || senderId;
      const orderNo = extractOrderNo(text);
      const reply = async (msg, at = true) => {
        try {
          if (at) await sendMessagesV2(key, [msg], [], null, senderId);
          else await sendMessagesV2(key, [msg], []);
          recordSentMessagesV2(key, [msg]);
        } catch (error) {
          log(`⚠️ 投喂回执发送失败：${error?.message ?? error}`);
        }
      };

      if (!orderNo) {
        // 没给订单号 = 他想要付款入口。**机器人不发任何链接**（风控考虑，入口由 owner 人工给），
        // 只提示去找群主；同一人 60 秒内只发一次，防刷屏。
        const last = feedGuideAt.get(senderId) ?? 0;
        if (Date.now() - last < 60000) {
          log(`[feed] ${senderName} 60 秒内重复索要投喂入口，已跳过`);
          return;
        }
        feedGuideAt.set(senderId, Date.now());
        await reply(buildFeedHint());
        log(`[feed] 已回复 ${senderName} 投喂提示（不含链接，入口由 owner 人工给）`);
        return;
      }
      if (!fc.afdian.userId || !fc.afdian.token) {
        log('[feed] 收到投喂但未配置爱发电凭据，已提示管理员');
        await reply('投喂通道还没配好，我先记下，等群主配置好再说～');
        await notifyOwner('有人想投喂但爱发电还没配置', `来自 ${senderName}(${senderId})\n订单号 ${maskOrderNo(orderNo)}\n请配置 config.json → socialV2.feed.afdian.userId/token`);
        return;
      }
      if (!attemptsAllowed(feedLedger, senderId, fc)) {
        await reply('发得有点频繁，等会儿再试～');
        return;
      }
      noteAttempt(feedLedger, senderId);
      feedLedger = saveLedger(feedLedger);

      if (feedLedger.orders[orderNo]) {
        await reply('这个单号我记过啦，不用重复发～');
        return;
      }
      const v = await verifyAfdianOrder({ userId: fc.afdian.userId, token: fc.afdian.token, orderNo, apiBases: fc.afdian.apiBases });
      if (!v.ok) {
        log(`[feed] 核验失败 ${maskOrderNo(orderNo)}：${v.error}`);
        await reply('核验服务暂时抽风了，稍后再发一次？');
        return;
      }
      if (!v.exists) {
        log(`[feed] 订单不存在 ${maskOrderNo(orderNo)}（${senderName}）`);
        await reply('这个订单号我这边查不到，确认一下有没有复制少？');
        return;
      }
      const rec = recordOrder(feedLedger, {
        orderNo, userId: senderId, name: senderName, amount: v.amount, status: v.status, rawSummary: v.rawSummary
      }, fc);
      feedLedger = saveLedger(feedLedger);
      if (!rec.ok) {
        await reply('这个单号我记过啦，不用重复发～');
        return;
      }
      // 发放权益：每人每天第一笔 +N 好感度（**绕过好感度每日封顶**，见 affinity.js）
      if (rec.affinity > 0 && st?.affinity) {
        try {
          const ac = mergeAffinityConfig(cfg.socialV2?.affinity);
          const member = ensureMember(st.affinity.members, senderId, senderName, ac);
          if (member) {
            const rr = recordEvent(member, { kind: 'feed', affinity: rec.affinity, name: senderName }, ac, Date.now());
            saveSocialV2State();
            log(`[feed] ${senderName} 投喂入账，好感度 +${rec.affinity} → ${member.score}（${rr.reasons.join(';')}）`);
          }
        } catch (error) {
          log(`⚠️ 投喂加分失败：${error?.message ?? error}`);
        }
      }
      log(`[feed] 入账 ${maskOrderNo(orderNo)} 金额=${rec.order.amount} 来自=${senderName}(${senderId}) 今日第${feedLedger.daily[feedTodayKey()]?.[senderId]?.count ?? 1}笔`);
      appendActivity(`${key} [feed] 投喂入账：${senderName}（订单 ${maskOrderNo(orderNo)}）`);
      await reply(rec.dailyFirst ? '收到！谢谢老板投喂 🐳' : '又收到一份，谢老板！');
      if (fc.notifyOwnerOnFeed) {
        const sum = summarizeFeed(feedLedger);
        await notifyOwner('收到一笔投喂', `来自 ${senderName}(${senderId})\n金额 ¥${rec.order.amount}\n订单 ${maskOrderNo(orderNo)}\n累计：${sum.totals.count} 笔 / ¥${sum.totals.amount}\n（记得去 DeepSeek 控制台手动充值）`);
      }
    })().catch((error) => log(`⚠️ 投喂处理异常：${error?.message ?? error}`));
    return true;
  }

  /**
   * 私聊 owner 的**底层通道**：直接走 OneBot `send_private_msg`，绕过会话白名单/模式限制。
   *
   * 为什么需要它：`sendToQQ` 会做 `captureSendGuard`（会话、模式、白名单）校验，而
   * reserved2 模式下 `allow.private` 默认是空的，于是 `notifyOwner()` 的私聊**全部被拒**
   * （2026-09-28 实测：`发送已取消：会话、模式或白名单已变化`）——投喂通知、余额水位、
   * 群管理通知都发不出去。这里的目标**写死 ownerQQ**，不接受任何外部/模型输入，
   * 只用于"桥接 → 群主"的单向通知，所以不需要走白名单。
   */
  async function sendOwnerDM(text) {
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (!/^\d+$/.test(owner)) return false;
    const content = String(text ?? '').trim();
    if (!content) return false;
    try {
      const res = await bot.request('send_private_msg', {
        user_id: Number(owner),
        message: [{ type: 'text', data: { text: content.slice(0, 1500) } }]
      });
      if (!res || res.status !== 'ok' || res.retcode !== 0) {
        throw new Error(res?.wording || res?.retcode || 'unknown');
      }
      return true;
    } catch (error) {
      log(`⚠️ 私聊 owner 失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 私聊 owner（投喂通知 / 余额水位 / 群管理通知）。只发给 ownerQQ，不经过白名单。 */
  async function notifyOwner(title, body) {
    const owner = String(cfg.ownerQQ ?? '').trim();
    if (!owner) return;
    await sendOwnerDM(`【${title}】\n${body}`);
  }

  /**
   * 余额水位检查：余额低于阈值就私聊提醒 owner 去充值（**只在私聊，不在群里说钱**）。
   * 复用 feed.js 的 DeepSeek 余额查询（和 qq_get_balance 同一个官方接口）。
   */
  async function checkBalanceWaterLevel(reason = 'timer') {
    const fc = mergeFeedConfig(cfg.socialV2?.feed);
    if (!fc.hungry.enabled) return;
    const balance = await fetchDeepseekBalance();
    if (!balance.ok) {
      log(`[feed] 余额查询失败（${reason}）：${balance.error}`);
      return;
    }
    if (!shouldAlertHungry(feedLedger, balance, fc)) {
      log(`[feed] 余额 ¥${balance.totalBalance}（阈值 ¥${fc.hungry.threshold}），暂不提醒`);
      return;
    }
    feedLedger.alerts = { ...(feedLedger.alerts || {}), hungryAt: Date.now() };
    feedLedger = saveLedger(feedLedger);
    log(`[feed] 余额水位偏低 ¥${balance.totalBalance}，已私聊提醒 owner`);
    await notifyOwner('鲸鱼快没电了', `DeepSeek 余额 ¥${balance.totalBalance}，低于阈值 ¥${fc.hungry.threshold}。\n有空去 platform.deepseek.com/top_up 充一下（充值只能人工操作，没有 API）。`);
  }

  /** 干跑到期的定时检查：每 10 分钟一次，保证没人说话时也能按时自动生效 + 通知 owner。 */
  function startAdminTimers() {
    if (!adminEnabled()) return;
    const c = adminCfg();
    if (c.dryRun && c.dryRunUntil > 0) {
      log(`[admin] 干跑模式：到 ${new Date(c.dryRunUntil).toLocaleString('zh-CN')} 自动转为生效`);
    }
    const timer = setInterval(() => { try { checkDryRunExpiry(); } catch (error) { log(`[admin] 干跑到期检查异常：${error?.message ?? error}`); } }, 600000);
    timer.unref?.();
    try { checkDryRunExpiry(); } catch { /* 忽略 */ }
  }

  function startFeedTimers() {
    const fc = mergeFeedConfig(cfg.socialV2?.feed);
    if (!fc.hungry.enabled) return;
    const every = Math.max(600000, Number(fc.hungry.checkMs) || DEFAULT_FEED.hungry.checkMs);
    const timer = setInterval(() => { void checkBalanceWaterLevel('timer').catch(() => {}); }, every);
    timer.unref?.();
    // 启动 90 秒后先查一次（避免和启动流程抢网络）
    const first = setTimeout(() => { void checkBalanceWaterLevel('startup').catch(() => {}); }, 90000);
    first.unref?.();
    log(`[feed] 余额水位检查已启用：每 ${Math.round(every / 60000)} 分钟一次，阈值 ¥${fc.hungry.threshold}`);
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      const lower = String(textContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    // [qq-bridge 本地补丁] 好感度（关系）面板：只注入**当前在场**的人（近 15 分钟说过话的），
    // 一是省 token，二是避免把整张表带进上下文。对群友完全隐藏，只体现在称呼与语气上。
    const affinityLine = (() => {
      const ac = mergeAffinityConfig(cfg.socialV2?.affinity);
      if (!ac.enabled) return '';
      const members = st.affinity?.members;
      if (!members || typeof members !== 'object') return '';
      const now = Date.now();
      const seen = new Set();
      const active = [];
      for (const m of [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse()) {
        if (!m || m.isSelf) continue;
        const id = String(m.userId || '');
        if (!id || seen.has(id)) continue;
        if (now - Number(m.time || 0) > 15 * 60 * 1000) break;
        seen.add(id);
        active.push({ userId: id });
        if (active.length >= 8) break;
      }
      if (!active.length) return '';
      // 顺带对在场的人做一次懒衰减，保证语气档位跟得上"很久没聊"的情况
      for (const a of active) {
        const mm = members[a.userId];
        if (mm) { try { applyDecay(mm, ac, now); } catch { /* 忽略 */ } }
      }
      return formatAffinityPanel(members, active, ac);
    })();
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    // 本地表情包库（dsh-meme 图库）：只在真的载入到图库时才注入，避免占上下文。
    const memeLine = (() => {
      const mc = memeCfg();
      if (mc.enabled === false || mc.includeInPrompt === false) return '';
      try {
        const { catalog, packs } = ensureMemeCatalog(false);
        if (!catalog.length) return '';
        return `${buildMemeStrategyHint(stickerCfg.enabled !== false)}\n${buildMemeContext(catalog, memeStats, packs, mc.promptMaxMemes)}\n\n`;
      } catch (error) {
        log(`[meme] 生成表情包提示失败: ${error?.message ?? error}`);
        return '';
      }
    })();
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const preSleepLine = `【沉睡前强制等待】除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；短等待（30秒/60秒/180秒）不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // [qq-bridge 本地补丁] 后台生图进行中提示。
    // 生图是异步的：agent 说完"已开始生成"就结束回合，1~4 分钟后由 worker 直接发图到群里。
    // 这段时间 agent 在会话里看不到任何"我发过图"的记录，实测会自己编出
    // "十分钟了图还没出来"这种假消息（图其实早就发出去了）。这里明确告诉它真实状态。
    const imageJobLine = (() => {
      const job = st?.imageJob;
      const fail = st?.imageFail;
      // 最近一次生图失败（10 分钟内）：这是**权威状态**，必须明确告诉模型，否则它会自己编
      // "正在画/马上好"（2026-09-28 事故：失败 1 分钟后它还对群友说"没耍你，正在画，等两分钟"）。
      if (!job && fail && Date.now() - Number(fail.at || 0) < 10 * 60000) {
        const who = fail.senderName ? `@${fail.senderName}` : `QQ ${fail.senderId}`;
        const mins = Math.max(0, Math.round((Date.now() - Number(fail.at || 0)) / 60000));
        return `【生图结果：失败】${who} 那次生图在 ${mins} 分钟前**已经失败了**（原因：${fail.reason || '未知'}），失败提示也已经发到群里了。`
          + `所以：**绝对不要**说"还在画/正在生成/马上好/等两分钟"这类话——那是假话，群友会当场发现。`
          + `要做的：如实承认失败、可以说一句抱歉/换个说法让他重新 @我 发一次；不要重复宣布失败（那条已经发过了）。\n\n`;
      }
      if (!job) return '';
      const until = Number(job.expiresAt) || 0;
      if (until && Date.now() > until) {
        try { st.imageJob = null; } catch {}
        return '';
      }
      const secs = Math.max(0, Math.round((Date.now() - (Number(job.startedAt) || Date.now())) / 1000));
      const who = job.senderName ? `@${job.senderName}` : `QQ ${job.senderId}`;
      const ack = st?.imageAck && Date.now() - Number(st.imageAck.at || 0) < 15 * 60000 ? String(st.imageAck.text || '') : '';
      return `【后台正在生图】你之前已经接了 ${who} 的生图请求，现在图还在后台生成（已 ${secs} 秒，通常 1~4 分钟）。`
        + `画好后会自动发到群里并 @ 他，不需要你再做什么。`
        + (ack ? `开始那句桥接已经替你发过了（「${ack}」），**不要再重复宣布"开始画了/收到"**。` : '')
        + `所以：不要重复调用生图、不要回复"没画出来/还在画"之类的话，也不要让他重新 @ 你 —— 除非你想说点别的正常聊天内容。\n\n`;
    })();
    // 群管理：告诉模型它到底有没有权限、能做什么、不许做什么（避免它瞎承诺）。
    const adminLine = (() => {
      const c = adminCfg();
      if (!c.enabled) return '';
      const gid = adminGroups()[0];
      if (!gid) return '';
      const cached = memberRoleCache.get(`${gid}:${botSelfId}`)?.role ?? '';
      void getBotRole(gid).catch(() => {}); // 预热缓存，下一次提示词就是准的
      checkDryRunExpiry();
      const dryNow = adminDryRun();
      const pendingNow = c.announcement.enabled ? currentPendingNotice() : null;
      const lines = [];
      if (cached === 'admin' || cached === 'owner') {
        lines.push(`【群管理】你在群 ${gid} 是管理员：可以 qq_request_mute 提议禁言（桥接会自己核验证据，证据不足会被拒）、可以 qq_propose_announcement 起草群公告（必须群主在私聊里回复「通过」才会发布）。`);
        lines.push(`只对两种情况动手：①同一个人 2 分钟内重复发同一句话/同一张图 5 次以上；②持续辱骂你（针对你、累计 3 条以上）。观点不同、开玩笑、吐槽你、骂别人——都不算，别动手，也别威胁群友。`);
        lines.push(`你没有也不许提：踢人、全员禁言、改群名群名片、群相册、群文件、设/撤管理员。群友问起就直说"这些我不碰"。`);
        lines.push(`当前模式：${dryNow ? `干跑（只记录 + 私聊通知群主，不真的禁言${c.dryRunUntil > Date.now() ? `，还剩约 ${Math.max(1, Math.round((c.dryRunUntil - Date.now()) / 3600000))} 小时自动生效` : ''}）` : '已生效'}${
          Object.entries(moderationLog.mutedUntil).filter(([, t]) => Number(t) > Date.now()).length
            ? `；正在禁言中：${Object.entries(moderationLog.mutedUntil).filter(([, t]) => Number(t) > Date.now()).map(([k]) => k.split(':')[1]).join(', ')}`
            : ''}`);
        lines.push(`禁言执行后，桥接会自动在群里替你说一句按你人设的短话（类似"复读机啊，先歇 3 分钟"），所以你**不用再宣布一遍**；如果有人接着聊这事，你可以自然接一句，但别说教、别炫耀权限、别提"规则/系统"。`);
      } else {
        lines.push(`【群管理】你在群 ${gid} 不是管理员（当前身份：${cached || '未知'}）：没有禁言、改公告的权限，遇到刷屏/被骂就用文字处理或无视，**不要承诺"我去禁言他"**。`);
      }
      if (st?.moderationNote && Date.now() - Number(st.moderationNote.at || 0) < 600000) {
        const n = st.moderationNote;
        lines.push(`【刚发生】${new Date(n.at).toLocaleTimeString('zh-CN')} 桥接把 ${n.userName}(${n.userId}) 禁言了 ${n.minutes} 分钟（${n.kind === 'attack' ? '持续骂你' : '重复刷屏'} ×${n.count}），群里已经替你说了那句话。你可以正常继续聊，但**不要重复宣布**、不要追着说教。`);
      }
      if (pendingNow) {
        lines.push(`【待批群公告】已有一份草稿在等群主确认（${new Date(pendingNow.createdAt).toLocaleString('zh-CN')} 提交，${pendingNow.content.length} 字）：不要重复起草，群主回复「通过/拒绝」后我会告诉你结果。`);
      }
      return lines.join('\n') + '\n\n';
    })();
    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + memeLine + adminLine + preSleepLine + statusLine + wakeLine + imageJobLine + affinityLine + memoryLine + participationLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看你的角色、推荐值、可用工具和当前状态，然后用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n你可以调用工具查看未读消息、用 qq_wait_for_messages(quietMs=5000~10000) 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 每次唤醒都是一个新回合：清空上一轮可能残留的“沉睡前已观察/已等待”标记，
    // 确保 AI 这一轮想再次潜水时，必须重新走 5 分钟沉睡前观察。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
      return;
    }
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText);
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function isConversationBusyV2(key, st) {
    // [qq-bridge 本地补丁] 先跑一次 busy 看门狗：若该会话已超过阈值没有任何 DSH 事件
    // （典型原因：turn/end 事件丢失），就地清除 collectors / v2TurnStartAt / promptQueues / pendingWakeKeys，
    // 让本次唤醒能正常投递，而不是被“会话繁忙”永久挡住。
    // 阈值：agent 正在 qq_wait_for_messages 长轮询时用 10 分钟，否则 3 分钟。
    const watchdogLimit = busyWatchdogLimitMs(key);
    if (busyWatchdogTimer.has(key) && Date.now() - (busyWatchdogAt.get(key) ?? Date.now()) >= watchdogLimit) {
      // 看门狗现在要问 DSH 要 running 状态，是异步的：这里只发起查询，清标记与重投唤醒由它完成。
      void watchdogBusyConversations().catch((error) => log(`[watchdog] 巡检异常：${error?.message ?? error}`));
    }
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (sid && (v2TurnStartAt.has(sid) || collectors.has(sid))) return true;
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      // [qq-bridge 本地补丁] 生图票据：这次唤醒若由「@机器人」触发，就在回合真正开始时**重新起算**有效期。
      // 桥接自己的排队/合并窗口/看门狗会把 @ 拖过 180 秒（实测拖了 3 分 54 秒，图还没生成就被
      // 判成"没有 @ 记录"），那是桥接的锅，不该让群友重新 @ 一遍。
      // 票据只在"被 @ 唤醒的那一轮"里有效（回合结束即作废，见 turn 结束处理），且消费一次即失效。
      try {
        if (finalReason === 'atMention' && st.lastMention?.senderId) {
          const fresh = Number(cfg.socialV2?.image?.mentionFreshMs) || 180000;
          st.imageTicket = {
            senderId: String(st.lastMention.senderId),
            senderName: String(st.lastMention.senderName ?? ''),
            at: Number(st.lastMention.at) || Date.now(),
            text: String(st.lastMention.text ?? ''),
            messageId: st.lastMention.messageId != null ? String(st.lastMention.messageId) : null,
            quoteId: st.lastMention.quoteId != null ? String(st.lastMention.quoteId) : null,
            // 票据已经绑定在"被 @ 唤醒的这一轮"上（回合结束立刻作废），所以有效期给宽一点没关系：
            // 模型有时会先查几条未读消息再调生图，卡在 180 秒上会白费一次召唤。
            expiresAt: Date.now() + Math.max(fresh, 10 * 60 * 1000)
          };
        }
      } catch { /* 票据失败不影响唤醒 */ }
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 2147483647;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  /**
   * owner 私聊的"桥接级命令"：公告审批 + 公告/禁言查询。
   *
   * 必须在 modeAllowed 白名单之前处理 —— reserved2 模式下 `allow.private` 默认是空的，
   * 群主的私聊回复（比如公告审批的「通过」）会被白名单直接丢掉（2026-09-28 实测踩到：
   * 日志 `忽略未授权会话 private:100000001`，草稿一直卡在待审）。
   *
   * 触发面很窄：只有 owner 私聊 + 明确命令词/审批词才接管，其他私聊内容照旧走白名单逻辑。
   * 回执一律用 sendOwnerDM()（sendToQQ 会被同一个白名单拦掉）。
   * @returns {Promise<boolean>} 是否已被接管
   */
  async function handleOwnerPrivateCommand(key, ownerId, event) {
    let text = '';
    try {
      text = String(await segmentsToText(event?.message ?? [], { resolveAtName: async () => null, includeReply: false })).trim();
    } catch { return false; }
    if (!text) return false;
    const c = adminCfg();
    const decision = parseApproval(text);
    const pendingNow = c.announcement.enabled ? currentPendingNotice() : null;

    // 1) 公告审批：通过 / 拒绝 / 取消
    if (decision && pendingNow) {
      if (decision === 'approve') {
        const r = await approvePendingNotice('owner');
        await sendOwnerDM(r.ok ? `✅ 群公告已发布（${r.text.length} 字）` : `❌ 发布失败：${r.error}`);
        appendActivity(`${key} [admin] owner 私聊批准并发布群公告`);
      } else {
        rejectPendingNotice('管理员私聊回复拒绝');
        await sendOwnerDM('👌 已放弃这份公告草稿（群里没有任何改动）');
        appendActivity(`${key} [admin] owner 私聊拒绝了公告草稿`);
      }
      return true;
    }
    if (decision && !pendingNow && c.announcement.enabled) {
      await sendOwnerDM('现在没有待审的群公告草稿。');
      return true;
    }

    // 2) 查询类命令（私聊也能用，避免 owner 非得在群里发）
    if (text === '/公告') {
      const gid = adminGroups()[0] ?? '';
      const cur = gid ? await fetchCurrentNotice(gid) : { ok: false, text: '', count: 0 };
      const lines = [`群 ${gid} 当前公告（共 ${cur.count ?? 0} 条）:`];
      lines.push(cur.text ? cur.text.slice(0, 600) : '（暂无公告）');
      lines.push(pendingNow ? '\n有待审草稿：回复「通过」发布 / 「拒绝」放弃。' : '\n没有待审草稿。');
      await sendOwnerDM(lines.join('\n'));
      return true;
    }
    if (text === '/公告通过') {
      const r = await approvePendingNotice('owner');
      await sendOwnerDM(r.ok ? `✅ 群公告已发布（${r.text.length} 字）` : `❌ ${r.error}`);
      return true;
    }
    if (text === '/公告拒绝') {
      const r = rejectPendingNotice('管理员命令拒绝');
      await sendOwnerDM(r.ok ? '👌 已放弃这份公告草稿。' : `❌ ${r.error}`);
      return true;
    }
    if (text === '/禁言记录' || text.startsWith('/禁言记录 ')) {
      const n = Math.min(20, Math.max(1, Number(text.split(/\s+/)[1]) || 5));
      const rows = moderationLog.records.slice(-n).reverse();
      await sendOwnerDM(rows.length ? ['最近群管理记录：', ...rows.map((r) => '· ' + formatRecordLine(r))].join('\n') : '还没有群管理记录。');
      return true;
    }
    return false;
  }

  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    // owner 私聊的桥接级命令先于白名单处理（见 handleOwnerPrivateCommand 注释）。
    if (kind === 'private' && String(event?.user_id) === String(cfg.ownerQQ ?? '')) {
      try {
        if (await handleOwnerPrivateCommand(key, id, event)) return;
      } catch (error) {
        log(`⚠️ owner 私聊命令处理失败：${error?.message ?? error}`);
      }
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // （owner 私聊的公告审批已经在 handleIncoming 开头、白名单之前处理：handleOwnerPrivateCommand。
    //   这里不再重复处理，否则那段代码永远走不到，而且 sendToQQ 会被 allow.private 拦掉。）

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // [qq-bridge 本地补丁] 投喂（赞助）：桥接确定性接管，不让模型碰钱。
    // 只有"对机器人说的、含投喂关键词"的群消息才会进这条路，接管后不再唤醒模型。
    try {
      const atSelf = Array.isArray(event?.message)
        && event.message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(event?.self_id ?? ''));
      if (handleFeedRequest(key, getSocialV2State(key), {
        kind,
        senderId: String(event?.user_id ?? event?.sender?.user_id ?? ''),
        senderName: String(event?.sender?.card || event?.sender?.nickname || ''),
        text: String(plainContent ?? textContent ?? ''),
        addressedToBot: atSelf || Boolean(quoteTargetIsSelf)
      })) return;
    } catch (error) {
      log(`⚠️ 投喂处理入口异常（按普通消息继续）：${error?.message ?? error}`);
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          const removedV2 = socialV2.conversations.get(key);
          if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await api.stopSessionWork(old); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: old }); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // ── 群管理命令（仅 owner，桥接直接执行，不经过模型）──────────────────
      if (plainContent === '/禁言记录' || plainContent.startsWith('/禁言记录 ')) {
        const n = Math.min(20, Math.max(1, Number(plainContent.split(/\s+/)[1]) || 5));
        const rows = moderationLog.records.slice(-n).reverse();
        if (!rows.length) { await sendToQQ(key, '还没有群管理记录。'); return; }
        await sendToQQ(key, ['最近群管理记录：', ...rows.map((r) => '· ' + formatRecordLine(r))].join('\n'));
        return;
      }
      if (plainContent.startsWith('/禁言 ')) {
        const [, qq, mins] = plainContent.split(/\s+/);
        if (!/^\d+$/.test(String(qq ?? ''))) { await sendToQQ(key, '用法：/禁言 <QQ> [分钟 1~10]'); return; }
        if (kind !== 'group') { await sendToQQ(key, '群管理命令请在群里发（当前是私聊）。'); return; }
        const c = adminCfg();
        const minutes = Math.max(1, Math.min(10, Number(mins) || 3));
        const seconds = Math.max(c.mute.minSec, Math.min(c.mute.maxSec, minutes * 60));
        try {
          const botRole = await getBotRole(id);
          if (botRole !== 'admin' && botRole !== 'owner') { await sendToQQ(key, '我在这个群不是管理员，禁言会被 QQ 拒绝。'); return; }
          const targetRole = await getMemberRole(id, qq, true);
          const guard = canMuteTarget({ targetId: qq, targetRole, botRole, botId: botSelfId, ownerQQ: cfg.ownerQQ, groupOwnerId: String(cfg.ownerQQ ?? ''), whitelist: [] });
          if (!guard.ok) { await sendToQQ(key, `不能禁言该成员：${guard.reason}`); return; }
          const targetInfo = await getMemberInfo(id, qq, true);
          const sec = await callMute(id, qq, seconds);
          moderationLog.mutedUntil[`${id}:${qq}`] = Date.now() + sec * 1000;
          pushModerationRecord({ groupId: id, userId: qq, userName: targetInfo.name, action: 'mute', trigger: 'manual', by: 'owner', seconds: sec, ok: true, reason: '管理员手动禁言' });
          await sendToQQ(key, `已禁言 ${targetInfo.name || qq} ${Math.round(sec / 60)} 分钟。`);
          appendActivity(`${key} [admin] owner 手动禁言 ${qq} ${Math.round(sec / 60)} 分钟`);
        } catch (error) {
          pushModerationRecord({ groupId: id, userId: qq, action: 'mute', trigger: 'manual', by: 'owner', ok: false, error: String(error?.message ?? error) });
          await sendToQQ(key, `禁言失败：${error?.message ?? error}`);
        }
        return;
      }
      if (plainContent.startsWith('/解禁 ')) {
        const qq = plainContent.split(/\s+/)[1];
        if (!/^\d+$/.test(String(qq ?? ''))) { await sendToQQ(key, '用法：/解禁 <QQ>'); return; }
        if (kind !== 'group') { await sendToQQ(key, '群管理命令请在群里发（当前是私聊）。'); return; }
        try {
          await callUnmute(id, qq);
          delete moderationLog.mutedUntil[`${id}:${qq}`];
          pushModerationRecord({ groupId: id, userId: qq, action: 'unmute', trigger: 'manual', by: 'owner', ok: true, reason: '管理员手动解禁' });
          await sendToQQ(key, `已解除 ${qq} 的禁言。`);
        } catch (error) {
          await sendToQQ(key, `解禁失败：${error?.message ?? error}`);
        }
        return;
      }
      if (plainContent === '/公告') {
        const gid = adminGroups()[0] ?? id;
        const cur = await fetchCurrentNotice(gid);
        const pendingNow = currentPendingNotice();
        const lines = [`群 ${gid} 当前公告（共 ${cur.count ?? 0} 条，最新一条 ${cur.publishTime ? new Date(cur.publishTime * 1000).toLocaleString('zh-CN') : '无'}）：`];
        lines.push(cur.text ? cur.text.slice(0, 600) : '（暂无公告）');
        lines.push(pendingNow ? `\n有待审草稿（${new Date(pendingNow.createdAt).toLocaleString('zh-CN')} 提交）：回复「通过」发布 / 「拒绝」放弃。` : '\n没有待审草稿。想让机器人起草：直接跟它说"把这次更新写进群公告"。');
        await sendToQQ(key, lines.join('\n'));
        return;
      }
      if (plainContent === '/公告通过') {
        const r = await approvePendingNotice('owner');
        await sendToQQ(key, r.ok ? `✅ 群公告已发布（${r.text.length} 字）` : `❌ ${r.error}`);
        return;
      }
      if (plainContent === '/公告拒绝') {
        const r = rejectPendingNotice('管理员命令拒绝');
        await sendToQQ(key, r.ok ? '👌 已放弃这份公告草稿。' : `❌ ${r.error}`);
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      // 是否 @ 了机器人：好感度记账与群管理（攻击判定）都要用，这里算一次。
      const atSelf = Array.isArray(event?.message)
        && event.message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === String(event?.self_id ?? ''));
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), atSelf);
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      // [qq-bridge 本地补丁] 好感度记账（阶段 1：只驱动"称呼 + 语气"，对群友完全隐藏）。
      // 纯确定性规则在 src/affinity.js 里，这里只把消息事件翻译成规则需要的字段。
      try {
        scoreAffinityEvent(key, st, {
          kind,
          senderId: String(event?.user_id ?? event?.sender?.user_id ?? ''),
          senderName: String(event?.sender?.card || event?.sender?.nickname || ''),
          text: String(plainContent ?? textContent ?? ''),
          mediaCount: Array.isArray(mediaList) ? mediaList.filter((m) => m && m.kind !== 'face').length : 0,
          attention: atSelf || Boolean(quoteTargetIsSelf)
        });
      } catch (error) {
        log(`⚠️ 好感度记账失败（忽略）：${error?.message ?? error}`);
      }
      // [qq-bridge 本地补丁] 群管理（禁言）：确定性判定（同文本/同图重复、针对机器人的辱骂），
      // 纯内存计算，只有真的命中才去查身份/动手；干跑模式下只记录 + 通知 owner。
      try {
        await runModerationCheck(key, kind, id, { atSelf });
      } catch (error) {
        log(`⚠️ 群管理判定失败（忽略）：${error?.message ?? error}`);
      }
      // [qq-bridge 本地补丁] 生图即时回执：群里刚出现"@我 + 生图…"就先回一句"画着呢"，
      // 不等 agent 回合（会话繁忙时可能排很久，群里那段时间会像没反应）。
      if (kind === 'group') {
        try {
          await maybeSendEarlyImageAck(key, {
            atSelf,
            quoteTargetIsSelf,
            text: plainContent,
            senderId: String(event?.user_id ?? event?.sender?.user_id ?? ''),
            senderName: String(event?.sender?.card || event?.sender?.nickname || ''),
            requestId: event?.message_id != null ? String(event.message_id) : (event?.msg_id != null ? String(event.msg_id) : null)
          });
        } catch (error) {
          log(`⚠️ 生图即时回执失败（忽略）：${error?.message ?? error}`);
        }
      }
      // [qq-bridge 本地补丁] 记录"最近一次 @ 了机器人"的上下文，供 qq_generate_image 做硬校验
      // （必须被 @ 且在窗口期内、正文以"生图"开头）。event 是 OneBot v11 原始事件。
      try {
        const senderId = String(event?.user_id ?? event?.sender?.user_id ?? '');
        const senderName = String(event?.sender?.card || event?.sender?.nickname || senderId);
        const mentionReason = kind === 'private'
          ? 'private'
          : evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (mentionReason === 'atMention' && senderId) {
          const mention = {
            senderId,
            senderName,
            at: Date.now(),
            text: String(plainContent ?? textContent ?? '').slice(0, 200),
            // [qq-bridge 本地补丁] 记下消息 id 与"被引用消息 id"，供带图生图取输入图用：
            // ① 本条 @ 消息自带图片；② 它引用的那条消息里的图片。
            messageId: event?.message_id != null ? String(event.message_id) : null,
            quoteId: (() => {
              const seg = Array.isArray(event?.message)
                ? event.message.find((s) => s?.type === 'reply' && s?.data?.id != null)
                : null;
              return seg ? String(seg.data.id) : null;
            })()
          };
          st.lastMention = mention;
          // [qq-bridge 本地补丁] 不再只留"最后一条 @"：会话繁忙时 agent 回合会拖后，
          // 期间后面那条无关的 @（比如"这个是@某某"）会把生图请求顶掉，
          // 结果模型明明看到"@我 生图 …"却调不动工具（2026-09-28 实测：库库那次被误判成"命令不对"）。
          // 现在保留最近若干条 @，受理时挑**最新的、而且真的像生图请求的那一条**。
          const list = Array.isArray(st.recentMentions) ? st.recentMentions : [];
          list.push(mention);
          // 去重（同一 messageId 只留最新）+ 只留 15 分钟内 + 最多 8 条
          const cutoff = Date.now() - 15 * 60 * 1000;
          const dedup = [];
          for (const item of list) {
            if (!item || Number(item.at) < cutoff) continue;
            const dupIdx = dedup.findIndex((x) => x.messageId && item.messageId && x.messageId === item.messageId);
            if (dupIdx >= 0) dedup[dupIdx] = item; else dedup.push(item);
          }
          st.recentMentions = dedup.slice(-8);
          // 新的 @ 覆盖旧的：旧票据立即作废，避免用上一个人的请求生图。
          st.imageTicket = null;
        }
      } catch { /* 记录失败不影响主流程 */ }
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          if (frame.type === 'session/event') {
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // [qq-bridge 本地补丁] 记录该会话最近一次被判定为 busy 的时刻，并确保看门狗已挂上。
            // 只要事件流在正常投递（含超长 turn 里的 tool/call / assistant 分片），就不会被看门狗误杀。
            markSessionActivity(key);
            armBusyWatchdog(key);
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              // [qq-bridge 本地补丁] 生图票据只属于"被 @ 唤醒的这一轮"：回合结束即作废，
              // 避免它在这之后的某个无关回合里被翻出来用掉（其他人此时说「生图」就会生成上一个人的请求）。
              try { getSocialV2State(key).imageTicket = null; } catch { /* 状态缺失时忽略 */ }
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const item = stEnd.pendingWakeReasons.shift();
                  if (!item || typeof item !== 'object') {
                    // 兼容旧字符串残留
                  } else {
                    const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
                    if (stillRelevant) {
                      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
                      scheduleWakeV2(key, item.reason);
                    } else {
                      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
                    }
                  }
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    st.lastActiveMessageAt = Date.now();
                    st.lastAiReplyAt = Date.now();
                    log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        clearAllBusyWatchdogs();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
      }
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  bot.on('open', () => {
    log(`SnowLuma 已连接：${cfg.snowluma.wsUrl}`);
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id) {
        botSelfId = String(login.user_id);
        memberRoleCache.clear();
      }
    }).catch(() => {});
  });
  bot.on('close', (info) => log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`));
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    log(`SnowLuma 初始连接失败（将在后台自动重连）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // [qq-bridge 本地补丁] 群管理：干跑到期检查（必须放在 bot 初始化之后，否则私聊通知会踩 TDZ）
  try { startAdminTimers(); } catch (error) { log(`⚠️ 群管理定时器启动失败：${error?.message ?? error}`); }
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => log('未处理异常:', error?.message ?? error));
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
