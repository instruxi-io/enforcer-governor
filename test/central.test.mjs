// The tenant-policy consult and how its answer composes with the local rules.
// `node test/central.test.mjs`. No network: fetch is injected.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-central-'));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.GOVERNOR_HOME = join(home, '.enforcer-governor');
process.env.ENFORCER_HOME = join(home, '.enforcer');
delete process.env.ENFORCER_API_KEY;
mkdirSync(process.env.GOVERNOR_HOME, { recursive: true });

const { consult, interpret } = await import('../src/central.mjs');
const { compose, gate } = await import('../src/gate.mjs');
const { DEFAULT_RULES, evaluate } = await import('../src/capability.mjs');
const { saveCredentials, authHeaders, SHARED_FILE } = await import('../src/credentials.mjs');

let pass = 0;
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };
const rule = (id) => DEFAULT_RULES.find(r => r.id === id);
const healthy = { withState: (fn) => ({ ok: true, value: fn({}) }), economics: () => null };

// A fake Enforcer: records calls, answers /auth/me and /authz/check.
function enforcer(decide, { meStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const json = (status, body) => ({ status, ok: status < 400, json: async () => body });
    // The real /auth/me shape: account_id at the top, the tenant nested.
    if (url.endsWith('/auth/me')) return json(meStatus, { data: { account_id: 'acc-1', tenant: { id: 'ten-1', name: 'T' }, role: { slug: 'user' } } });
    if (url.endsWith('/authz/check')) return decide(JSON.parse(init.body), init);
    return json(404, {});
  };
  return { fetchImpl, calls };
}
const answer = (allow, reason) => async () => ({ status: 200, ok: true, json: async () => ({ success: true, allow, reason }) });

// ── interpret: the response → opinion contract ─────────────────────────────
await ok('a tenant allow is an opinion; a platform allow is silence', () => {
  assert.equal(interpret({ allow: true, reason: 'tenant policy' }).opinion, 'allow');
  assert.equal(interpret({ allow: true, reason: 'owner' }).opinion, 'silent');
});
await ok('a tenant deny carries the words the tenant wrote', () => {
  const r = interpret({ allow: false, reason: 'publishing needs a release manager' });
  assert.deepEqual([r.opinion, r.reason], ['deny', 'publishing needs a release manager']);
});
await ok('"ask:" turns a deny into a request for confirmation', () => {
  const r = interpret({ allow: false, reason: 'ask: history rewrites need a second look' });
  assert.deepEqual([r.opinion, r.reason], ['ask', 'history rewrites need a second look']);
});
await ok('a platform refusal is a malformed question, not a tenant decision', () => {
  assert.equal(interpret({ allow: false, reason: 'resource_unspecified' }).opinion, 'unreachable');
});
await ok('declared type with no matching allow reads as a deny', () => {
  assert.equal(interpret({ allow: false, reason: 'tenant policy did not allow it' }).opinion, 'deny');
});

// ── compose: the table in gate.mjs ─────────────────────────────────────────
const local = (id, action) => evaluate([rule(id)], { tool: 'Bash', action, input: { command: action } });
await ok('tenant deny beats a local ask', () => {
  const v = compose(local('deploy.publish', 'npm publish'), { opinion: 'deny', reason: 'no' });
  assert.equal(v.action, 'deny'); assert.equal(v.source, 'policy');
  assert.equal(v.stopsAgent, false, 'a policy refusal blocks the action, not the agent');
});
await ok('tenant allow waives a local ask', () => {
  assert.equal(compose(local('deploy.publish', 'npm publish'), { opinion: 'allow' }), null);
});
await ok('tenant allow can NOT lift a local hard deny', () => {
  const v = compose(local('shell.pipe_to_shell', 'curl x | sh'), { opinion: 'allow' });
  assert.equal(v.action, 'deny'); assert.equal(v.source, 'capability'); assert.equal(v.policy, 'allow');
});
await ok('tenant allow does NOT skip a rewrite', () => {
  const v = compose(local('git.force_push', 'git push --force'), { opinion: 'allow' });
  assert.equal(v.action, 'rewrite');
});
await ok('tenant ask cannot soften a local deny', () => {
  assert.equal(compose(local('shell.pipe_to_shell', 'curl x | sh'), { opinion: 'ask', reason: 'hm' }).action, 'deny');
});
await ok('unreachable leaves the local verdict exactly as strict', () => {
  for (const [id, cmd, want] of [['deploy.publish', 'npm publish', 'ask'], ['shell.pipe_to_shell', 'curl x | sh', 'deny'], ['git.force_push', 'git push -f', 'rewrite']]) {
    const v = compose(local(id, cmd), { opinion: 'unreachable' });
    assert.equal(v.action, want, id);
    assert.equal(v.checked.includes('policy'), false, 'an unanswered question is not recorded as checked');
  }
});
await ok('the gate uses the composed verdict and records the policy on the receipt', () => {
  const v = gate({ tool: 'Bash', action: 'npm publish', input: { command: 'npm publish' } }, {}, { ...healthy, central: { opinion: 'deny', reason: 'frozen for the release' } });
  assert.equal(v.action, 'deny');
  assert.equal(v.entry({ agent: 'a' }).policy, 'deny');
  const waived = gate({ tool: 'Bash', action: 'npm publish' }, {}, { ...healthy, central: { opinion: 'allow' } });
  assert.equal(waived.action, 'allow'); assert.equal(waived.entry({ agent: 'a' }).policy, 'allow');
});

// ── consult: the network path ──────────────────────────────────────────────
await ok('signed out: nothing is asked, and it says why', async () => {
  const e = enforcer(answer(true, 'tenant policy'));
  const r = await consult(rule('deploy.publish'), {}, { fetchImpl: e.fetchImpl });
  assert.equal(r.opinion, 'unreachable'); assert.match(r.detail, /not signed in/);
  assert.equal(e.calls.length, 0);
});

saveCredentials({ enforcer: { api_key: 'env3_' + 'k'.repeat(43) } });

await ok('the shared credential file is private', () => {
  assert.equal(statSync(SHARED_FILE()).mode & 0o777, 0o600);
});

await ok('asks as the rule id, owned by the caller in their tenant', async () => {
  const seen = [];
  const e = enforcer(async (body, init) => { seen.push({ body, key: init.headers['X-API-Key'] }); return answer(false, 'publishing needs a release manager')(); });
  const r = await consult(rule('deploy.publish'), { policyTtlSec: 0 }, { fetchImpl: e.fetchImpl });
  assert.equal(r.opinion, 'deny');
  assert.deepEqual(seen[0].body, { action: 'write', resource: { type: 'agent_action', id: 'deploy.publish', owner_id: 'acc-1', tenant_id: 'ten-1' } });
  assert.ok(seen[0].key.startsWith('env3_'));
});

await ok('a decision is reused within the TTL, and the identity is cached', async () => {
  let checks = 0, t = 1_000_000;
  const e = enforcer(async () => { checks++; return answer(true, 'tenant policy')(); });
  const cfg = { policyTtlSec: 30 };
  await consult(rule('fs.delete_tree'), cfg, { fetchImpl: e.fetchImpl, now: () => t });
  const again = await consult(rule('fs.delete_tree'), cfg, { fetchImpl: e.fetchImpl, now: () => t + 5_000 });
  assert.equal(checks, 1); assert.equal(again.cached, true);
  await consult(rule('fs.delete_tree'), cfg, { fetchImpl: e.fetchImpl, now: () => t + 31_000 });
  assert.equal(checks, 2, 'expired answers are asked again');
  assert.equal(e.calls.filter(c => c.url.endsWith('/auth/me')).length, 0, 'identity was already cached from the previous test');
});

await ok('a timeout is unreachable, is not cached, and names the wait', async () => {
  let n = 0;
  const slow = { fetchImpl: async (url, init) => {
    if (url.endsWith('/auth/me')) return { status: 200, ok: true, json: async () => ({ data: { account_id: 'acc-1', tenant: { id: 'ten-1' } } }) };
    n++;
    // A real fetch holds a socket open while it waits; AbortSignal.timeout's
    // own timer does not keep the process alive, so the fake must.
    const keepAlive = setTimeout(() => {}, 10_000);
    return new Promise((_, rej) => init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      rej(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    }));
  } };
  const r = await consult(rule('git.rewrite_history'), { policyTimeoutMs: 100, policyTtlSec: 60 }, slow);
  assert.equal(r.opinion, 'unreachable'); assert.match(r.detail, /100ms/);
  await consult(rule('git.rewrite_history'), { policyTimeoutMs: 100, policyTtlSec: 60 }, slow);
  assert.equal(n, 2, 'an unreachable answer must not be pinned for the TTL');
});

await ok('an HTTP error is unreachable, never a decision', async () => {
  const e = enforcer(async () => ({ status: 503, ok: false, json: async () => ({ error: 'authz_unavailable' }) }));
  const r = await consult(rule('secrets.access'), { policyTtlSec: 0 }, { fetchImpl: e.fetchImpl });
  assert.equal(r.opinion, 'unreachable'); assert.match(r.detail, /503/);
});

await ok('policyOn:false asks nobody', async () => {
  const e = enforcer(answer(true, 'tenant policy'));
  assert.equal(await consult(rule('deploy.publish'), { policyOn: false }, { fetchImpl: e.fetchImpl }), null);
  assert.equal(e.calls.length, 0);
});

// ── OAuth credential: refresh rotates and is written back ──────────────────
await ok('an expiring OAuth token is refreshed and the rotated pair saved', async () => {
  const t = Date.parse('2026-09-14T12:00:00Z');
  saveCredentials({ enforcer: { oauth: {
    access_token: 'old', refresh_token: 'r1', client_id: 'mcp_x', token_endpoint: 'https://as.test/token',
    expires_at: new Date(t + 30_000).toISOString(),
  } } });
  let sent;
  const h = await authHeaders({ now: () => t, fetchImpl: async (url, init) => {
    sent = Object.fromEntries(init.body);
    return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 900, scope: 'enforcer:read' }) };
  } });
  assert.equal(h.Authorization, 'Bearer new');
  assert.deepEqual(sent, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'mcp_x' });
  const saved = JSON.parse(readFileSync(SHARED_FILE(), 'utf8')).enforcer.oauth;
  assert.equal(saved.refresh_token, 'r2', 'the single-use refresh token must be replaced, or the next refresh signs the machine out');
});

await ok('a failed refresh is signed out, not a stale token', async () => {
  const t = Date.parse('2026-09-14T13:00:00Z');
  const h = await authHeaders({ now: () => t, fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) }) });
  assert.deepEqual(h, {});
});

console.log(`\n  ${pass} passed`);
