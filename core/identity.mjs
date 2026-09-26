// Who is signed in, for the receipts.
//
// A receipt is meant to name the person the agent acted for. That used to rest
// on the `operator` setting, which nobody sets, so a signed-in install wrote
// receipts naming no one while it knew perfectly well whose credential it was
// using. This caches the signed-in account's email so the decision path can
// stamp it without a network call.
//
// The cache is fetched where a short wait is already affordable -- session
// start, beside the managed settings -- and is valid only for the credential
// it was fetched with (credentialId()): sign out, or sign in as someone else,
// and it stops counting at once rather than naming the previous person until
// the next refresh. An explicit `operator` setting always wins over it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIR } from './store.mjs';
import { authHeaders, baseUrl, credentialId } from './credentials.mjs';

const FILE = () => join(DIR, 'identity.json');
const MAX_AGE_MS = 24 * 3600 * 1000;
const PATH = '/api/v1/enforcer/auth/me';

function read() {
  try { return JSON.parse(readFileSync(FILE(), 'utf8')); } catch { return null; }
}

/** Whether the cached identity is missing, old, or belongs to another credential. */
export function identityStale({ now = Date.now } = {}) {
  const c = read();
  return !c || c.credential !== credentialId() || now() - (c.fetched_at || 0) > MAX_AGE_MS;
}

/**
 * The signed-in person's email, or '' when there is no current sign-in or it
 * has not been looked up yet. Never touches the network.
 */
export function signedInOperator() {
  const id = credentialId();
  if (!id) return '';
  const c = read();
  return c && c.credential === id && typeof c.email === 'string' ? c.email : '';
}

/** Look the signed-in account up and cache its email. Best effort; never throws. */
export async function refreshIdentity(cfg = {}, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 3000 } = {}) {
  const id = credentialId();
  if (!id || typeof fetchImpl !== 'function') return { ok: false, detail: 'not signed in to Enforcer' };
  try {
    const headers = await authHeaders({ fetchImpl, now });
    if (!headers['X-API-Key'] && !headers.Authorization) return { ok: false, detail: 'not signed in to Enforcer' };
    const base = baseUrl(cfg).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}${PATH}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const me = (await res.json())?.data || {};
    const email = me.person?.primary_email || me.email || '';
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE(), JSON.stringify({ credential: id, email, account_id: me.account_id || '', fetched_at: now() }));
    return { ok: true, email };
  } catch (e) {
    const detail = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `no answer within ${timeoutMs}ms` : 'Enforcer could not be reached';
    return { ok: false, detail };
  }
}
