// 明日方舟日活：**触发命令的判定**（纯函数，可离线测试）。
//
// 需求（2026-09-29 owner）：只有「@机器人 帮我做明日方舟日活」这一句触发，
// 其他任何说法都不触发；而且只允许 owner 触发（这台机器上登的是他的账号）。
//
// 所以这里的判定要**严**：去掉 @提及、空白、句末标点之后，必须与配置里的命令**完全相等**，
// 不做「包含」「近似」「模糊」匹配 —— 宁可漏触发（owner 再发一次），也不要让别的说法误触发。
//
// 判定之外的两道闸门在桥接侧（owner 身份 + 必须是对着机器人说的），见 bridge.js 的
// handleArknightsRequest 调用点。

/** 把一句话归一成可比较的形式：去掉 @提及、所有空白、句末标点与常见装饰。 */
export function normalizeCommandText(text) {
  return String(text ?? '')
    .replace(/@\S+/g, '')          // @昵称 / @123456 / @全体成员
    .replace(/\s+/g, '')           // 所有空白（含全角空格）
    .replace(/[\u3000]/g, '')
    .replace(/[。．.!！?？~～,，、；;:：]+$/g, '') // 句末标点
    .replace(/^[，,、；;:：]+/g, '')
    .trim();
}

/**
 * 是不是那条触发命令。
 * @param {string} text 消息正文（plainContent，引用原文已被排除）
 * @param {string} phrase 配置里的命令（默认「帮我做明日方舟日活」）
 */
export function isArknightsCommand(text, phrase = '帮我做明日方舟日活') {
  const a = normalizeCommandText(text);
  const b = normalizeCommandText(phrase);
  if (!a || !b) return false;
  return a === b;
}

/**
 * 把一次运行整理成给 QQ 看的一段话（纯函数）。
 * 执行器（scripts/arknights-daily.mjs）与桥接（回报到群里）共用这一份实现，避免两处措辞漂移。
 */
export function formatArknightsReport(job) {
  const startedAt = Number(job?.startedAt) || 0;
  const finishedAt = Number(job?.finishedAt) || Date.now();
  const sec = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  const mins = Math.floor(sec / 60);
  const dur = mins > 0 ? `${mins} 分 ${sec % 60} 秒` : `${sec} 秒`;
  if (job?.ok) {
    const tasks = Array.isArray(job.finishedTasks) && job.finishedTasks.length ? `，任务编号 ${job.finishedTasks.join('/')}` : '';
    return `方舟日活跑完了 ✅（${dur}）：${job.reason || '完成'}${tasks}。${job.closedClient ? '客户端已关闭。' : '客户端没关（按配置保留）。'}`;
  }
  const why = job?.reason || '未知原因';
  const tail = Array.isArray(job?.logTail) && job.logTail.length ? `日志尾巴：${job.logTail.slice(-3).join(' | ').slice(0, 300)}` : '';
  // 「部分完成」单独一种措辞：跑完了但有任务失败（2026-09-30 实测 MAAEND 的 DijiangRewards 一直失败）
  if (job?.partial) {
    const ok = Number(job.successCount) || 0;
    const bad = Number(job.failedCount) || (Array.isArray(job.failedNames) ? job.failedNames.length : 0);
    const names = Array.isArray(job.failedNames) && job.failedNames.length ? `，失败的是 ${job.failedNames.join('、')}` : '';
    return `日活基本跑完 ⚠️（${dur}）：成功 ${ok} 个、失败 ${bad} 个${names}。${job.closedClient ? '客户端已关闭。' : ''}（个别任务失败可以在工具里单独重跑）`;
  }
  return `方舟日活没跑成 ❌（${dur}）：${why}。${tail}`;
}

/** 从状态文件对象里算出「现在是什么状态」，给提示词/回报用（纯函数）。 */
export function describeJob(job, now = Date.now(), { timeoutSec = 1800 } = {}) {
  if (!job || typeof job !== 'object' || !job.startedAt) return null;
  const startedAt = Number(job.startedAt) || 0;
  const finishedAt = Number(job.finishedAt) || 0;
  const elapsedSec = Math.max(0, Math.round(((finishedAt || now) - startedAt) / 1000));
  if (!finishedAt) {
    const running = elapsedSec <= timeoutSec + 300; // 超过兜底时间还没落状态 → 当作异常结束
    return running
      ? { state: 'running', elapsedSec, text: `正在跑（已 ${Math.round(elapsedSec / 60)} 分钟）` }
      : { state: 'stale', elapsedSec, text: `状态文件停在 ${Math.round(elapsedSec / 60)} 分钟前，可能异常中断（看 state/arknights-daily.log）` };
  }
  const staleMs = now - finishedAt;
  if (staleMs > 30 * 60000) return { state: 'old', elapsedSec, text: '' }; // 太久以前的不再提示
  return {
    state: job.ok ? 'done' : 'failed',
    elapsedSec,
    text: job.ok
      ? `刚跑完：成功（${Math.max(1, Math.round(elapsedSec / 60))} 分钟）`
      : `刚跑完：失败（${job.reason || '未知原因'}）`
  };
}
