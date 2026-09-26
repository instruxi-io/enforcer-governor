// createGovernor() as a non-Claude adapter would drive it: no hooks, no
// transcript, just events in and verdicts out, with a stub cost source.
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gov-api-'));
process.env.GOVERNOR_HOME = home; process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;

const { createGovernor, NO_COST, verify, ALLOW, ASK, DENY, REWRITE } = await import('../core/index.mjs');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
const ok = (m) => console.log(m + ' ok');
const receipts = () => readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

// A harness that reports spend per call, in tokens, on a model we price.
let tokens = 0;
const cost = {
  read: () => ({ tokens, model: 'claude-sonnet-5', usd: null, source: 'stub' }),
  total: () => ({ tokens, model: 'claude-sonnet-5', usd: 1.25, source: 'stub' }),
};
const gov = createGovernor({ harness: 'test-harness', cost });
assert(gov.harness === 'test-harness', 'the harness name is kept');
const ev = (tool, action, extra = {}) => ({ agent: 'h:1', tool, action: `${tool}:${action}`, input: {}, cwd: '/w/acme', ...extra });

let r = await gov.before(ev('Read', '/w/acme/a.ts'));
assert(r.verdict.action === ALLOW, `ordinary work passes, got ${r.verdict.action}`);
r = await gov.before(ev('Bash', 'rm -' + 'rf ./build'));
assert(r.verdict.action === ASK && r.verdict.isCapability, 'a rule asks, before any spend check');
r = await gov.before(ev('Bash', 'git push ' + '--force origin main', { input: { command: 'git push ' + '--force origin main' } }));
assert(r.verdict.action === REWRITE && /force-with-lease/.test(r.verdict.input.command), 'a rule rewrites, and hands back the safer input');
ok('rules decide the same through the API as through the hook');

tokens = 1e12; // far past $20 at any price
r = await gov.before(ev('Read', '/w/acme/b.ts'));
assert(r.verdict.action === DENY && r.verdict.stopsAgent, `spend from the cost source stops the agent, got ${r.verdict.action}`);
assert(r.spend.tokens >= 1e12 && r.spend.budget > 0, 'before() reports spend and budget for the adapter to word');
ok('the cost source feeds the spend check');

gov.after({ agent: 'h:1' }, { failed: true });
gov.spawned('h:2');
const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
assert(st.agents['h:1'].fails.length === 1 && st.spawns.some(s => s.id === 'h:2'), 'after() and spawned() feed the rate checks');
ok('after() and spawned() are recorded');

gov.session.end({ agent: 'h:1' });
const all = receipts();
const summary = all.at(-1);
assert(summary.verdict === 'summary' && summary.cost_usd === 1.25 && summary.meter === 'stub', 'session.end() writes the harness figure as cost_usd and names its source');
assert(all.filter(x => x.verdict !== 'summary').every(x => x.client === '?acme' && x.meter === 'stub'), 'every decision receipt names the project and the meter');
const v = verify(join(home, 'receipts.jsonl'));
assert(v.ok && v.receipts === all.length, `the chain verifies across API calls (${JSON.stringify(v)})`);
ok('session.end() closes a chain that verifies');

const bare = createGovernor();
assert(bare.harness === 'unknown' && NO_COST.read().source === 'none', 'a harness with no cost source still works');
ok('defaults');
