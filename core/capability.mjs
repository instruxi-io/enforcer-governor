// Layer A — what an agent may DO. A pure function of the action text.
//
// This layer is the security-critical half and it is deliberately the half
// that needs no state at all: patterns matched against what the agent is about
// to run, nothing read, nothing written. That is what lets it FAIL CLOSED
// while the spend checks fail open. v1 got this exactly backwards — the daemon
// held both, so when it was down (which, on the machine this was found on, was
// its normal state) `curl | sh` and `rm -rf` sailed through along with the
// budget. Deleting the state directory turned every rule off.
//
// Keep the invariant when editing: nothing in this file may import the store,
// read a file, or touch the network. If a rule ever needs to know what the
// agent has spent, it belongs in economics.mjs, not here.

import { Verdict, CAPABILITY } from './verdict.mjs';
import { toolMatches, nativeField } from './tools.mjs';

// `action` is the text a rule matches; `tool` scopes it ('' means any tool).
// `field` names the input key a rewrite edits. Both are in the core's own
// vocabulary (tools.mjs): `shell` and `command`, not Claude Code's `Bash` --
// which a rule may still say, and which still means the same thing.
//
// `id` is the rule's name in a TENANT POLICY: the governor asks Enforcer about
// `agent_action` resources whose id is this, so a policy can say "deploy.publish
// needs an elevated account" without matching command text itself. Ids are a
// published vocabulary — renaming one silently detaches every policy written
// against it, so add new ones rather than rename. `authz` is the action the
// question is asked as: read or write. Not manage: the platform's owner
// baseline never grants `manage`, so for an ordinary user every manage question
// is refused by the platform before the tenant policy is consulted at all. The
// rule id already tells a policy WHICH action this is; the verb only has to get
// the question past the platform.
export const DEFAULT_RULES = [
  { id: 'shell.pipe_to_shell', authz: 'write',
    name: 'pipe the internet into a shell', tool: 'shell', action: 'deny',
    match: '(curl|wget)[^|]*\\|\\s*(ba|z|fi)?sh' },

  // A force-push is the one dangerous git action with a strictly safer form
  // that preserves the intent: --force-with-lease refuses when someone else
  // has pushed since you last fetched, which is the case that loses work.
  // Rewriting is honest here in a way it would not be for, say, turning a
  // kubectl delete into --dry-run — that does not do what was asked at all.
  { id: 'git.force_push', authz: 'write',
    name: 'force-push without a lease', tool: 'shell', action: 'rewrite',
    match: 'git\\s+push\\s+(?:[^|;&]*\\s)?(--force|-f)(?=\\s|$)', field: 'command',
    replace: ['(--force|-f)(?=\\s|$)', '--force-with-lease'],
    why: 'a lease refuses the push if someone else has pushed since your last fetch' },

  { id: 'fs.delete_tree', authz: 'write',
    name: 'delete a whole tree', tool: 'shell', action: 'ask',
    match: 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)' },
  { id: 'git.rewrite_history', authz: 'write',
    name: 'rewrite git history', tool: 'shell', action: 'ask',
    match: 'reset\\s+--hard|filter-branch' },
  { id: 'secrets.access', authz: 'read',
    name: 'read or write credentials', tool: '', action: 'ask',
    match: '\\.env\\b|id_rsa|\\.pem\\b|credentials\\.json|\\.aws/|\\.ssh/' },
  { id: 'deploy.publish', authz: 'write',
    name: 'publish or deploy', tool: 'shell', action: 'ask',
    match: 'npm\\s+publish|vercel\\s+.*--prod|kubectl\\s+(apply|delete)|terraform\\s+apply' },
];

/**
 * A rule's policy id. A custom rule in config.json may not carry one, so it is
 * derived from the name — stable for as long as the name is, which is the most
 * a rule without an explicit id can promise.
 */
export function ruleId(rule) {
  if (rule?.id) return String(rule.id);
  return 'custom.' + String(rule?.name || 'rule').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** The authorization action a rule is asked about. Unknown means the widest. */
export function ruleAuthz(rule) {
  return rule?.authz === 'read' ? 'read' : 'write';
}

/** First rule whose tool and pattern both match. Null when nothing matches. */
export function matchRule(rules, ev) {
  const text = String(ev.action || '');
  // Which tool this is, and whether a rule covers it, is tools.mjs's to say:
  // the kind (`shell`) for a rule in the core's vocabulary, the harness's own
  // name for a rule written the old way. It still falls back to the prefix of
  // the action ("Bash:...") when the caller did not name the tool -- a missing
  // field used to make every capability rule quietly miss, which fails in the
  // one direction a guard must never fail in.
  for (const r of rules || []) {
    if (!toolMatches(r.tool, ev)) continue;
    let re;
    try { re = new RegExp(r.match, 'i'); } catch { continue; }  // a bad pattern must not break the check
    if (re.test(text)) return r;
  }
  return null;
}

// Build the replacement input for a rewrite rule. Returns null when the edit
// would not actually change anything, which demotes the rule to an ask:
// claiming to have made something safer without having done so is worse than
// admitting the pattern was not handled.
//
// The rewrite is made to the harness's OWN input (`ev.raw`), with the rule's
// field translated to the harness's key, so what comes back is exactly what
// the harness runs -- every other key it sent (a description, a timeout) kept
// as it was. A caller that sends no raw input is rewritten in `ev.input`.
function rewriteInput(rule, ev) {
  if (!rule.replace || !rule.field) return null;
  const input = ev.raw ?? ev.input;
  const key = nativeField(rule.field, ev);
  const before = input?.[key];
  if (typeof before !== 'string') return null;
  let re;
  try { re = new RegExp(rule.replace[0], 'gi'); } catch { return null; }
  const after = before.replace(re, rule.replace[1]);
  return after === before ? null : { ...input, [key]: after };
}

/**
 * Evaluate the capability layer.
 * @returns {Verdict|null} null means "no rule had an opinion" — NOT "allowed".
 *   The caller decides what silence means; here it only ever means this layer
 *   is finished, and economics still gets its turn.
 */
export function evaluate(rules, ev) {
  const hit = matchRule(rules || DEFAULT_RULES, ev);
  if (!hit) return null;
  const of = { source: CAPABILITY, rule: hit.name, checked: [CAPABILITY] };

  if (hit.action === 'deny') {
    // Refuse the ACTION, do not stop the agent. A capability check says "not
    // that", never "you are finished" — stopping here once meant a single
    // blocked command silently turned every later verdict into "agent stopped".
    return Verdict.deny(`not allowed to ${hit.name}`, of);
  }

  if (hit.action === 'rewrite') {
    const input = rewriteInput(hit, ev);
    if (input) return Verdict.rewrite(input, `${hit.name} — ${hit.why}`, of);
    return Verdict.ask(`would ${hit.name}`, of);   // could not make it safer; ask instead
  }

  // Deliberately does not latch anything: every separate dangerous action
  // deserves its own answer, not one blanket approval for the session.
  return Verdict.ask(`would ${hit.name}`, of);
}
