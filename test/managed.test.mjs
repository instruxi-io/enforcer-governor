// The managed floor. The merge is the whole risk here: a rule that picked the
// wrong direction would let a tenant's published setting LOOSEN a machine's own
// configuration, which is the opposite of what publishing one is for.
import assert from 'node:assert/strict';
import { merge, managedKeys, refresh } from '../src/managed.mjs';

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };
const okAsync = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };

ok('a tenant cap tightens a looser local one, and never the reverse', () => {
  assert.equal(merge({ dollars: 400 }, { dollars: 150 }).dollars, 150);
  assert.equal(merge({ dollars: 40 }, { dollars: 150 }).dollars, 40);
});

ok('0 means "no cap" on both sides, not "no spending"', () => {
  // dailyLimit 0 is how the plugin spells "off". Treating it as the smaller
  // number would ground every agent in the tenant instantly.
  assert.equal(merge({ dailyLimit: 0 }, { dailyLimit: 400 }).dailyLimit, 400);
  assert.equal(merge({ dailyLimit: 400 }, { dailyLimit: 0 }).dailyLimit, 400);
});

ok('a check the organisation turns on cannot be turned off locally', () => {
  assert.equal(merge({ rulesOn: false }, { rulesOn: true }).rulesOn, true);
  assert.equal(merge({ budgetOn: false }, { budgetOn: true }).budgetOn, true);
  // ...and one it leaves off does not force it off: local may still be stricter.
  assert.equal(merge({ rulesOn: true }, { rulesOn: false }).rulesOn, true);
});

ok('the stricter soft mark and the stricter soft action win', () => {
  assert.equal(merge({ soft: 0.9 }, { soft: 0.75 }).soft, 0.75);
  assert.equal(merge({ softAction: 'escalate' }, { softAction: 'deny' }).softAction, 'deny');
  assert.equal(merge({ softAction: 'deny' }, { softAction: 'escalate' }).softAction, 'deny');
});

ok('a setting with no stricter direction is not merged at all', () => {
  // The API refuses these, but a compromised or future server could send them;
  // the merge is the second place that must not act on one.
  const out = merge({ centralUrl: 'https://api.instruxi.dev', operator: 'me', clients: {} },
    { centralUrl: 'https://elsewhere.example', operator: 'someone', clients: { '/x': 'y' }, sweepDays: 99 });
  assert.equal(out.centralUrl, 'https://api.instruxi.dev');
  assert.equal(out.operator, 'me');
  assert.deepEqual(out.clients, {});
  assert.equal(out.sweepDays, undefined);
});

ok('nothing managed is a no-op, not a reset', () => {
  const local = { dollars: 150, rulesOn: false, model: 'claude-opus-5' };
  assert.deepEqual(merge(local, {}), local);
  assert.deepEqual(merge(local, null), local);
  assert.deepEqual(managedKeys({ dollars: 1, nonsense: 2 }), ['dollars']);
});

await okAsync('an unreachable control plane leaves the machine on its own config', async () => {
  const r = await refresh({}, { fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 10 });
  assert.equal(r.ok, false);
  assert.ok(r.detail, 'a failure must say why');
});

await okAsync('a refusal is not treated as an empty floor', async () => {
  const r = await refresh({}, { fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /403|signed in/);
});

console.log(`\n  ${pass} passed`);
