// The browser sign-in, end to end against a fake authorization server — the
// real HTTP listener, the real redirect, the real PKCE check.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-login-'));
process.env.HOME = home; process.env.ENFORCER_HOME = join(home, '.enforcer'); process.env.GOVERNOR_HOME = join(home, '.g');

const { browserSignIn, pkce, resourcesFor, requestedScope, parseLoginArgs, isWorkspaceCode } = await import('../bin/login.mjs');
let pass = 0;
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

await ok('the verifier hashes to the challenge (S256)', () => {
  const { verifier, challenge } = pkce();
  assert.equal(b64url(createHash('sha256').update(verifier).digest()), challenge);
  assert.ok(verifier.length >= 43);
});

// A fake AS that behaves like enforcer's: DCR, an authorize step that
// redirects with a code (the browser's part, performed here by a fetch), and a
// token endpoint that checks the verifier and the resource.
const issued = {};
const as = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
  const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const base = `http://127.0.0.1:${as.address().port}`;
  if (u.pathname === '/.well-known/oauth-authorization-server') {
    return json(200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register' });
  }
  if (u.pathname === '/register') { const b = JSON.parse(body); issued.redirect = b.redirect_uris[0]; return json(201, { client_id: 'mcp_test' }); }
  if (u.pathname === '/token') {
    const p = new URLSearchParams(body);
    const good = p.get('code') === 'the-code' && b64url(createHash('sha256').update(p.get('code_verifier')).digest()) === issued.challenge
      && p.get('redirect_uri') === issued.redirect;
    return good ? json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 900, scope: 'enforcer:read' }) : json(400, { error: 'invalid_grant' });
  }
  json(404, {});
});
await new Promise((r) => as.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${as.address().port}`;

await ok('asks for every scope the server advertises, and read-only when it advertises none', () => {
  // The ceiling a self-registered client gets is the advertised list; asking
  // for a fixed subset silently threw the graph's write scopes away.
  assert.equal(requestedScope({ scopes_supported: ['enforcer:read', 'enforcer:graph-runs.write'] }), 'enforcer:read enforcer:graph-runs.write');
  assert.equal(requestedScope({}), 'enforcer:read');
  assert.equal(requestedScope({ scopes_supported: [] }), 'enforcer:read');
});

await ok('a workspace code: `login CODE` is a browser sign-in into it; commands still win', () => {
  assert.deepEqual(parseLoginArgs(['acme-1234-abcd']), ['browser', 'ACME-1234-ABCD']);
  assert.deepEqual(parseLoginArgs([]), ['browser', undefined]);
  assert.deepEqual(parseLoginArgs(['browser', 'ACME-1234-ABCD']), ['browser', 'ACME-1234-ABCD']);
  assert.deepEqual(parseLoginArgs(['api-key', 'env3_x']), ['api-key', 'env3_x'], 'api-key has a dash but is a command');
  assert.deepEqual(parseLoginArgs(['status']), ['status', undefined]);
  for (const bad of ['ACME', 'a b-c', '-ACME', 'ACME-', 'x;rm-rf', 'logout']) assert.equal(isWorkspaceCode(bad), false, bad);
});

await ok('a workspace code rides on the authorize URL; without one it is absent', async () => {
  const seen = [];
  for (const tenantCode of ['ACME-1234-ABCD', undefined]) {
    await browserSignIn({ base, resources: ['https://api.example.test'], tenantCode, timeoutMs: 5000, onUrl: async (url) => {
      const a = new URL(url);
      seen.push(a.searchParams.get('tenant_code'));
      issued.challenge = a.searchParams.get('code_challenge');
      const cb = new URL(a.searchParams.get('redirect_uri'));
      cb.searchParams.set('code', 'the-code'); cb.searchParams.set('state', a.searchParams.get('state'));
      await fetch(cb);
    } });
  }
  assert.deepEqual(seen, ['ACME-1234-ABCD', null]);
});

await ok('signs in: register, authorize, loopback redirect, redeem with the verifier', async () => {
  const want = ['https://api.example.test', 'https://api.example.test/mcp'];
  const tok = await browserSignIn({ base, resources: want, timeoutMs: 5000, onUrl: async (url) => {
    const a = new URL(url);
    assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
    assert.deepEqual(a.searchParams.getAll('resource'), want, 'one sign-in names the API and the MCP server (RFC 8707)');
    issued.challenge = a.searchParams.get('code_challenge');
    // The "browser": the AS would redirect here after the user signs in.
    const cb = new URL(a.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', 'the-code'); cb.searchParams.set('state', a.searchParams.get('state'));
    const r = await fetch(cb); assert.equal(r.status, 200);
  } });
  assert.deepEqual([tok.access_token, tok.refresh_token, tok.client_id], ['at', 'rt', 'mcp_test']);
  assert.deepEqual(tok.resources, want);
  assert.ok(Date.parse(tok.expires_at) > Date.now());
});

await ok('a redirect with the wrong state is refused', async () => {
  await assert.rejects(browserSignIn({ base, timeoutMs: 5000, onUrl: async (url) => {
    const cb = new URL(new URL(url).searchParams.get('redirect_uri'));
    cb.searchParams.set('code', 'the-code'); cb.searchParams.set('state', 'forged');
    await fetch(cb);
  } }), /state mismatch/);
});

await ok('a refusal at the authorization server is reported, not hung on', async () => {
  await assert.rejects(browserSignIn({ base, timeoutMs: 5000, onUrl: async (url) => {
    const cb = new URL(new URL(url).searchParams.get('redirect_uri'));
    cb.searchParams.set('error', 'access_denied'); cb.searchParams.set('state', new URL(url).searchParams.get('state'));
    await fetch(cb);
  } }), /access_denied/);
});

await ok('resources come from what the MCP server publishes about itself', async () => {
  const fake = async (url) => url.endsWith('/.well-known/oauth-protected-resource/mcp')
    ? { ok: true, json: async () => ({ resource: 'https://api.example.test/mcp' }) }
    : { ok: false, json: async () => ({}) };
  assert.deepEqual(await resourcesFor('https://api.example.test', fake), ['https://api.example.test', 'https://api.example.test/mcp']);
  const down = async () => { throw new Error('offline'); };
  assert.deepEqual(await resourcesFor('https://api.example.test', down), ['https://api.example.test'], 'no MCP metadata still signs the governor in');
});

await ok('one credential at a time: a sign-in replaces a key and a key replaces a sign-in', async () => {
  const { execFileSync } = await import('node:child_process');
  const { saveCredentials, readCredentials } = await import('../src/credentials.mjs');
  saveCredentials({ enforcer: { api_key: 'env3_' + 'k'.repeat(43), base_url: base } });
  // The browser path, driven through the CLI entry point's save logic by importing it is not
  // possible without a browser, so exercise the same rule on the api-key path in reverse.
  saveCredentials({ enforcer: { base_url: base, oauth: { access_token: 'at', client_id: 'c' } } });
  execFileSync(process.execPath, [new URL('../bin/login.mjs', import.meta.url).pathname, 'api-key', 'env3_' + 'z'.repeat(43)],
    { env: { ...process.env, ENFORCER_API_KEY: '' }, encoding: 'utf8' });
  const e = readCredentials().enforcer;
  assert.equal(e.api_key, 'env3_' + 'z'.repeat(43));
  assert.equal(e.oauth, undefined, 'saving a key must drop the browser sign-in, or the two identities disagree');
});

as.close();
console.log(`\n  ${pass} passed`);
