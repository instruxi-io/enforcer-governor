#!/usr/bin/env node
// Session boundaries. SessionEnd closes the record with what the session
// actually cost -- a summary an audit can read without replaying every line.
import { createHash } from 'node:crypto';
import { input, emit, agentOf } from './lib.mjs';
import { readUsage } from '../src/usage.mjs';
import { priceOf, dollarsForTokens, DEFAULTS } from '../src/policy.mjs';
import { costUsd, harnessUsd, HARNESS, TRANSCRIPT } from '../src/meter.mjs';
import { withLock, loadState, saveState, writeReceipt, loadConfig } from '../src/store.mjs';
import { kick } from '../src/ship.mjs';
import { sweep } from '../src/sweep.mjs';
import { recordPluginRoot } from '../src/telemetry.mjs';

const ev = input();
const EVENT = ev.hook_event_name === 'SessionEnd' ? 'SessionEnd' : 'SessionStart';

if (EVENT === 'SessionEnd') {
  withLock(() => {
    const state = loadState();
    const agent = agentOf(ev);
    const { tokens, model } = readUsage(ev.session_id, ev.transcript_path);
    const a = state.agents[agent];
    if (!a && !tokens) return;
    // The harness's own total when it is fresh, our arithmetic when it is not.
    // Claude Code prices a session at the organisation's CONTRACTED rates,
    // which no third-party table can know, so its figure wins where we have it
    // — and `meter` records which of the two this receipt is reporting, so an
    // auditor is not left inferring it.
    const harness = harnessUsd(ev.session_id);
    const usd = harness ?? dollarsForTokens(tokens, priceOf(model).in);
    const source = harness === null ? TRANSCRIPT : HARNESS;
    // ONE number, two readers: the sentence a person reads and the field a
    // machine sums. They are the same figure so a receipt cannot say $6.34 in
    // prose and something else in its field.
    const cost = costUsd(usd);
    const entry = { ts: new Date().toISOString(), agent, verdict: 'summary',
      reason: `session ended after $${usd.toFixed(2)}`, tokens: Math.round(tokens),
      ...(model ? { model } : {}), ...(a?.client ? { client: a.client } : {}),
      ...(a?.operator ? { operator: a.operator } : {}),
      // Appended last so every field above keeps its position in the hash: a
      // receipt written by an older governor and one written by this version
      // chain together, because each hash only ever covers its own bytes.
      meter: source,
      ...(cost === undefined ? {} : { cost_usd: cost }) };
    const hash = createHash('sha256').update(state.prevHash + JSON.stringify(entry)).digest('hex');
    writeReceipt(entry, hash);
    state.prevHash = hash;
    saveState(state);
  });
}

// Where this plugin version lives. Claude Code's otelHeadersHelper points at a
// stable shim in ~/.enforcer, which reads this, so a plugin update (which moves
// the plugin to a new versioned directory) never leaves telemetry signed out.
if (EVENT === 'SessionStart') recordPluginRoot();

// A session's end is the natural moment to catch up; its summary receipt was
// just written. The 30s throttle is bypassed so the last receipts are not left
// waiting for a session that is not coming.
const cfg = loadConfig();
if (cfg.shipOn !== false) kick(EVENT === 'SessionEnd' ? 0 : 30_000);

// ...and to tidy up. Old sessions' scratch files only, by age — never this
// session's, which /clear and --resume would both bring back. Best-effort and
// silent: a sweep that failed is not something to interrupt anyone with.
if (EVENT === 'SessionEnd') { try { sweep({ ...DEFAULTS, ...cfg }); } catch {} }

emit(EVENT, {});
