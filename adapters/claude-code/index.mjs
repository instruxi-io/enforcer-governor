// The Claude Code adapter: how Claude Code measures spend, bound to the core.
// The hooks in hooks/ are the rest of it -- they read Claude Code's hook JSON,
// call the governor, and answer in Claude Code's permission vocabulary.
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

export const governor = () => createGovernor({ harness: 'claude-code', cost });
