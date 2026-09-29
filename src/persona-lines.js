// persona-lines.js —— 桥接"替机器人说的一句话"（群里播报）的模板池与挑选器。
//
// 为什么单独放一个模块：这些文案必须**像机器人本人说的**，而且要被单测覆盖
// （不骂人、带名字、能填分钟数/剩余次数），所以从各处逻辑里抽出来集中管理。
// 目前有两类：
//   1) 禁言播报（moderation.js 用）：刷屏 / 攻击两个池；
//   2) 生图开始时的一句提示（bridge.js 用）：'收到，画着呢'。

/** 禁言播报：重复刷屏 */
export const DEFAULT_ANNOUNCE_TEMPLATES = [
  '@{name} 复读机啊，先歇 {minutes} 分钟',
  '{name}，{minutes} 分钟内别说话，我耳朵疼',
  '行行行，{name} 去喝口水，{minutes} 分钟后回来',
  '{name} 冷静一下，{minutes} 分钟',
  '刷屏到此为止，{name} 先安静 {minutes} 分钟'
];

/** 禁言播报：持续攻击机器人（语气硬一点，但仍然不骂人） */
export const DEFAULT_ANNOUNCE_TEMPLATES_ATTACK = [
  '{name}，骂够了没，{minutes} 分钟后再来',
  '{name} 先闭嘴 {minutes} 分钟，我没空跟你吵',
  '这么说我可不爱听，{name} 去冷静 {minutes} 分钟'
];

/**
 * 生图刚被受理时说的一句（1~4 分钟后 worker 会自动把图发到群里并 @ 请求者）。
 * `{name}` = 请求者群名片，`{remaining}` = 今天还剩几次（owner 无限次，用不含该占位符的模板）。
 */
export const DEFAULT_IMAGE_ACK_TEMPLATES = [
  '收到，画着呢，1~4 分钟',
  '{name} 行，等我几分钟',
  '{name} 稍等，正在画',
  '画上了，好了直接发群里',
  '{name} 收到，别急，画完叫你',
  '{name} 画着呢，今天还剩 {remaining} 次'
];

function fill(template, vars = {}) {
  return String(template ?? '')
    .replace(/\{name\}/g, String(vars.name || '这位'))
    .replace(/\{minutes\}/g, String(vars.minutes ?? 1))
    .replace(/\{remaining\}/g, String(vars.remaining ?? ''))
    .trim();
}

/** 从模板池里随机抽一条并填充变量；可用模板为空时返回空串。 */
export function pickTemplateLine(templates, vars = {}, random = Math.random) {
  const list = (Array.isArray(templates) ? templates : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!list.length) return '';
  const rnd = typeof random === 'function' ? random : Math.random;
  const picked = list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
  return fill(picked, vars);
}

/**
 * 生图提示文案。
 * - remaining 为 null（owner 无限次）时，会自动跳过带 {remaining} 的模板，避免出现"还剩 次"。
 * @param {{ackEnabled?:boolean, ackTemplates?:string[]}} cfg socialV2.image
 */
export function pickImageAckLine(cfg, { name, remaining = null, isOwner = false, random } = {}) {
  if (cfg?.ackEnabled === false) return '';
  const pool = (Array.isArray(cfg?.ackTemplates) && cfg.ackTemplates.length ? cfg.ackTemplates : DEFAULT_IMAGE_ACK_TEMPLATES)
    .map((t) => String(t ?? '').trim())
    .filter(Boolean);
  const usable = (isOwner || remaining === null) ? pool.filter((t) => !t.includes('{remaining}')) : pool;
  const list = usable.length ? usable : pool.filter((t) => !t.includes('{remaining}'));
  return pickTemplateLine(list, { name, remaining }, random);
}
