// The knobs, and the validation that stops a silent misconfiguration.
import assert from 'node:assert/strict';
import { SETTINGS, RETIRED, GROUPS, validate, parseValue } from '../src/settings.mjs';
import { DEFAULTS } from '../src/policy.mjs';

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

ok('every described setting is one the policy actually reads', () => {
  for (const k of Object.keys(SETTINGS)) {
    assert.ok(k in DEFAULTS, `${k} is described but not in DEFAULTS`);
  }
});

ok('every setting belongs to a real group', () => {
  for (const [k, s] of Object.entries(SETTINGS)) {
    assert.ok(GROUPS.includes(s.group), `${k} has group ${s.group}`);
    assert.ok(s.describe && s.describe.length > 10, `${k} needs a description`);
  }
});

ok('retired settings are named, not silently accepted', () => {
  // Absorbing a value for something wired to nothing is how you get a config
  // that looks configured and does nothing.
  for (const k of Object.keys(RETIRED)) {
    assert.match(validate(k, 'anything'), /retired/);
  }
});

ok('the fraction/percent confusion is refused', () => {
  // soft: 75 instead of 0.75 means the warn never fires, and nothing says so.
  assert.match(validate('soft', 75), /between/);
  assert.equal(validate('soft', 0.75), null);
});

ok('nonsense is refused rather than absorbed', () => {
  assert.match(validate('dollars', 'lots'), /not a number/);
  assert.match(validate('dollars', -5), /between/);
  assert.match(validate('softAction', 'maybe'), /expected one of/);
  assert.match(validate('budgetOn', 'sometimes'), /expected true or false/);
});

ok('a near miss suggests the real name', () => {
  assert.match(validate('dailylimit', 5), /Did you mean dailyLimit/);
  assert.match(validate('burnlimit', 5), /Did you mean burnLimit/);
});

ok('an unknown setting is refused outright', () => {
  assert.match(validate('nonsense', 1), /no setting called/);
});

ok('values parse to the right type', () => {
  assert.equal(parseValue(SETTINGS.budgetOn, 'off'), false);
  assert.equal(parseValue(SETTINGS.budgetOn, 'yes'), true);
  assert.equal(parseValue(SETTINGS.dollars, '40'), 40);
  assert.equal(parseValue(SETTINGS.softAction, 'deny'), 'deny');
});

ok('0 is allowed where 0 means off', () => {
  for (const k of ['dailyLimit', 'weeklyLimit', 'monthlyLimit', 'burnLimit', 'fanoutLimit', 'retryLimit']) {
    assert.equal(validate(k, 0), null, `${k} must accept 0 as "off"`);
  }
});

console.log(`\n  ${pass} passed`);
