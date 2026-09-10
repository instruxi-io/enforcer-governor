// How the edge proves who it is to the control plane.
//
// The design originally called for an Ed25519 device key per install, with the
// server verifying a signature on every receipt segment. That is the right
// shape only where the key has real custody. In a Claude Code plugin it does
// not: the runtime is Node, so the OS keychain's registered application is
// `node` — a generic interpreter it cannot distinguish from any other script
// the user runs. A private key sitting in a file readable by anything running
// as that user IS a bearer token, and dressing it in a signature ceremony
// makes it look like non-repudiation without providing any.
//
// So the edge presents an Enforcer API key instead, and the platform's
// existing machinery does the rest: ResolveUser turns the credential into an
// accessor, and rotation, revocation and scoping already exist rather than
// being reinvented here.
//
// What that keeps: the hash chain still detects edits and deletions, and the
// server still refuses a segment whose prev_hash does not match the head it
// holds for that key, so a stolen key can only ever append to its own chains.
// What it gives up, and this belongs in the ADR rather than a footnote: "this
// device signed it" becomes "someone holding this key sent it", which is a
// weaker claim to put in front of an auditor.
//
// The receipt format is kept signature-READY against the day that matters —
// key_id names what authenticated a segment, sig sits null. Adopting device
// keys later is then a column filling in, not a migration and a re-chaining of
// history. key_id also means a revoked key's segments stay identifiable after
// the fact, which is most of what a device id was for.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DIR } from './store.mjs';

const FILE = join(DIR, 'credentials.json');

/**
 * The Enforcer API key, or null when the edge is unauthenticated — which is a
 * normal state, not an error: the governor enforces locally with no account at
 * all, and a credential only buys federation.
 *
 * The environment wins over the file so CI and containers can inject one
 * without writing to a home directory that may not persist.
 */
export function enforcerKey() {
  const env = process.env.ENFORCER_API_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const k = JSON.parse(readFileSync(FILE, 'utf8'))?.enforcer?.api_key;
    return (typeof k === 'string' && k.trim()) ? k.trim() : null;
  } catch { return null; }
}

/**
 * A stable, non-secret identifier for the key that authenticated a segment.
 *
 * Derived by hashing, not by truncating. The obvious implementation takes the
 * readable prefix plus the first few characters of the secret — which is how
 * most consoles display a key, and it is fine on a screen the owner is already
 * looking at. It is NOT fine here: this value goes into every receipt and every
 * log line, where it outlives the key and travels further than it does. A hash
 * identifies the key just as stably while carrying none of it.
 */
export function keyId(key = enforcerKey()) {
  if (!key) return null;
  const [prefix] = key.split('_', 1);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 10);
  return prefix && prefix !== key ? `${prefix}_${digest}` : digest;
}

/** Whether this install can talk to a control plane at all. */
export const isFederated = () => enforcerKey() !== null;
