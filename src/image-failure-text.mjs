// 生图失败时**给群友看的文案**：如实区分「首选后端」和「回落后端」各自的失败原因。
//
// [2026-10-12 事故] 之前只读 codex 那半段日志来分类，于是火山方舟因内容审核拒绝时，
// 群里收到的却是「codex 那边出错了」——把锅甩给了第二棒，也让 owner 误判成 codex 的问题。
// 现在两个后端的原因都如实报。
//
// ⚠️ 本模块只负责「怎么说」，**不改变**「Ark 失败后要不要回落 codex」的策略（那是 worker 的事）。

/** 火山方舟（Agent Plan）失败原因 → 一句人话（识别不出来就返回空串） */
export function classifyArkFailure(text) {
  const t = String(text ?? '');
  if (!t) return '';
  if (/sensitive information|content policy|risk control|敏感/i.test(t)) {
    return '火山方舟说输出图可能含敏感内容（内容审核挡下了）';
  }
  if (/\b401\b|unauthorized|invalid[^。]{0,20}(key|api)/i.test(t)) return '火山方舟的 API Key / 端点不对（401）';
  if (/\b429\b|rate ?limit|too many requests/i.test(t)) return '火山方舟在限流（429）';
  if (/超时|timeout|timed out|ETIMEDOUT/i.test(t)) return '到火山方舟的请求超时了';
  if (/网络|network|ECONNRESET|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(t)) return '到火山方舟的网络不通';
  const http = t.match(/HTTP\s*(\d{3})/i);
  if (http) return `火山方舟出错（HTTP ${http[1]}）`;
  return '火山方舟那边出错了';
}

/** codex 失败原因 → 一句人话（沿用原有分类，别改口径，测试里有断言） */
export function classifyCodexFailure(text, { hasImages = false } = {}) {
  const t = String(text ?? '');
  if (/网络不可达|network error|fetch failed|ECONNRESET|ETIMEDOUT/i.test(t)) return '网络到 chatgpt.com 不通（代理节点问题）';
  if (/wasn't attached|was not attached|no image|missing image|attach/i.test(t)) {
    return hasImages ? 'codex 没收到我给的参考图' : '这次是要改图，但我没拿到参考图';
  }
  if (/safety|policy|violat/i.test(t)) return 'codex 说这个请求它不能画';
  if (/timed? ?out/i.test(t)) return 'codex 超时了（没在时限内画完）';
  return 'codex 那边出错了（不是你的问题）';
}

/** 这次失败是不是"内容审核"挡的（决定要不要劝群友换个描述） */
export function looksLikeModeration(failureText) {
  return /敏感|不能画|内容审核|sensitive|policy|violat/i.test(String(failureText ?? ''));
}

/**
 * 组合成一句失败说明（"这次不扣次数…"那半句由调用方拼）。
 * @param {{backend?:string, arkText?:string, codexText?:string, hasImages?:boolean}} o
 */
export function buildImageFailureText({ backend, arkText = '', codexText = '', hasImages = false } = {}) {
  const arkWhy = classifyArkFailure(arkText);
  const codexWhy = codexText ? classifyCodexFailure(codexText, { hasImages }) : '';
  if (backend === 'ark' && arkWhy) {
    // 嵌进括号里时去掉 codex 原因自带的括号说明，避免"（…（…））"这种套娃
    const codexBrief = codexWhy.replace(/（[^）]*）\s*$/, '');
    return codexWhy
      ? `${arkWhy}；回落的 codex 也失败（${codexBrief}）`
      : `${arkWhy}；回落 codex 也没成功`;
  }
  if (codexWhy) return codexWhy;
  return '两个生图后端都没成功';
}
