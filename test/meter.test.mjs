// Where the cost figure comes from. `node test/meter.test.mjs`.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-meter-'));
process.env.HOME = home; process.env.USERPROFILE = home;
mkdirSync(join(home, '.enforcer-governor'), { recursive: true });

const { read, recordHarnessCost, HARNESS, TRANSCRIPT } = await import('../src/meter.mjs');
const dir = join(home, '.enforcer-governor');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

ok('falls back to the transcript when the harness has said nothing', () => {
  assert.equal(read('none', null).source, TRANSCRIPT);
});

ok('prefers the harness figure once the status line records one', () => {
  recordHarnessCost('s1', { total_cost_usd: 7.4 });
  const r = read('s1', null, { model: 'claude-opus-5' });
  assert.equal(r.source, HARNESS);
  assert.equal(r.usd, 7.4);
  assert.equal(r.tokens, 1480000);   // $7.40 at $5/MTok input
});

ok('ignores a stale harness figure rather than trusting it', () => {
  // A status line that has not drawn for a long time is not evidence of
  // current spend, and a silently stale number is worse than live arithmetic.
  writeFileSync(join(dir, 'cost-s2.json'),
    JSON.stringify({ usd: 99, at: Date.now() - 60 * 60 * 1000 }));
  assert.equal(read('s2', null).source, TRANSCRIPT);
});

ok('rejects a nonsense cost instead of poisoning the budget', () => {
  // NaN is the worst case: every comparison against the budget silently
  // evaluates false and the agent is never stopped at all.
  for (const bad of [NaN, Infinity, -1, 'free', null, undefined]) {
    assert.equal(recordHarnessCost('s3', { total_cost_usd: bad }), false, String(bad));
  }
  assert.equal(read('s3', null).source, TRANSCRIPT);
});

ok('a missing cost block is not an error', () => {
  assert.equal(recordHarnessCost('s4', undefined), false);
  assert.equal(recordHarnessCost('s4', {}), false);
});

console.log(`\n  ${pass} passed`);
