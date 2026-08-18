#!/usr/bin/env node
// Session boundaries. SessionEnd closes the record with what the session
// actually cost -- a summary an audit can read without replaying every line.
import { createHash } from 'node:crypto';
import { input, emit, agentOf } from './lib.mjs';
import { readUsage } from '../src/usage.mjs';
import { priceOf, dollarsForTokens } from '../src/policy.mjs';
import { withLock, loadState, saveState, writeReceipt } from '../src/store.mjs';

const ev = input();
const EVENT = ev.hook_event_name === 'SessionEnd' ? 'SessionEnd' : 'SessionStart';

if (EVENT === 'SessionEnd') {
  withLock(() => {
    const state = loadState();
    const agent = agentOf(ev);
    const { tokens, model } = readUsage(ev.session_id, ev.transcript_path);
    const a = state.agents[agent];
    if (!a && !tokens) return;
    const usd = dollarsForTokens(tokens, priceOf(model).in);
    const entry = { ts: Date.now(), agent, verdict: 'summary',
      reason: `session ended after $${usd.toFixed(2)}`, tokens: Math.round(tokens),
      ...(model ? { model } : {}), ...(a?.client ? { client: a.client } : {}),
      ...(a?.operator ? { operator: a.operator } : {}) };
    const hash = createHash('sha256').update(state.prevHash + JSON.stringify(entry)).digest('hex');
    writeReceipt(entry, hash);
    state.prevHash = hash;
    saveState(state);
  });
}

emit(EVENT, {});
