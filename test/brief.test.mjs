// What the agent gets told, and — mostly — that it does not.
import assert from 'node:assert/strict';
import { brief, markTold } from '../src/brief.mjs';

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };
const cfg = { budgetOn: true, loopOn: true, soft: 0.75, loopLimit: 4 };
const agent = (over) => ({ tokens: 0, budget: 1000, loopStreak: 0, status: 'active', ...over });

ok('says nothing on an ordinary call', () => {
  assert.equal(brief(agent({ tokens: 100 }), cfg), null);
});

ok('warns early enough to be actionable', () => {
  // At the soft mark the turn is usually already committed; ~64% is where
  // changing approach still changes the outcome.
  const b = brief(agent({ tokens: 650 }), cfg);
  assert.ok(b && /prefer finishing/i.test(b.text));
  assert.equal(b.situation, 'approaching');
});

ok('escalates the wording past the soft mark', () => {
  const b = brief(agent({ tokens: 800 }), cfg);
  assert.equal(b.situation, 'near-limit');
  assert.match(b.text, /wrap up/i);
});

ok('says it once, then goes quiet', () => {
  const a = agent({ tokens: 800 });
  const first = brief(a, cfg);
  markTold(a, first.situation);
  assert.equal(brief(a, cfg), null, 'a repeated warning stops being read and costs more each time');
});

ok('speaks again when the situation changes', () => {
  const a = agent({ tokens: 650 });
  markTold(a, brief(a, cfg).situation);
  a.tokens = 800;
  assert.equal(brief(a, cfg).situation, 'near-limit');
});

ok('warns about a loop before blocking it', () => {
  const b = brief(agent({ loopStreak: 3 }), cfg);
  assert.equal(b.situation, 'repeating');
  assert.match(b.text, /change approach/i);
});

ok('stays silent when the budget check is off', () => {
  assert.equal(brief(agent({ tokens: 990 }), { ...cfg, budgetOn: false }), null);
});

ok('every line is one sentence', () => {
  // Each word joins the cached prefix and is billed on every later turn.
  for (const tokens of [650, 800]) {
    const b = brief(agent({ tokens }), cfg);
    assert.ok(b.text.length < 200, `too long: ${b.text.length}`);
  }
});

console.log(`\n  ${pass} passed`);
