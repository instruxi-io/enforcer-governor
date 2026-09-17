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

// ── What the capability rules get to see ────────────────────────────────────
// Whatever this leaves out is unenforced. v1 truncated to 200 characters,
// which meant `rm -rf` on the far side of a long command was invisible and
// padding the front of a command walked past every rule. Fields the rules care
// about go FIRST, where a cap cannot displace them; bulk content (a file body)
// is deliberately not promoted -- no rule matches file contents, and hoisting
// them would sweep source code into the match text for nothing.
const FIELDS = ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern'];
const CAP = 8192;

export function matchText(tool, toolInput) {
  const name = tool || 'tool';
  if (toolInput == null) return `${name}:`;
  if (typeof toolInput !== 'object') return `${name}:${String(toolInput).slice(0, CAP)}`;
  const front = [];
  for (const k of FIELDS) if (typeof toolInput[k] === 'string' && toolInput[k]) front.push(toolInput[k]);
  let rest = ''; try { rest = JSON.stringify(toolInput); } catch {}
  return `${name}:${[...front, rest].join('\n').slice(0, CAP)}`;
}

export const agentOf = ev => ev.session_id ? 'claude:' + String(ev.session_id).slice(0, 8) : 'claude-code';

// Which wallet is paying. On a plan Claude Code is flat-rate; an API key in the
// environment moves the same work onto per-token billing, which is where the
// nastiest surprise bills come from. We can see the key is set, not that it was
// used, so this is reported and never acted on.
export const billing = () =>
  (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) ? 'api' : 'plan';
