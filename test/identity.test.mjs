// Receipts name the signed-in person, and say what the agent had spent.
//
// The operator setting is empty on nearly every install, so receipts used to
// name nobody even when the install was signed in and knew whose credential it
// held. Now a signed-in install stamps the account's email, cached at session
// start (no network on the decision path), and only for the credential it was
// fetched with. Decision receipts also carry spent_usd.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gov-identity-'));
process.env.GOVERNOR_HOME = join(home, 'g');
process.env.ENFORCER_HOME = join(home, 'e');
delete process.env.ENFORCER_API_KEY;
mkdirSync(process.env.GOVERNOR_HOME, { recursive: true });
mkdirSync(process.env.ENFORCER_HOME, { recursive: true });

let meCalls = 0;
const srv = createServer((req, res) => {
  if (req.url === '/api/v1/enforcer/auth/me' && req.headers.authorization === 'Bearer at-1') {
    meCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, data: { account_id: 'acct-1', person: { primary_email: 'ada@acme.dev' } } }));
  }
  if (req.url.startsWith('/api/v1/governance/settings')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, data: { settings: {} } }));
  }
  res.writeHead(401); res.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const signIn = (clientId) => writeFileSync(join(process.env.ENFORCER_HOME, 'credentials.json'), JSON.stringify({
  enforcer: { base_url: base, oauth: { client_id: clientId, access_token: 'at-1', expires_at: '2999-01-01T00:00:00Z' } },
}));
const signOut = () => writeFileSync(join(process.env.ENFORCER_HOME, 'credentials.json'), JSON.stringify({ enforcer: {} }));
const setConfig = (c) => writeFileSync(join(process.env.GOVERNOR_HOME, 'config.json'), JSON.stringify({ shipOn: false, ...c }));

const { createGovernor, NO_COST } = await import('../core/index.mjs');
const { signedInOperator } = await import('../core/identity.mjs');
const receipts = () => readFileSync(join(process.env.GOVERNOR_HOME, 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

let tokens = 2_000_000;
const cost = { read: () => ({ tokens, model: 'claude-sonnet-5', usd: null, source: 'stub' }), total: () => ({ tokens, model: 'claude-sonnet-5', usd: 1.5, source: 'stub' }) };
const gov = createGovernor({ harness: 'test', cost });
const ev = (n) => ({ agent: 'h:1', kind: 'read', name: 'Read', tool: 'Read', action: `Read:/w/acme/${n}.ts`, input: {}, cwd: '/w/acme' });

let pass = 0;
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };

await ok('signed out: no operator, and nothing is fetched', async () => {
  signOut(); setConfig({});
  await gov.session.start();
  await gov.before(ev('a'));
  assert.equal(receipts().at(-1).operator, undefined);
  assert.equal(meCalls, 0, 'no sign-in, no lookup');
});

await ok('signed in: session start caches the account, and receipts name it', async () => {
  signIn('client-1');
  await gov.session.start();
  assert.equal(meCalls, 1);
  assert.equal(signedInOperator(), 'ada@acme.dev');
  await gov.before(ev('b'));
  assert.equal(receipts().at(-1).operator, 'ada@acme.dev');
});

await ok('the cache is reused, not re-fetched on every session start', async () => {
  await gov.session.start();
  assert.equal(meCalls, 1);
});

await ok('an explicit operator setting wins over the signed-in account', async () => {
  setConfig({ operator: 'ops@acme.dev' });
  await gov.before(ev('c'));
  assert.equal(receipts().at(-1).operator, 'ops@acme.dev');
  setConfig({});
});

await ok('a different sign-in does not inherit the previous person', async () => {
  signIn('client-2');
  assert.equal(signedInOperator(), '', 'the cache belongs to client-1');
  signOut();
  assert.equal(signedInOperator(), '', 'signed out names no one');
});

await ok('decision receipts carry spent_usd, the agent\'s spend in dollars when decided', async () => {
  signOut(); setConfig({});
  await gov.before(ev('d'));
  const r = receipts().at(-1);
  assert.equal(typeof r.spent_usd, 'number');
  assert.ok(r.spent_usd > 0, `spent_usd=${r.spent_usd}`);
  assert.equal(Object.keys(r).filter((k) => k !== 'hash').at(-1), 'spent_usd', 'it is the last field');
});

await ok('a harness that reports no spend gets no spent_usd (a zero would be invented)', async () => {
  const bare = createGovernor({ harness: 'bare', cost: NO_COST });
  await bare.before({ ...ev('e'), agent: 'h:2' });
  assert.equal(receipts().at(-1).spent_usd, undefined);
});

await ok('the summary receipt names the signed-in person too', async () => {
  // A fresh agent: h:1 was given an explicit operator above, which agent
  // state keeps, as it always has.
  signIn('client-1');
  await gov.before({ ...ev('f'), agent: 'h:3' });
  await gov.session.end({ agent: 'h:3' });
  const s = receipts().at(-1);
  assert.equal(s.verdict, 'summary');
  assert.equal(s.operator, 'ada@acme.dev');
});

srv.close();
console.log(`\n  ${pass} passed`);
