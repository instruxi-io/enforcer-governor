// Shared plumbing for every hook in this plugin.
//
// The contract that actually works: exit 0 and print JSON. Never exit 2 with
// JSON -- that combination is ignored.
import { readFileSync } from 'node:fs';

export function input() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// `top` carries the universal fields -- systemMessage above all. They belong
// at the top level of the JSON, not inside hookSpecificOutput; nested there,
// Claude Code never showed them.
export function emit(eventName, out, top = {}) {
  process.stdout.write(JSON.stringify({ ...top, hookSpecificOutput: { hookEventName: eventName, ...out } }));
  process.exit(0);
}

// No objection: say nothing. A PreToolUse hook that returns no
// permissionDecision hands the call to the user's own permission flow -- their
// /permissions rules, their mode, their prompts -- exactly as if this plugin
// were not installed. That is what failing open, and passing ordinary work,
// have to mean.
//
// Not `allow`: that is an affirmative grant that skips the prompt the user
// would otherwise have seen. And not `defer`, which is what this used to send.
// `defer` is not "no opinion" -- it is Claude Code's pause-and-resume signal
// for `claude -p` hosts. Interactive sessions ignore it with a warning (so it
// looked fine), but a headless run stops at the tool call and exits
// `tool_deferred`, and its reason and updatedInput are discarded everywhere.
export const pass = (event, top = {}) => emit(event, {}, top);

// What Claude Code's hook JSON MEANS -- the tool map, the match text, the agent
// id, the billing mode -- is in adapters/claude-code/events.mjs. This file is
// only the stdin/stdout contract.
