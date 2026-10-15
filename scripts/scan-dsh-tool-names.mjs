// Compare real package tool registrations with the QQ preset's restriction list.
import { collectDshToolNames, isHostTool } from './dsh-tool-names.mjs';
import { RESTRICTED_TOOL_NAMES } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';

const { names, sources, scanned } = collectDshToolNames();
if (!scanned) throw new Error('No installed DSH packages were scanned; set DSH_TOOL_PACKAGES');
const guarded = new Set(RESTRICTED_TOOL_NAMES);
const missing = [...names].filter((n) => isHostTool(n) && !guarded.has(n));
// Optional historical tools stay blocked if their plugin is re-enabled.
const optional = new Set(['dsh_snapshot', 'dsh_rollback', 'incident_resolved']);
const stale = [...guarded].filter((n) => !n.startsWith('dev_') && !optional.has(n) && !names.has(n));
console.log(`Scanned ${scanned} files; ${names.size} tool names; ${guarded.size} restricted names`);
for (const name of missing.sort()) console.log(`MISSING ${name}: ${[...sources.get(name)].join(', ')}`);
for (const name of stale.sort()) console.log(`NOT FOUND ${name}`);
if (!missing.length && !stale.length) console.log('Tool inventory matches the QQ restrictions');
process.exitCode = missing.length || stale.length ? 1 : 0;
