#!/usr/bin/env node
// The outcome. v1 recorded only intentions -- it knew it had allowed
// `terraform apply` and never learned whether it ran. A failed call is also
// the cheap half of a retry storm: the rate-limited call returns fast, and the
// retry after it is what costs money.
import { input, emit, agentOf } from './lib.mjs';
import { getAgent, DEFAULTS } from '../src/policy.mjs';
import { withLock, loadState, saveState, loadConfig } from '../src/store.mjs';
import { kick } from '../src/ship.mjs';

const ev = input();
const failed = ev.tool_response && (ev.tool_response.is_error || ev.tool_response.error);

if (failed) {
  withLock(() => {
    const state = loadState();
    const a = getAgent(state, agentOf(ev), { ...DEFAULTS, ...loadConfig() });
    (a.fails ||= []).push(Date.now());
    while (a.fails.length > 40) a.fails.shift();
    saveState(state);
  });
}

// Ship what has been decided, without waiting: kick() spawns a detached shipper
// at most every 30s and returns immediately. No network on this path.
if (loadConfig().shipOn !== false) kick();

emit('PostToolUse', {});
