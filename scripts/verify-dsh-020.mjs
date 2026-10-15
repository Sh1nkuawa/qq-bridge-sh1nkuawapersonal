// Local-only smoke checks. No prompts, QQ sends, or existing-session mutations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = option('--base', 'http://127.0.0.1:3080');
const log = option('--startup-log', 'D:/dsh/dsh-web.out.log');
const token = fs.readFileSync(log, 'utf8').match(/dsh web: (http\S+)/)?.[1];
if (!token) throw new Error('Startup URL not found in the supplied log');
const api = new NodeApiClient(base, 15000, { token: new URL(token).searchParams.get('token') });
const call = async (method, payload = {}) => unwrap(await api.callUnary(method, payload), method);
const presets = await call('agentPresets/list');
for (const id of ['qq-chat', 'qq-chat-v2']) assert.ok(presets.presets.some((p) => p.id === id), `Missing ${id}`);
console.log('PASS QQ chat presets available');
const described = await call('settings/describe');
const rows = Array.isArray(described) ? described : described.namespaces ?? described.sections ?? described.settings ?? described.entries;
assert.ok(Array.isArray(rows), 'Unexpected settings descriptor shape: ' + Object.keys(described));
assert.ok(rows.some((r) => r.ns === 'qq-mode'), 'QQ mode settings missing');
assert.ok(rows.some((r) => r.ns === 'dsh-at-file'), 'File-reference editable settings missing');
console.log('PASS QQ mode and file-reference settings metadata');
const before = await call('atFile/getSettings');
assert.equal(typeof before.enabled, 'boolean');
if (!args.includes('--read-only')) {
  const saved = await call('atFile/updateSettings', { update: { field: 'enabled', value: before.enabled } });
  assert.deepEqual(saved, before);
  console.log('PASS file-reference settings write/read retains all values');
}
const listed = await call('session/list');
assert.ok(Array.isArray(listed.items), 'Session list unavailable');
console.log('PASS session list: ' + listed.items.length);
if (!args.includes('--read-only')) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-020-smoke-'));
  fs.writeFileSync(path.join(cwd, 'upgrade-smoke.txt'), 'Local upgrade verification fixture.\n');
  const workspace = await call('workspace/create', { path: cwd });
  const created = await call('session/create', { workspaceId: workspace.workspace.workspaceId, agentPreset: 'qq-chat-v2' });
  const sessionId = created.sessionId;
  try {
    const queue = await api._readSessionQueue(sessionId, AbortSignal.timeout(15000));
    assert.deepEqual(queue, []);
    console.log('PASS real session/projections inbox read (no Agent prompt)');
    const files = await call('atFile/search', { agentId: sessionId });
    assert.ok(files.some((file) => file.relative === 'upgrade-smoke.txt' || file.path === 'upgrade-smoke.txt'), 'File picker omitted fixture');
    console.log('PASS file-reference workspace search');
    assert.deepEqual(await api.stopSessionWork(sessionId), { removed: 0 });
    console.log('PASS safe retirement of own empty verification session');
  } finally {
    await call('workspace/archiveSession', { sessionId });
  }
}
console.log('DSH local smoke checks complete; no user messages sent');
