// DSH 0.2 obtains settings metadata from Config and never calls register().
import assert from 'node:assert/strict';
import { apply, Config, QqModeSchema, QQMODE_NAMESPACE } from '../plugins/qq-mode-console/lib/index.js';
assert.equal(QQMODE_NAMESPACE, 'qq-mode');
apply(new Proxy({}, { get() { throw new Error('apply must have no runtime effects'); } }));
for (const mode of ['chat','closed-agent','reserved','reserved2','simulation']) {
  assert.equal(Config({mode,ownerQQ:'123456789'}).mode, mode);
  assert.equal(QqModeSchema({mode}).mode, mode);
}
assert.equal(Config({}).mode,'reserved2');
assert.equal(Config.dict.mode.meta.volatile,true);
assert.equal(Config.dict.ownerQQ.meta.volatile,true);
assert.throws(() => Config({mode:'bogus'}));
assert.throws(() => QqModeSchema({mode:'bogus'}));
console.log('QQ mode: Config/volatile settings preserved; mounting has no removed-API dependency');
