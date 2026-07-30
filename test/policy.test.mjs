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
  const loopDeny = verdicts.find(v => /identical/.test(v.reason));
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
