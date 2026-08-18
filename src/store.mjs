// Local state for the governor. No daemon, no socket, no port.
//
// v1 ran an HTTP daemon on :4000 so hooks could share state. That bought one
// thing (state in memory) and cost several: a process to manage, a port to
// collide, "is it running?" as a user-facing question, and an unauthenticated
// local API that any web page could reach. v2 keeps state in files instead.
// Nothing listens, so none of that exists.
//
// The price is a lock. Hooks are separate processes and Claude Code runs tool
// calls in parallel, so the receipt chain has the same ordering problem the
// daemon solved with a promise queue: hashes are computed in decision order,
// so the lines have to LAND in decision order. Here that is an exclusive
// lockfile held across read-decide-append.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeState } from './policy.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
export const DIR = process.env.GOVERNOR_HOME || join(HOME, '.enforcer-governor');
export const RECEIPTS = join(DIR, 'receipts.jsonl');
const STATE = join(DIR, 'state.json');
const CONFIG = join(DIR, 'config.json');
const LOCK = join(DIR, '.lock');

const sha256 = s => createHash('sha256').update(s).digest('hex');
const readJSON = (f, fallback) => {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; }
};

// ── The lock ────────────────────────────────────────────────────────────────
// `wx` fails if the file exists, and that failure is atomic on every platform
// we care about -- which is the whole mechanism. A holder that dies without
// releasing would otherwise wedge every future tool call, so a lock older than
// STALE_MS is broken rather than waited on.
const STALE_MS = 5000;
const WAIT_MS = 2000;

function acquire() {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try { closeSync(openSync(LOCK, 'wx')); return true; } catch {}
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) { unlinkSync(LOCK); continue; }
    } catch { continue; }               // vanished between the two calls: retry
    if (Date.now() > deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);  // sync sleep
  }
}
const release = () => { try { unlinkSync(LOCK); } catch {} };

// Run fn holding the lock. Returns { ok, value }. Never throws: a governor that
// crashes the hook is worse than one that fails to record.
export function withLock(fn) {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
  if (!acquire()) return { ok: false, value: undefined };
  try { return { ok: true, value: fn() }; }
  catch { return { ok: false, value: undefined }; }
  finally { release(); }
}

// policy.mjs owns the chain (record() hashes against state.prevHash), so this
// only has to carry that state across processes. `chain` is the in-memory tail
// and is deliberately not persisted: the FILE is the record, and verify()
// walks it. chainStart is set to the recovered head so an in-memory check
// starts from the oldest link this process actually knows about.
export function loadState() {
  const s = makeState();
  const saved = readJSON(STATE, null);
  if (!saved) return s;
  for (const k of ['agents', 'periods', 'burn', 'spawns', 'clients', 'unmapped', 'prevHash']) {
    if (saved[k] !== undefined) s[k] = saved[k];
  }
  s.chainStart = s.prevHash;
  return s;
}

export function saveState(s) {
  const { chain, ...rest } = s;          // never persist the tail
  try { writeFileSync(STATE, JSON.stringify(rest)); } catch {}
}
export const loadConfig = () => readJSON(CONFIG, {});
export const saveConfig = c => { try { mkdirSync(DIR, { recursive: true }); writeFileSync(CONFIG, JSON.stringify(c, null, 2)); } catch {} };

// Write the line record() already hashed. Caller holds the lock, so lines land
// in decision order -- twelve agents deciding at once was enough to interleave
// concurrent appends and break a chain that was perfectly correct in memory.
export function writeReceipt(entry, hash) {
  try { appendFileSync(RECEIPTS, JSON.stringify({ ...entry, hash }) + '\n'); return true; }
  catch { return false; }
}

// Walk the file, not memory: the file is the record. Returns the first line
// that does not add up, so an edit or a deletion anywhere is named.
export function verify(file = RECEIPTS) {
  if (!existsSync(file)) return { ok: true, receipts: 0, brokeAt: 0 };
  let prev = 'genesis', n = 0, legacy = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    n++;
    let e; try { e = JSON.parse(line); } catch { return { ok: false, receipts: n, brokeAt: n }; }
    const { hash, ...body } = e;
    if (!hash) { legacy++; continue; }
    if (sha256(prev + JSON.stringify(body)) !== hash) return { ok: false, receipts: n, brokeAt: n };
    prev = hash;
  }
  return { ok: true, receipts: n, brokeAt: 0, unverifiable: legacy || undefined, head: prev };
}
