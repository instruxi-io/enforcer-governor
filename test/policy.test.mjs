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
// The whole promise of the spend control is "$20 means $20". These asserts
// fail the moment the price table or the conversion drifts.
import { tokensForDollars, dollarsForTokens } from '../src/policy.mjs';

assert(tokensForDollars(20, 5) === 4_000_000, '$20 at $5/Mtok is 4M effective tokens');
assert(tokensForDollars(20, 1) === 20_000_000, '$20 at $1/Mtok is 20M effective tokens');
assert(Math.abs(dollarsForTokens(4_000_000, 5) - 20) < 1e-9, 'and back again');
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

// ── Cross-provider pricing ────────────────────────────────────────────────
// The old code assumed output is always 5x input. That is true of every
// Anthropic model and true of NO OpenAI model, so a flat 5x mis-billed every
// GPT agent. These asserts pin the real ratios to the published prices.
import { MODELS, priceOf, weightsFor } from '../src/policy.mjs';

for (const [k, m] of Object.entries(MODELS)) {
  assert(m.in > 0 && m.out > 0, `${k} needs real prices`);
  if (m.p === 'anthropic') {
    assert.equal(m.out / m.in, 5, `${k}: Anthropic output is 5x input`);
  }
}
// Ratios verified against the OpenAI pricing page.
assert.equal(weightsFor('gpt-5.6-sol').out, 6, 'gpt-5.6 output is 6x input');
assert.equal(weightsFor('gpt-5').out, 8, 'gpt-5 output is 8x input');
assert.equal(weightsFor('gpt-4o').out, 4, 'gpt-4o output is 4x input');
assert.equal(weightsFor('claude-opus-5').out, 5, 'Claude output is 5x input');

// Longest-match wins, or 'gpt-5.6-sol' would resolve to plain 'gpt-5'.
assert.equal(priceOf('gpt-5.6-sol').key, 'gpt-5.6-sol', 'specific model beats prefix');
assert.equal(priceOf('gpt-5-mini-2026').key, 'gpt-5-mini', 'dated suffix still matches');
assert.equal(priceOf('claude-sonnet-4-6-20260101').key, 'claude-sonnet-4-6', 'dated Claude matches');
// Unknown models must not silently price as something cheap.
assert.equal(priceOf('gpt-9-unreleased').p, 'openai', 'unknown GPT stays on OpenAI pricing');
assert.equal(priceOf('').key, 'claude-opus-5', 'no model reported falls back to the default');

// $20 buys the right number of effective tokens on each provider.
assert.equal(tokensForDollars(20, priceOf('claude-opus-5').in), 4_000_000);
assert.equal(tokensForDollars(20, priceOf('gpt-5').in), 16_000_000);
assert.equal(tokensForDollars(20, priceOf('gpt-4o').in), 8_000_000);
console.log('  cross-provider pricing ok');
