// QQ mode settings use loader entry id `qq-mode` and Config, not runtime registration.
import z from '@deepseek-ai/schemastery';

export const name = 'qq-mode-console';
export const inject = ['settings'];
export const QQMODE_NAMESPACE = 'qq-mode';
const modes = () => z.union([
  z.const('chat'), z.const('closed-agent'), z.const('reserved'),
  z.const('reserved2'), z.const('simulation'),
]).default('reserved2');
const owner = () => z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json');

// Keep the public schema for existing validation/import consumers.
export const QqModeSchema = z.object({ mode: modes(), ownerQQ: owner() });
export const Config = z.object({
  mode: modes().extra('volatile', true),
  ownerQQ: owner().extra('volatile', true),
});

// DSH 0.2 reads Config directly; mounting has no side effects.
export function apply() {}
