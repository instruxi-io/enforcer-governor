// degrade() (core/degrade.mjs): what an ask or a rewrite becomes in a harness
// that cannot show it. `node test/degrade.test.mjs`.
//
// The promise pinned here is the one plan section 3.4 makes to every adapter:
// an answer the harness cannot give becomes a refusal, never a pass, and a
// refused rewrite names the safer form so the agent can run that instead.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gov-degrade-'));
process.env.GOVERNOR_HOME = home; process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;

const { degrade, Verdict, DEFAULT_RULES } = await import('../core/index.mjs');
const { evaluate } = await import('../core/capability.mjs');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

// Real verdicts from the default rules, as a harness's shell tool would get them.
const shell = (command, raw = { command, timeout: 30 }) =>
  evaluate(DEFAULT_RULES, { tool: 'shell', name: 'run', action: `run:${command}`, input: { command }, raw, fields: { command: 'command' } });
const DELETE = 'rm -' + 'rf ./build';
const FORCE = 'git push ' + '--force origin main';

ok('a harness that can do both gets the verdict back untouched', () => {
  for (const v of [shell(DELETE), shell(FORCE), Verdict.allow('in budget'), Verdict.deny('no')]) {
    const out = degrade(v, { canAsk: true, canRewrite: true });
    assert.equal(out.verdict, v);
    assert.equal(out.degraded, null);
  }
  // The defaults are "can": an adapter that says nothing is not degraded.
  assert.equal(degrade(shell(DELETE)).verdict.action, 'ask');
});

ok('an ask with no way to ask is refused, keeping who decided it', () => {
  const v = shell(DELETE);
  assert.equal(v.action, 'ask');
  const { verdict, degraded } = degrade(v, { canAsk: false });
  assert.equal(degraded, 'ask');
  assert.equal(verdict.action, 'deny');
  assert.equal(verdict.source, v.source);
  assert.equal(verdict.rule, v.rule);
  assert.deepEqual(verdict.checked, v.checked);
  assert.ok(verdict.isCapability && !verdict.stopsAgent, 'a capability refusal refuses the action, not the agent');
  assert.match(verdict.reason, /^would delete a whole tree/);
  assert.match(verdict.reason, /no way to ask/);
});

ok('a spend ask with no way to ask is refused as a spend refusal', () => {
  const v = Verdict.ask('it hit 6 errors in a minute', { source: 'economics', checked: ['capability', 'economics'] });
  const { verdict } = degrade(v, { canAsk: false });
  assert.equal(verdict.action, 'deny');
  assert.equal(verdict.source, 'economics');
});

ok('a rewrite with no way to rewrite is refused, naming the safer form', () => {
  const raw = { command: FORCE, description: 'publish the branch', timeout: 30 };
  const v = shell(FORCE, raw);
  assert.equal(v.action, 'rewrite');
  const { verdict, degraded } = degrade(v, { canRewrite: false, raw });
  assert.equal(degraded, 'rewrite');
  assert.equal(verdict.action, 'deny');
  assert.equal(verdict.input, null, 'a refusal carries no input to run');
  assert.ok(verdict.reason.includes('`git push --force-with-lease origin main`'), verdict.reason);
  assert.ok(!verdict.reason.includes('publish the branch'), 'only what changed is named');
});

ok('a rewrite is refused even when the safer form cannot be named', () => {
  const v = Verdict.rewrite({ n: 2 }, 'narrowed', { source: 'capability', rule: 'x' });
  const { verdict } = degrade(v, { canRewrite: false });
  assert.equal(verdict.action, 'deny');
  assert.equal(verdict.reason, 'narrowed');
});

ok('an ask is not degraded by a missing rewrite, nor a rewrite by a missing ask', () => {
  assert.equal(degrade(shell(DELETE), { canRewrite: false }).verdict.action, 'ask');
  assert.equal(degrade(shell(FORCE), { canAsk: false }).verdict.action, 'rewrite');
});

console.log(`\n  ${pass} passed`);
