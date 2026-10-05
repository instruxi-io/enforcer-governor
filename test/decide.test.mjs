// `governor decide` and the shim. Golden files in test/fixtures/decide are the
// verbatim output of the pre-2.10 hook (hooks/pre-tool-use.mjs at 2.9.0) for
// these events; the shim must reproduce it byte for byte, and the CLI must
// print the decision record that output carries.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('../', import.meta.url).pathname;
const fx = join(root, 'test/fixtures/decide');
let pass = 0;
const ok = (l, fn) => { fn(); pass++; console.log('  ok  ' + l); };

function run(script, args, ev) {
  const home = mkdtempSync(join(tmpdir(), 'dec-'));
  const env = { ...process.env, HOME: home, GOVERNOR_HOME: join(home, 'gov'), ENFORCER_HOME: join(home, 'e') };
  for (const k of ['JEV_HOOKS_HEADLESS', 'ENFORCER_HEADLESS', 'CLAUDE_CODE_ENTRYPOINT', 'ENFORCER_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ENFORCER_GRAPH_RUN_ID']) delete env[k];
  return spawnSync(process.execPath, [join(root, script), ...args], { env, encoding: 'utf8', input: JSON.stringify({ ...ev, cwd: home }) });
}

for (const f of readdirSync(fx).filter(n => n.endsWith('.event.json'))) {
  const name = f.replace('.event.json', '');
  const ev = JSON.parse(readFileSync(join(fx, f), 'utf8'));
  const golden = readFileSync(join(fx, name + '.out'), 'utf8');
  ok(`${name}: shim output is byte-identical to the 2.9.0 hook`, () => {
    assert.equal(run('hooks/pre-tool-use.mjs', [], ev).stdout, golden);
  });
  ok(`${name}: bin/governor decide prints the record the hook carried`, () => {
    const r = run('bin/governor', ['decide'], ev);
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(rec).slice(0, 5), ['decision', 'code', 'rule', 'tool', 'summary']);
    const reason = JSON.parse(golden).hookSpecificOutput.permissionDecisionReason;
    if (reason) assert.deepEqual(rec, JSON.parse(reason.split('\n')[0].slice('enforcer-governor:decision '.length)));
    else assert.equal(rec.decision, 'allow');
  });
}

ok('bin/governor rejects anything but `decide`', () => {
  assert.equal(spawnSync(process.execPath, [join(root, 'bin/governor'), 'nope'], { encoding: 'utf8' }).status, 2);
});

ok('lib/ names no Claude-only field or variable', () => {
  for (const f of readdirSync(join(root, 'lib'))) {
    const src = readFileSync(join(root, 'lib', f), 'utf8');
    assert.doesNotMatch(src, /permissionDecision|hookSpecificOutput|CLAUDE_/, f);
  }
});

ok('hooks/pre-tool-use.mjs is a shim under 60 lines', () => {
  assert.ok(readFileSync(join(root, 'hooks/pre-tool-use.mjs'), 'utf8').split('\n').length < 60);
});
console.log(`${pass} passed`);
