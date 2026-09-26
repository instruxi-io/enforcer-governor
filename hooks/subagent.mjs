#!/usr/bin/env node
// Fan-out, counted rather than inferred.
//
// An orchestrator that spawns spawners is exponential, so what matters is the
// SHAPE of the arrival, not the eventual count. v2 approximated this by
// noticing new agent ids appearing in state — which meant a subagent that
// never made a tool call was invisible, and the burst was always measured late.
// SubagentStart is the event itself.
import { input, emit, agentOf } from './lib.mjs';
import { governor } from '../adapters/claude-code/index.mjs';

const ev = input();
const EVENT = ev.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'SubagentStart';

// The id is what the harness calls the subagent where it gives us one; a start
// event without one still counts.
if (EVENT === 'SubagentStart') governor().spawned(ev.session_id ? agentOf(ev) : 'subagent');

emit(EVENT, {});
