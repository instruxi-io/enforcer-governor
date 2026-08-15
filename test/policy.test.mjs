// One runnable check for the brain. `node test/policy.test.mjs`.
// No framework: asserts that fail throw and exit non-zero.
import assert from 'node:assert/strict';
import { makeState, decide, resolve, kill, verifyChain } from '../src/policy.mjs';

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

ok('allows within budget', () => {
  const s = makeState();
  const r = decide(s, { agent: 'a', tokens: 1000, action: 'read x' }, { budget: 100000 });
  assert.equal(r.verdict, 'allow');
});

ok('denies at hard budget', () => {
  const s = makeState();
  const r = decide(s, { agent: 'a', tokens: 100000, action: 'read x' }, { budget: 100000, soft: 0.75 });
  assert.equal(r.verdict, 'deny');
  assert.match(r.reason, /budget/);
});

ok('escalates at soft cap', () => {
  const s = makeState();
  const r = decide(s, { agent: 'a', tokens: 80000, action: 'read x' }, { budget: 100000, soft: 0.75, softAction: 'escalate' });
  assert.equal(r.verdict, 'escalate');
});

ok('soft cap auto-deny mode blocks instead', () => {
  const s = makeState();
  const r = decide(s, { agent: 'a', tokens: 80000, action: 'read x' }, { budget: 100000, soft: 0.75, softAction: 'deny' });
  assert.equal(r.verdict, 'deny');
});

ok('detects a loop and grounds the agent', () => {
  const s = makeState();
  const verdicts = [];
  for (let i = 0; i < 5; i++) verdicts.push(decide(s, { agent: 'loopy', tokens: 1000 + i, action: 'GET /same' }, { loopLimit: 4, budget: 1e9 }));
  const loopDeny = verdicts.find(v => /waste/.test(v.reason));
  assert.ok(loopDeny, 'a loop-block receipt should exist');
  assert.equal(loopDeny.verdict, 'deny');
  // once grounded, every later call is denied
  const next = decide(s, { agent: 'loopy', tokens: 9999, action: 'GET /other' }, { budget: 1e9 });
  assert.equal(next.verdict, 'deny');
  assert.match(next.reason, /grounded/);
});

ok('varied actions do NOT trip the loop guard', () => {
  const s = makeState();
  let last;
  for (let i = 0; i < 6; i++) last = decide(s, { agent: 'busy', tokens: 1000 + i, action: 'step ' + i }, { loopLimit: 4, budget: 1e9 });
  assert.equal(last.verdict, 'allow');
});

ok('kill switch grounds immediately with a human receipt', () => {
  const s = makeState();
  decide(s, { agent: 'a', tokens: 1000, action: 'x' }, {});
  const r = kill(s, 'a');
  assert.equal(r.verdict, 'deny');
  assert.equal(r.entry.authority, 'human');
});

ok('approve raises budget and resumes', () => {
  const s = makeState();
  decide(s, { agent: 'a', tokens: 80000, action: 'x' }, { budget: 100000, soft: 0.75 });
  const r = resolve(s, 'a', true, { budget: 100000 });
  assert.equal(r.verdict, 'allow');
  assert.equal(s.agents['a'].status, 'active');
  assert.ok(s.agents['a'].budget > 100000);
});

ok('receipt chain verifies, and tampering breaks it', () => {
  const s = makeState();
  for (let i = 0; i < 10; i++) decide(s, { agent: 'a', tokens: 1000 + i, action: 'step ' + i }, { budget: 1e9 });
  assert.equal(verifyChain(s), true);
  s.chain[3].json = s.chain[3].json.replace('allow', 'deny'); // forge a decision
  assert.equal(verifyChain(s), false);
});

console.log(`\n${pass} checks passed.`);

// ── Dollar budgets ─────────────────────────────────────────────────────────
// The whole promise of the spend control is "$20 means $20". These four
// asserts fail the moment the rate table or the conversion drifts.
import { RATES, tokensForDollars, dollarsForTokens, rateFor } from '../src/policy.mjs';

// Every model prices output at exactly 5x input, which is why one
// effective token (output weighted 5x) equals one input-token of cost.
for (const [k, r] of Object.entries(RATES)) {
  assert(r.perM > 0, `rate for ${k} must be positive`);
}
assert(tokensForDollars(20, RATES.opus.perM) === 4_000_000, '$20 of Opus is 4M effective tokens');
assert(tokensForDollars(20, RATES.haiku.perM) === 20_000_000, '$20 of Haiku is 20M effective tokens');
assert(Math.abs(dollarsForTokens(4_000_000, RATES.opus.perM) - 20) < 1e-9, '4M Opus tokens is $20');
assert(rateFor('claude-sonnet-4-5') === 'sonnet', 'model string maps to its rate');
assert(rateFor('') === 'opus', 'unknown model falls back to the priciest rate');
console.log('  dollar budget conversion ok');

// ── Loop detection catches alternating loops, not just back-to-back ────────
// A stuck agent usually ping-pongs between two actions. A consecutive-streak
// check never fires on that, which let a loop burn the whole budget.
{
  let s = makeState(), v;
  for (let i = 0; i < 12; i++) {
    v = decide(s, { agent: 'ab', deltaTokens: 100, action: i % 2 ? 'Read:x' : 'Edit:x' });
    if (v.verdict === 'deny') break;
  }
  assert(v.verdict === 'deny', 'alternating A-B-A-B loop is caught');
}
{
  // Genuine varied work must still pass -- the guard is worthless if it
  // grounds an agent doing its job.
  let s = makeState(), v;
  const work = ['Read:a', 'Edit:b', 'Bash:test', 'Read:c', 'Edit:d', 'Grep:e', 'Read:f', 'Write:g'];
  for (const act of work) v = decide(s, { agent: 'ok', deltaTokens: 100, action: act });
  assert(v.verdict === 'allow', 'varied real work is not mistaken for a loop');
}
console.log('  alternating-loop detection ok');
