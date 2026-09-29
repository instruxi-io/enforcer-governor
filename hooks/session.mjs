#!/usr/bin/env node
// Session boundaries. SessionEnd closes the record with what the session
// actually cost -- a summary an audit can read without replaying every line.
import { input, emit, done } from './lib.mjs';
import { agentOf } from '../adapters/claude-code/events.mjs';
import { DEFAULTS } from '../src/policy.mjs';
import { loadConfig } from '../src/store.mjs';
import { sweep } from '../adapters/claude-code/sweep.mjs';
import { recordPluginRoot } from '../adapters/claude-code/telemetry.mjs';
import { governor } from '../adapters/claude-code/index.mjs';

const ev = input();
const EVENT = ev.hook_event_name === 'SessionEnd' ? 'SessionEnd' : 'SessionStart';
const gov = governor();
const event = { agent: agentOf(ev), session: ev.session_id, transcript: ev.transcript_path, cwd: ev.cwd };

// SessionEnd closes the record with what the session cost (core/governor.mjs):
// Claude Code's own figure where it is fresh, the transcript's otherwise.
if (EVENT === 'SessionEnd') gov.session.end(event);

// Where this plugin version lives. Claude Code's otelHeadersHelper points at a
// stable shim in ~/.enforcer, which reads this, so a plugin update (which moves
// the plugin to a new versioned directory) never leaves telemetry signed out.
if (EVENT === 'SessionStart') recordPluginRoot();

// A session's end is the natural moment to catch up; its summary receipt was
// just written, so the 30s throttle is bypassed.
gov.flush(EVENT === 'SessionEnd' ? 0 : 30_000);

// A session's start is the moment to pick up the tenant's managed floor; skipped
// when the cached copy is fresh. It is also when the session's project is told
// to the control plane (core/attribution.mjs): one short, best-effort request
// when signed in, so the session is filed under its project even if it never
// makes a governed decision. Only with a real session id -- agentOf's
// 'claude-code' fallback names no one session.
if (EVENT === 'SessionStart') await gov.session.start(ev.session_id ? { agent: event.agent, cwd: ev.cwd } : {});

// ...and to tidy up Claude Code's scratch files: old sessions' only, by age.
if (EVENT === 'SessionEnd') { try { sweep({ ...DEFAULTS, ...loadConfig() }); } catch {} }

if (EVENT === 'SessionEnd') done();
emit(EVENT, {});
