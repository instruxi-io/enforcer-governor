// core/ as the package @instruxi-io/governor-core: that what would be
// published is complete on its own, and that the plugin still runs exactly as
// before with the package living inside it. `node test/package.test.mjs`.
//
// Nothing here publishes. `npm pack --dry-run` lists what a publish WOULD
// contain, and that list is checked for a file reaching outside it -- which
// is how the shipper bug below was found: kick() started ../bin/ship.mjs, a
// file only the plugin has.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE = join(ROOT, 'core');
const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));

let pass = 0;
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };

await ok('the manifest names the package, its licence and its runtime', () => {
  assert.equal(pkg.name, '@instruxi-io/governor-core');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'FSL-1.1-ALv2');
  assert.equal(pkg.license, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license, 'the same licence as the plugin');
  assert.ok(pkg.engines?.node, 'engines.node is declared');
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version));
  assert.equal(pkg.dependencies, undefined, 'the core has no dependencies');
  assert.ok(existsSync(join(ROOT, 'LICENSE')), 'prepack copies the repo LICENSE, which must exist');
});

// What a publish would contain. --ignore-scripts: the listing must not write
// the LICENSE copy into the working tree (prepack does that at publish time).
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: CORE, encoding: 'utf8' }))[0]
  .files.map((f) => f.path);

await ok('the packed files are the core, its shipper and the contract -- no plugin, no tests', () => {
  for (const f of ['index.mjs', 'governor.mjs', 'tools.mjs', 'bin/ship.mjs', 'test/contract.mjs', 'package.json']) assert.ok(packed.includes(f), `${f} is packed`);
  assert.ok(packed.every((f) => !f.startsWith('..') && !/^(hooks|adapters|commands|statusline)\//.test(f)), packed.join(', '));
  assert.deepEqual(packed.filter((f) => f.startsWith('test/')), ['test/contract.mjs']);
});

await ok('nothing packed reaches a file that is not packed', () => {
  const IMPORT = /(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;
  const missing = [];
  for (const f of packed.filter((p) => p.endsWith('.mjs'))) {
    for (const m of readFileSync(join(CORE, f), 'utf8').matchAll(IMPORT)) {
      const target = relative(CORE, resolve(CORE, dirname(f), m[1] || m[2] || m[3]));
      if (!packed.includes(target)) missing.push(`${f} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

await ok('the default shipper is the core\'s own; the Claude Code plugin keeps the plugin\'s', async () => {
  const { SHIPPER } = await import('../core/ship.mjs');
  assert.equal(relative(CORE, SHIPPER), join('bin', 'ship.mjs'));
  assert.ok(packed.includes('bin/ship.mjs'));
  const { createGovernor } = await import('../core/index.mjs');
  assert.equal(createGovernor().shipper, SHIPPER);
  // Unchanged for Claude Code: the hooks start <plugin>/bin/ship.mjs, as before.
  const { governor } = await import('../adapters/claude-code/index.mjs');
  assert.equal(governor().shipper, join(ROOT, 'bin', 'ship.mjs'));
});

await ok('the core\'s shipper runs on its own', () => {
  const home = mkdtempSync(join(tmpdir(), 'gov-pkg-ship-'));
  const env = { ...process.env, HOME: home, GOVERNOR_HOME: join(home, 'g'), ENFORCER_HOME: join(home, 'e') };
  delete env.ENFORCER_API_KEY;
  const out = execFileSync(process.execPath, [join(CORE, 'bin', 'ship.mjs'), '--print'], { env, encoding: 'utf8' });
  assert.match(out, /Not shipped: not signed in to Enforcer/);
});

await ok('it resolves by its package name, through its exports', () => {
  // A consumer's node_modules with the package linked in, as an install would.
  const app = mkdtempSync(join(tmpdir(), 'gov-pkg-app-'));
  mkdirSync(join(app, 'node_modules', '@instruxi-io'), { recursive: true });
  symlinkSync(CORE, join(app, 'node_modules', '@instruxi-io', 'governor-core'), 'dir');
  writeFileSync(join(app, 'probe.mjs'), `
    const core = await import('@instruxi-io/governor-core');
    const { runContract } = await import('@instruxi-io/governor-core/contract');
    const { toolMatches } = await import('@instruxi-io/governor-core/tools');
    let report = 'exported';
    try { await import('@instruxi-io/governor-core/report'); } catch (e) { report = e.code; }
    console.log(JSON.stringify({ api: typeof core.createGovernor, contract: typeof runContract, tools: typeof toolMatches, report }));
  `);
  const home = mkdtempSync(join(tmpdir(), 'gov-pkg-home-'));
  const out = JSON.parse(execFileSync(process.execPath, [join(app, 'probe.mjs')], { cwd: app, env: { ...process.env, GOVERNOR_HOME: home }, encoding: 'utf8' }));
  assert.deepEqual(out, { api: 'function', contract: 'function', tools: 'function', report: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    'the API, the contract and the modules resolve; the plugin report CLI is not an export');
});

console.log(`\n  ${pass} passed`);
