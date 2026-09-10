#!/usr/bin/env node
// Fan-out, counted rather than inferred.
//
// An orchestrator that spawns spawners is exponential, so what matters is the
// SHAPE of the arrival, not the eventual count. v2 approximated this by
// noticing new agent ids appearing in state — which meant a subagent that
// never made a tool call was invisible, and the burst was always measured late.
// SubagentStart is the event itself.
import { input, emit, agentOf } from './lib.mjs';
import { withLock, loadState, saveState } from '../src/store.mjs';

const ev = input();
const EVENT = ev.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'SubagentStart';

if (EVENT === 'SubagentStart') {
  withLock(() => {
    const state = loadState();
    const now = Date.now();
    // Same shape getAgent() writes, so spawnRate() reads both without caring
    // which noticed the subagent first. The id is what the harness calls it
    // where it gives us one; a start event without one still counts.
    (state.spawns ||= []).push({ t: now, id: ev.session_id ? agentOf(ev) : 'subagent' });
    // A minute is the window every rate check here uses; keep a little more
    // than that so a burst spanning the boundary is still visible.
    state.spawns = state.spawns.filter(s => s.t > now - 120000);
    saveState(state);
  });
}

emit(EVENT, {});
