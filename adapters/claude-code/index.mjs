// The Claude Code adapter: how Claude Code measures spend, bound to the core.
// The hooks in hooks/ are the rest of it -- they read Claude Code's hook JSON,
// call the governor, and answer in Claude Code's permission vocabulary.
import { readFileSync } from 'node:fs';
import { createGovernor } from '../../core/governor.mjs';
import { read, harnessUsd, HARNESS, TRANSCRIPT } from './meter.mjs';
import { readUsage } from './usage.mjs';

/**
 * Claude Code's spend: its transcript for the model and the tokens, and the
 * status line's total_cost_usd where it is fresh. Claude Code prices a session
 * at the organisation's CONTRACTED rates, which no table can know, so its
 * figure wins where we have it; `source` says which one answered.
 */
export const cost = {
  read: (event, cfg) => read(event.session, event.transcript, cfg),
  total: (event) => {
    const { tokens, model } = readUsage(event.session, event.transcript);
    const usd = harnessUsd(event.session);
    return { tokens, model, usd, source: usd === null ? TRANSCRIPT : HARNESS };
  },
};

// The adapter's version is the plugin's: this adapter ships inside the plugin
// and changes with it. Read once per hook process; a package.json that cannot
// be read costs the receipts a label, never a decision.
export const HARNESS_NAME = 'claude-code';
export const ADAPTER_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || ''); }
  catch { return ''; }
})();

export const governor = () => createGovernor({ harness: HARNESS_NAME, adapterVersion: ADAPTER_VERSION, cost });
