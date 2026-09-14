#!/usr/bin/env node
// Sign this machine in to Enforcer — once, for the governor AND the MCP server.
//
//   login.mjs              browser sign-in (OAuth 2.1, PKCE, loopback redirect)
//   login.mjs api-key KEY  use an existing Enforcer API key instead
//   login.mjs status       who is signed in, and how
//   login.mjs logout       forget the credential on this machine
//
// The browser flow is the one Claude Code itself uses for a remote MCP server,
// done here so the result lands in ~/.enforcer/credentials.json where both
// tools read it: register a public client (RFC 7591), open the authorization
// URL, catch the redirect on 127.0.0.1, redeem the code with the PKCE verifier.
// The refresh token is kept, so the sign-in outlives the 15-minute access
// token (credentials.mjs rotates it).
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readCredentials, saveCredentials, enforcerKey, SHARED_FILE, DEFAULT_BASE_URL, authHeaders } from '../src/credentials.mjs';

const API = '/api/v1/enforcer';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const out = (s) => process.stdout.write(s + '\n');

export async function discover(base, fetchImpl = fetch) {
  const r = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`no OAuth metadata at ${base} (HTTP ${r.status})`);
  return r.json();
}

export function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is printed anyway */ }
}

/**
 * Run the loopback authorization-code flow.
 * `resource` is the RFC 8707 audience the token is for; `onUrl` receives the
 * authorization URL (printed and opened by the CLI, captured by the tests).
 */
export async function browserSignIn({ base, resource, scope = 'enforcer:read', fetchImpl = fetch, onUrl, timeoutMs = 5 * 60_000 }) {
  const meta = await discover(base, fetchImpl);
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));

  // Listen first: the redirect URI must be registered, and it names the port.
  let resolveCode, rejectCode;
  const codeP = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const err = u.searchParams.get('error');
    const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ok
      ? '<p>Signed in to Enforcer. You can close this tab and return to your terminal.</p>'
      : '<p>Sign-in did not complete. Return to your terminal for details.</p>');
    if (err) rejectCode(new Error(`authorization refused: ${err}${u.searchParams.get('error_description') ? ' — ' + u.searchParams.get('error_description') : ''}`));
    else if (u.searchParams.get('state') !== state) rejectCode(new Error('state mismatch — the redirect did not come from this sign-in'));
    else resolveCode(u.searchParams.get('code'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(() => rejectCode(new Error('timed out waiting for the browser sign-in')), timeoutMs);

  try {
    const reg = await fetchImpl(meta.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Enforcer Governor (Claude Code)', redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      signal: AbortSignal.timeout(10_000),
    });
    const client = await reg.json();
    if (!reg.ok || !client.client_id) throw new Error(`client registration failed (HTTP ${reg.status})`);

    const url = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', scope, state, ...(resource ? { resource } : {}) })) {
      url.searchParams.set(k, v);
    }
    onUrl?.(url.toString());

    const code = await codeP;
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: client.client_id, code_verifier: verifier, ...(resource ? { resource } : {}) });
    const tr = await fetchImpl(meta.token_endpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) });
    const tok = await tr.json();
    if (!tr.ok || !tok.access_token) throw new Error(`code redemption failed: ${tok.error || 'HTTP ' + tr.status}`);
    return {
      access_token: tok.access_token, refresh_token: tok.refresh_token || null,
      expires_at: new Date(Date.now() + (Number(tok.expires_in) || 900) * 1000).toISOString(),
      scope: tok.scope || scope, resource: resource || null,
      client_id: client.client_id, token_endpoint: meta.token_endpoint, issuer: meta.issuer,
    };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

const who = (me) => me.person?.primary_email || me.person?.name || me.account_id || 'unknown account';

async function whoAmI(base) {
  const headers = await authHeaders();
  if (!headers['X-API-Key'] && !headers.Authorization) return null;
  const r = await fetch(`${base}${API}/auth/me`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return (await r.json())?.data || null;
}

async function main(argv) {
  const [cmd = 'browser', arg] = argv;
  const base = (readCredentials()?.enforcer?.base_url || process.env.ENFORCER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  if (cmd === 'status') {
    const doc = readCredentials();
    if (!doc) { out('Not signed in to Enforcer. Run /enforcer-governor:login.'); return; }
    const how = enforcerKey() ? 'an API key' : 'a browser sign-in';
    const me = await whoAmI(base).catch(() => ({ error: 'unreachable' }));
    if (!me || me.error) { out(`Signed in with ${how}, but Enforcer did not accept it (${me?.error || 'no credential'}). Run /enforcer-governor:login again.`); return; }
    out(`Signed in to ${base} with ${how} as ${who(me)} (${me.role?.slug || 'unknown role'}, tenant ${me.tenant?.name || me.tenant?.id || '?'}).`);
    out(`Shared by the governor and the Enforcer MCP server: ${SHARED_FILE()}`);
    return;
  }

  if (cmd === 'logout') {
    const doc = readCredentials();
    if (!doc) { out('Already signed out.'); return; }
    const { api_key, oauth, ...rest } = doc.enforcer;   // eslint-disable-line no-unused-vars
    saveCredentials({ ...doc, enforcer: rest });
    out('Signed out on this machine. The governor and the Enforcer MCP server no longer send a credential.');
    out('An API key still exists on the server until you revoke it there.');
    return;
  }

  if (cmd === 'api-key') {
    const key = (arg || process.env.ENFORCER_API_KEY || '').trim();
    if (!/^[a-z0-9]+_[A-Za-z0-9_-]{20,}$/.test(key)) { out('Usage: login api-key <env3_…>  (or set ENFORCER_API_KEY)'); process.exitCode = 2; return; }
    const doc = readCredentials() || { enforcer: {} };
    saveCredentials({ ...doc, enforcer: { ...doc.enforcer, base_url: base, api_key: key, saved_at: new Date().toISOString() } });
    const me = await whoAmI(base).catch(() => null);
    out(me && !me.error
      ? `Saved. Signed in as ${who(me)}. The governor and the Enforcer MCP server now both use this key.`
      : 'Saved, but Enforcer did not accept the key just now. Check it with /enforcer-governor:login status.');
    return;
  }

  if (cmd === 'browser') {
    const resource = process.env.ENFORCER_RESOURCE || base;
    const oauth = await browserSignIn({ base, resource, onUrl: (url) => {
      out('Opening your browser to sign in to Enforcer. If it does not open, visit:');
      out(url);
      openBrowser(url);
    } });
    const doc = readCredentials() || { enforcer: {} };
    saveCredentials({ ...doc, enforcer: { ...doc.enforcer, base_url: base, oauth } });
    const me = await whoAmI(base).catch(() => null);
    out(me && !me.error ? `Signed in as ${who(me)}.` : 'Signed in.');
    out('The governor and the Enforcer MCP server share this sign-in.');
    return;
  }

  out('Usage: login [browser | api-key <key> | status | logout]');
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { out(`Sign-in failed: ${e.message}`); process.exitCode = 1; });
}
