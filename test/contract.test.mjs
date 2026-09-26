// The Claude Code adapter runs the harness contract (core/test/contract.mjs):
// the same checks every adapter must pass, driven through the real hook the
// way Claude Code drives it -- hook JSON on stdin, a permission decision out.
// `node test/contract.test.mjs`.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runContract, ContractError } from '../core/test/contract.mjs';

const HOOK = new URL('../hooks/pre-tool-use.mjs', import.meta.url).pathname;

// One Bash call through hooks/pre-tool-use.mjs, read back into the contract's
// terms. Claude Code has no separate "rewrite" answer: the hook asks, carrying
// updatedInput, so the person confirms the form that will actually run. That
// is a rewrite as far as the contract is concerned -- the rewritten input is
// what runs.
function run(command, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => {
      let j;
      try { j = JSON.parse(out); } catch { return reject(new Error(`the hook printed no JSON: ${out}`)); }
      const h = j.hookSpecificOutput || {};
      const said = [j.systemMessage, h.permissionDecisionReason].filter(Boolean).join(' ');
      if (h.updatedInput) return resolve({ decision: 'rewrite', input: h.updatedInput, said });
      if (h.permissionDecision === 'deny' || h.permissionDecision === 'ask' || h.permissionDecision === 'allow') {
        return resolve({ decision: h.permissionDecision, said });
      }
      resolve({ decision: 'pass', said });
    });
    p.stdin.end(JSON.stringify({ session_id: 'contract1', tool_name: 'Bash', tool_input: { command }, cwd: '/work/acme' }));
  });
}

// The contract has to be able to FAIL: an adapter that loses a refusal, or
// that claims its harness cannot rewrite and then rewrites anyway, is caught.
const tmp = mkdtempSync(join(tmpdir(), 'gov-contract-'));
const quiet = { tmp, log: () => {} };
const broken = [
  ['an adapter that turns a refusal into no opinion',
    { harness: 'claude-code', run: async (c, e) => { const o = await run(c, e); return o.decision === 'deny' ? { decision: 'pass' } : o; } }],
  ['an adapter whose harness cannot ask, passing an ask through',
    { harness: 'claude-code', canAsk: false, run }],
  ['an adapter whose harness cannot rewrite, passing a rewrite through',
    { harness: 'claude-code', canRewrite: false, run }],
  ['an adapter stamping the wrong harness', { harness: 'codex', run }],
];
for (const [what, adapter] of broken) {
  let caught = null;
  try { await runContract(adapter, quiet); } catch (e) { caught = e; }
  if (!(caught instanceof ContractError)) { console.error(`FAIL: the contract passed ${what}${caught ? `: ${caught}` : ''}`); process.exit(1); }
}
console.log('  ok  the contract rejects adapters that break it');

const kept = await runContract({ harness: 'claude-code', canAsk: true, canRewrite: true, run },
  { tmp });
console.log(`\n  claude-code keeps the harness contract (${kept.length} groups)`);
