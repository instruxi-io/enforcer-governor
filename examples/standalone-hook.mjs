#!/usr/bin/env node
// A zero-install Claude Code PreToolUse hook.
//
// src/hook.mjs is the real one and does more: it reads the session transcript
// and prices cost-weighted effective tokens before asking. This is the version
// you can paste into a project without installing the package, for people who
// would rather read 40 lines than trust an npx. It needs the governor already
// running (npx --yes enforcer-governor start) and asks it over HTTP.
//
// Contract learned the hard way: exit 0 and print JSON. Exiting 2 WITH JSON is
// ignored by Claude Code.
import { readFileSync } from 'node:fs';

const PORT = process.env.GOVERNOR_PORT || 4000;

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,          // allow | deny | ask
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let event = {};
try { event = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* fall through */ }

// Shape matters: the capability rules regex-match against `action`, which is
// the tool name and its serialised input in one string. `tool` is matched
// separately, and an empty rule tool means any tool.
const body = JSON.stringify({
  agent: event.session_id || 'claude-code',
  tool: event.tool_name,
  action: `${event.tool_name || 'tool'}:${JSON.stringify(event.tool_input ?? '').slice(0, 200)}`,
  tokens: 0,                                  // this shim does not meter; the governor still rate-limits
  cwd: event.cwd,
});

try {
  const res = await fetch(`http://localhost:${PORT}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(2000),
  });
  const r = await res.json();
  if (r.verdict === 'deny') emit('deny', `Enforcer refused this: ${r.reason}.`);
  if (r.verdict === 'escalate') emit('ask', `Enforcer wants you to confirm: ${r.reason}. Allow it this once?`);
  emit('allow', 'Enforcer: allowed');
} catch {
  // Fail OPEN, deliberately. A guard that breaks the agent when the guard
  // itself is down is a worse outcome than a missed check, and a hook that
  // hangs blocks every tool call. Run the real hook if you want fail-closed.
  emit('allow', 'Enforcer: not running, allowed without a check');
}
