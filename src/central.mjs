// Layer A, asked centrally: what the TENANT's policy says about an action.
//
// The capability rules in capability.mjs are the same six patterns for every
// customer, and a team cannot express "publishing needs a release manager"
// without editing JSON on every machine. Enforcer already has the machinery for
// exactly that — tenant policies: Rego, versioned, self-tested before they may
// go live, rolled back by activating the previous version, and composed with
// platform authority at one decision point. So the governor asks it.
//
// WHAT IS ASKED. Only an action a local rule has already classified. The rule
// supplies the vocabulary (`deploy.publish`, `git.force_push`) and Enforcer
// supplies the decision, as an authorization check on a resource of type
// `agent_action` whose id is the rule id. An ordinary tool call matches no rule
// and costs no network round trip at all — the governor stays out of the way
// of the ninety-odd percent of calls nobody has an opinion about.
//
// WHAT THE ANSWER CAN DO, and what it cannot. This is the part to review.
//   deny   always wins. The tenant said no.
//   ask    a deny whose reason begins "ask:" — the policy wants a human.
//   allow  from the tenant's own rule, relaxes a local ASK to no objection.
//          It never lifts a local DENY (curl | sh stays refused whatever a
//          policy says) and never skips a REWRITE, which is strictly safer
//          than the original and costs the user nothing.
//   silent the tenant has no rule for agent_action; the local rule stands.
//
// WHEN ENFORCER CANNOT ANSWER — offline, slow, signed out, misconfigured — the
// local rule stands. That is the capability layer's fail-closed contract
// carried across the network: losing the central answer can only ever leave
// the stricter local one in place, never an allow.
//
// The network lives here and ONLY here. capability.mjs stays a pure function
// of the action text, which is what lets it keep refusing when everything
// else is broken.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DIR } from './store.mjs';
import { ruleId, ruleAuthz } from './capability.mjs';
import { authHeaders, baseUrl, credentialId } from './credentials.mjs';

export const RESOURCE_TYPE = 'agent_action';
const API = '/api/v1/enforcer';
const CACHE = () => join(DIR, 'policy-cache.json');
const IDENTITY_TTL_MS = 60 * 60 * 1000;

export const ALLOW = 'allow';
export const DENY = 'deny';
export const ASK = 'ask';
export const SILENT = 'silent';
export const UNREACHABLE = 'unreachable';

// A platform decision reason is an identifier (`owner`, `not_owner`,
// `resource_unspecified`); a tenant's is prose it wrote, or one of the two
// fixed phrases the evaluator uses. That difference is how the governor tells
// "the tenant decided" from "the platform answered because the tenant has no
// rule", without a field the API does not return.
const TENANT_ALLOW = 'tenant policy';
const TENANT_SILENT_DENY = 'tenant policy did not allow it';
const isPlatformReason = (r) => /^[a-z_]+$/.test(String(r || ''));

const readCache = () => { try { return JSON.parse(readFileSync(CACHE(), 'utf8')) || {}; } catch { return {}; } };
function writeCache(c) {
  try {
    mkdirSync(DIR, { recursive: true });
    const tmp = CACHE() + `.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, CACHE());
  } catch { /* a cache that cannot be written only costs a round trip */ }
}

async function call(fetchImpl, url, init, timeoutMs) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is handled by status */ }
  return { status: res.status, body };
}

/**
 * Turn an /authz/check response into the tenant's opinion.
 * Exported for the tests: this mapping is the contract.
 */
export function interpret(decision) {
  if (!decision || typeof decision.allow !== 'boolean') return { opinion: UNREACHABLE, detail: 'unexpected response' };
  const reason = String(decision.reason || '');
  if (decision.allow) {
    return reason === TENANT_ALLOW ? { opinion: ALLOW, reason } : { opinion: SILENT, reason };
  }
  // A platform-level refusal means the question was malformed for this caller
  // (wrong tenant, no owner) — a governor fault, not a tenant decision. Treat
  // it as no answer so the local rule stands, and say why in the receipt.
  if (isPlatformReason(reason)) return { opinion: UNREACHABLE, detail: `platform refused the check: ${reason}` };
  if (/^ask:/i.test(reason)) return { opinion: ASK, reason: reason.replace(/^ask:\s*/i, '') || 'the tenant policy asks for confirmation' };
  if (reason === TENANT_SILENT_DENY) {
    return { opinion: DENY, reason: `the tenant policy declares agent actions and has no rule allowing this one` };
  }
  return { opinion: DENY, reason };
}

/**
 * Ask Enforcer what the tenant's policy says about the action a rule matched.
 *
 * @param rule  the matched capability rule
 * @param cfg   config: policyOn, policyTimeoutMs, policyTtlSec, centralUrl
 * @param deps  { fetchImpl, now } — injected so the tests need no network
 * @returns {{opinion, reason?, detail?, cached?}}  never throws
 */
export async function consult(rule, cfg = {}, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!rule) return null;
  if (cfg.policyOn === false) return null;
  if (typeof fetchImpl !== 'function') return { opinion: UNREACHABLE, detail: 'no fetch in this runtime' };

  const cred = credentialId();
  if (!cred) return { opinion: UNREACHABLE, detail: 'not signed in to Enforcer' };

  const id = ruleId(rule);
  const action = ruleAuthz(rule);
  const ttl = Math.max(0, Number(cfg.policyTtlSec ?? 30)) * 1000;
  const timeoutMs = Math.max(100, Number(cfg.policyTimeoutMs ?? 1500));
  const base = baseUrl(cfg);
  const cacheKey = createHash('sha256').update(`${base}|${cred}|${id}|${action}`).digest('hex').slice(0, 24);

  const cache = readCache();
  const hit = cache.decisions?.[cacheKey];
  if (hit && now() - hit.at < ttl) return { ...hit.result, cached: true };

  try {
    const headers = await authHeaders({ fetchImpl, now });
    if (!headers['X-API-Key'] && !headers.Authorization) return { opinion: UNREACHABLE, detail: 'not signed in to Enforcer' };

    // Who am I? The check must describe the resource as owned by the caller
    // in the caller's tenant, or the platform refuses it as unspecified before
    // the tenant policy is ever consulted.
    let who = cache.identity?.[cred];
    if (!who || now() - who.at > IDENTITY_TTL_MS) {
      const me = await call(fetchImpl, `${base}${API}/auth/me`, { headers }, timeoutMs);
      const d = me.body?.data;
      // /auth/me nests these: account_id at the top, the tenant under tenant.id.
      const account = d?.account_id || d?.id;
      const tenant = d?.tenant?.id || d?.tenant_id;
      if (me.status !== 200 || !account || !tenant) {
        return { opinion: UNREACHABLE, detail: `could not identify this credential (HTTP ${me.status})` };
      }
      who = { account_id: account, tenant_id: tenant, at: now() };
      cache.identity = { ...(cache.identity || {}), [cred]: who };
    }

    const r = await call(fetchImpl, `${base}${API}/authz/check`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, resource: { type: RESOURCE_TYPE, id, owner_id: who.account_id, tenant_id: who.tenant_id } }),
    }, timeoutMs);

    const result = r.status === 200 ? interpret(r.body) : { opinion: UNREACHABLE, detail: `HTTP ${r.status}` };
    // Only real answers are cached. Caching "unreachable" would pin a blip for
    // the whole TTL; caching a decision is what keeps a burst of matched
    // commands from each paying a round trip.
    if (result.opinion !== UNREACHABLE) {
      cache.decisions = { ...(cache.decisions || {}), [cacheKey]: { at: now(), result } };
    }
    writeCache(cache);
    return result;
  } catch (e) {
    const detail = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `no answer within ${timeoutMs}ms` : 'Enforcer could not be reached';
    return { opinion: UNREACHABLE, detail };
  }
}
