// Claude Code's hook JSON, turned into the core's event.
//
// Everything in here is a fact about Claude Code, which is why it moved out of
// hooks/lib.mjs: what its tools are called and which kind each one is, which
// input key holds the path or the command, how a session id becomes an agent
// id, and how to tell a subscription from an API key. The core (core/tools.mjs)
// knows none of it; it speaks `shell` and `command`, and this file is the
// dictionary between the two.
//
// The event keeps Claude's own name for the tool alongside the kind, and hands
// the core Claude's untouched tool_input as `raw`. So a receipt still says
// 'Bash', and a rewrite comes back as a tool_input Claude Code can run as it
// is -- with its description and timeout still in it.

import { SHELL, EDIT, WRITE, READ, WEB, MCP, OTHER } from '../../core/tools.mjs';

// ── the tool map ────────────────────────────────────────────────────────────
// Claude Code's tool -> the core's kind, and the core's field -> Claude's key.
// A tool missing from here is `other`: rules that name it by its own name
// ('Glob', 'Task') still match it, and so does any rule with no tool at all.
const KINDS = {
  Bash: [SHELL, { command: 'command' }],
  Edit: [EDIT, { path: 'file_path' }],
  MultiEdit: [EDIT, { path: 'file_path' }],
  NotebookEdit: [EDIT, { path: 'notebook_path' }],
  Write: [WRITE, { path: 'file_path', content: 'content' }],
  Read: [READ, { path: 'file_path' }],
  WebFetch: [WEB, { url: 'url' }],
};

/**
 * The core's kind for a Claude Code tool, and where its canonical fields live.
 * MCP tools arrive as `mcp__<server>__<tool>`; the server is the part a policy
 * is likeliest to care about, so it is lifted out.
 */
// Looked up without regard to case, as rules have always matched tool names:
// a 'bash' must not slip past a `shell` rule that a 'Bash' would have hit.
const BY_LOWER = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k.toLowerCase(), v]));

export function kindOf(name) {
  const n = String(name || '');
  const k = BY_LOWER[n.toLowerCase()];
  if (k) return { tool: k[0], fields: k[1] };
  if (n.startsWith('mcp__')) return { tool: MCP, fields: {}, server: n.split('__')[1] || '' };
  return { tool: OTHER, fields: {} };
}

// The canonical view of a tool_input: only the fields the core has names for,
// read through the map above. The original is kept whole as `raw`.
function canonical(fields, toolInput, server) {
  const out = {};
  if (toolInput && typeof toolInput === 'object') {
    for (const [field, key] of Object.entries(fields)) {
      if (toolInput[key] !== undefined) out[field] = toolInput[key];
    }
  }
  if (server !== undefined) out.server = server;
  return out;
}

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

/**
 * A PreToolUse payload as the core's event (core/governor.mjs before()).
 * The match text is built from Claude's own name and input, exactly as it
 * always was, so every pattern sees the same characters it saw before.
 */
export function toolEvent(ev) {
  const { tool, fields, server } = kindOf(ev.tool_name);
  return {
    agent: agentOf(ev),
    action: matchText(ev.tool_name, ev.tool_input),
    tool,
    name: ev.tool_name,
    input: canonical(fields, ev.tool_input, server),
    raw: ev.tool_input,
    fields,
    cwd: ev.cwd,
    billing: billing(),
    session: ev.session_id,
    transcript: ev.transcript_path,
  };
}
