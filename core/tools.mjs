// The tool vocabulary the core speaks, so a rule is written once for every
// harness.
//
// Until now the rules named Claude Code's tools: `tool: 'Bash'`, and the input
// key a rewrite edits was Claude's `command`. That was fine while Claude Code
// was the only harness, and it is the reason a second one could not reuse the
// rules without a copy: Codex calls its shell tool something else, an MCP proxy
// sees every call as a call to some server's tool, and a rule that says 'Bash'
// quietly matches none of it -- which is the one direction a guard must never
// fail in.
//
// So the core has its own small vocabulary, and each adapter maps its harness
// onto it:
//
//   shell   run a command                    field: command
//   edit    change part of an existing file  field: path
//   write   create or replace a file         fields: path, content
//   read    read a file                      field: path
//   web     fetch a URL                      field: url
//   mcp     a call to an MCP server's tool   fields: server (and the tool's own)
//   other   anything the adapter cannot place
//
// An event carries BOTH names: `tool` is the kind above, `name` is what the
// harness called it ('Bash', 'MultiEdit', 'mcp__github__create_issue'). The
// kind is what a rule matches; the name is what a receipt records, so the
// record and the console read exactly as they did before this file existed.
//
// COMPATIBILITY. Rules already written -- the defaults until now, custom rules
// in people's config.json, a tenant's managed rules -- name tools the harness's
// way. Those keep working, with the meaning they always had:
//   - a rule whose tool is a canonical word (lowercase, exactly as above)
//     matches that kind of tool, from any harness;
//   - any other tool name matches the harness's own name, case-insensitively,
//     which is precisely how every rule was matched before;
//   - 'Bash' is ALSO read as `shell`, so the most common rule anyone has
//     written reaches a shell tool in a harness that does not call it Bash. For
//     Claude Code the two readings are the same set of calls, since Bash is its
//     only shell tool.
// The one rule whose reach changes is a lowercase `edit`: it used to match
// Claude's Edit alone and now matches MultiEdit and NotebookEdit as well. It
// can only grow stricter -- rules ask, rewrite or deny, never allow -- and a
// rule that meant "editing" was already missing the other two.
//
// Keep this file pure, like capability.mjs, which depends on it: no store, no
// disk, no network. It is on the fail-closed path.

export const SHELL = 'shell';
export const EDIT = 'edit';
export const WRITE = 'write';
export const READ = 'read';
export const WEB = 'web';
export const MCP = 'mcp';
export const OTHER = 'other';
export const TOOLS = Object.freeze([SHELL, EDIT, WRITE, READ, WEB, MCP, OTHER]);

/** The input fields a canonical rule may name. An adapter maps them to its own keys. */
export const FIELDS = Object.freeze(['command', 'path', 'content', 'url']);

// Harness tool names a rule may use that the core reads as a kind as well as a
// name. Deliberately short: only names that mean the same thing in every
// harness belong here, and each one is a promise not to take it back.
const LEGACY = Object.freeze({ bash: SHELL });

const isKind = (t) => typeof t === 'string' && TOOLS.includes(t);

/**
 * What the harness called the tool. Older callers put it in `tool` and never
 * set `name`; the action text's prefix ("Bash:...") is the last resort, kept
 * because a missing tool used to make every rule quietly miss.
 */
export function nameOf(ev) {
  if (ev?.name) return String(ev.name);
  if (ev?.tool && !isKind(ev.tool)) return String(ev.tool);
  return String(ev?.action || '').split(':')[0] || '';
}

/** The canonical kind of the tool in an event. */
export function kindOf(ev) {
  if (isKind(ev?.tool)) return ev.tool;
  return LEGACY[nameOf(ev).toLowerCase()] || OTHER;
}

/**
 * Does a rule's `tool` cover this event? An empty tool means any tool. See the
 * compatibility notes at the top for why there are three ways to say yes.
 */
export function toolMatches(ruleTool, ev) {
  if (!ruleTool) return true;
  const t = String(ruleTool);
  if (isKind(t)) return t === kindOf(ev);
  const lower = t.toLowerCase();
  if (lower === nameOf(ev).toLowerCase()) return true;
  return LEGACY[lower] !== undefined && LEGACY[lower] === kindOf(ev);
}

/**
 * The key in the harness's own input that a rule's `field` names. A canonical
 * field goes through the adapter's map (`ev.fields`: canonical -> native, e.g.
 * { path: 'file_path' }); anything else is taken as the harness's own key,
 * which is what a rule written before this vocabulary meant by it.
 */
export function nativeField(field, ev) {
  return (ev?.fields && typeof ev.fields[field] === 'string') ? ev.fields[field] : field;
}
