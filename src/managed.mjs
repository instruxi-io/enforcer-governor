// Managed settings: the tenant's floor, under this machine's own config.
//
// config.json is a per-machine opinion. An organisation could publish a POLICY
// for actions a local rule matched, but not "spend is capped at $150 and the
// capability rules stay on" — and turning rulesOn off locally also stops the
// tenant's policy being consulted, because it is only asked about a matched
// rule. So the tenant's half now lives in enforcer-governance
// (GET /api/v1/governance/settings) and this file merges the two.
//
// STRICTER WINS, PER SETTING. Not "managed overrides": an operator who wants a
// tighter limit than their organisation's should keep it. Which direction is
// stricter is a property of the setting, so it is spelled out per key below
// rather than inferred.
//
// NOTHING HERE BLOCKS A TOOL CALL. The fetch happens on SessionStart and writes
// a cache file; every hook reads the cache and never the network. A machine
// that has never reached the control plane, or is signed out, simply has no
// managed floor — the same failure-open direction as every other check here,
// and the only honest one: a governor that refused to decide because a settings
// endpoint was slow would stop work over its own configuration.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIR } from './store.mjs';
import { baseUrl, authHeaders, credentialId } from './credentials.mjs';

const CACHE = join(DIR, 'managed-settings.json');
const PATH = '/api/v1/governance/settings';

// A day. The cache is refreshed on every SessionStart, so this is the ceiling
// on how long a machine that keeps starting sessions can run on a stale floor,
// not the expected age. Nothing expires it to "unmanaged": a tenant that has
// published a floor should not lose it because the network is down.
const TTL_MS = 24 * 60 * 60 * 1000;

// ── the merge ───────────────────────────────────────────────────────────────
// Every manageable setting, and what stricter MEANS for it. A setting absent
// from this table is not merged even if the API sends it: an unknown key has no
// stricter direction, and guessing one is how a managed value ends up loosening
// a machine's own configuration.

/** A cap where a smaller number is tighter, and 0 means "no cap". */
const cap = (managed, local) => {
  const m = Number(managed), l = Number(local);
  if (!Number.isFinite(m) || m <= 0) return local;   // managed says "no cap"
  if (!Number.isFinite(l) || l <= 0) return m;       // local says "no cap"
  return Math.min(m, l);
};
/** A plain number where smaller is tighter (0 is a real value, not "off"). */
const lower = (managed, local) => {
  const m = Number(managed), l = Number(local);
  if (!Number.isFinite(m)) return local;
  if (!Number.isFinite(l)) return m;
  return Math.min(m, l);
};
/** A check: on is stricter, so a managed `true` cannot be turned off locally. */
const onWins = (managed, local) => (managed === true ? true : local);
/** A check whose managed value stands as written (neither direction is safety). */
const managedWins = (managed, local) => (managed === undefined ? local : managed);

const MERGE = {
  dollars: cap,
  soft: lower,                 // the soft mark is a fraction: earlier is stricter
  softAction: (m, l) => (m === 'deny' || l === 'deny' ? 'deny' : l),
  dailyLimit: cap,
  weeklyLimit: cap,
  monthlyLimit: cap,
  burnLimit: cap,
  fleetBurnLimit: cap,
  fanoutLimit: cap,
  retryLimit: cap,
  loopLimit: cap,
  loopWindow: managedWins,     // the window is a measurement, not a limit
  budgetOn: onWins,
  loopOn: onWins,
  rulesOn: onWins,
  policyOn: onWins,
  shipOn: onWins,
  adviseModel: onWins,
  policyTimeoutMs: managedWins,
  policyTtlSec: managedWins,
};

/**
 * Merge a tenant's managed settings into a local config.
 * Pure: the caller supplies both sides, so the rules are testable with no
 * network and no files.
 */
export function merge(local = {}, managed = {}) {
  const out = { ...local };
  for (const [key, value] of Object.entries(managed || {})) {
    const rule = MERGE[key];
    if (!rule) continue;
    const merged = rule(value, local[key]);
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

/** Which settings this machine is not free to loosen, for /config and /status. */
export function managedKeys(managed = {}) {
  return Object.keys(managed || {}).filter(k => MERGE[k]).sort();
}

// ── the cache ───────────────────────────────────────────────────────────────

/** The config a decision actually uses: local, floored by the tenant's. */
export const effective = (cfg = {}) => merge(cfg, readManaged());

// How often SessionStart goes to the network. A session start is a foreground
// moment -- someone is waiting -- so most of them read the cache and return.
const REFRESH_MS = 60 * 60 * 1000;

export function stale({ now = Date.now } = {}) {
  try {
    const d = JSON.parse(readFileSync(CACHE, 'utf8'));
    return d.cred !== credentialId() || now() - (d.at || 0) > REFRESH_MS;
  } catch { return true; }
}

export function readManaged({ now = Date.now } = {}) {
  try {
    const d = JSON.parse(readFileSync(CACHE, 'utf8'));
    if (!d || typeof d.settings !== 'object' || d.settings === null) return {};
    // Bound to the credential it was fetched with. Signing in as another
    // tenant must not inherit the previous tenant's floor.
    if (d.cred && d.cred !== credentialId()) return {};
    if (now() - (d.at || 0) > TTL_MS) return {};
    return d.settings;
  } catch { return {}; }
}

function writeManaged(settings, at) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ at, cred: credentialId(), settings }));
  } catch { /* a cache we cannot write is a floor we do not apply */ }
}

/**
 * Fetch the tenant's managed settings and cache them. Called on SessionStart,
 * never from a decision path. Never throws.
 *
 * @returns {Promise<{ok: boolean, settings?: object, detail?: string}>}
 */
export async function refresh(cfg = {}, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 3000 } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, detail: 'no fetch in this runtime' };
  if (!credentialId()) return { ok: false, detail: 'not signed in to Enforcer' };
  try {
    const headers = await authHeaders({ fetchImpl, now });
    if (!headers['X-API-Key'] && !headers.Authorization) return { ok: false, detail: 'not signed in to Enforcer' };
    const base = (cfg.ingestUrl || baseUrl(cfg)).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}${PATH}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    const settings = body?.data?.settings;
    if (!settings || typeof settings !== 'object') return { ok: false, detail: 'no settings in the response' };
    writeManaged(settings, now());
    return { ok: true, settings };
  } catch (e) {
    const detail = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `no answer within ${timeoutMs}ms` : 'Enforcer could not be reached';
    return { ok: false, detail };
  }
}
