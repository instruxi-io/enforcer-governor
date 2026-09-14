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

const { browserSignIn, pkce } = await import('../bin/login.mjs');
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
      && p.get('resource') === issued.resource && p.get('redirect_uri') === issued.redirect;
    return good ? json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 900, scope: 'enforcer:read' }) : json(400, { error: 'invalid_grant' });
  }
  json(404, {});
});
await new Promise((r) => as.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${as.address().port}`;

await ok('signs in: register, authorize, loopback redirect, redeem with the verifier', async () => {
  const tok = await browserSignIn({ base, resource: 'https://api.example.test', timeoutMs: 5000, onUrl: async (url) => {
    const a = new URL(url);
    assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(a.searchParams.get('resource'), 'https://api.example.test');
    issued.challenge = a.searchParams.get('code_challenge'); issued.resource = a.searchParams.get('resource');
    // The "browser": the AS would redirect here after the user signs in.
    const cb = new URL(a.searchParams.get('redirect_uri'));
    cb.searchParams.set('code', 'the-code'); cb.searchParams.set('state', a.searchParams.get('state'));
    const r = await fetch(cb); assert.equal(r.status, 200);
  } });
  assert.deepEqual([tok.access_token, tok.refresh_token, tok.client_id, tok.resource], ['at', 'rt', 'mcp_test', 'https://api.example.test']);
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

as.close();
console.log(`\n  ${pass} passed`);
