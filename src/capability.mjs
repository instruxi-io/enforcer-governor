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

// `action` is the text a rule matches; `tool` scopes it ('' means any tool).
// `field` names the tool_input key a rewrite edits.
export const DEFAULT_RULES = [
  { name: 'pipe the internet into a shell', tool: 'Bash', action: 'deny',
    match: '(curl|wget)[^|]*\\|\\s*(ba|z|fi)?sh' },

  // A force-push is the one dangerous git action with a strictly safer form
  // that preserves the intent: --force-with-lease refuses when someone else
  // has pushed since you last fetched, which is the case that loses work.
  // Rewriting is honest here in a way it would not be for, say, turning a
  // kubectl delete into --dry-run — that does not do what was asked at all.
  { name: 'force-push without a lease', tool: 'Bash', action: 'rewrite',
    match: 'git\\s+push\\s+(?:[^|;&]*\\s)?(--force|-f)(?=\\s|$)', field: 'command',
    replace: ['(--force|-f)(?=\\s|$)', '--force-with-lease'],
    why: 'a lease refuses the push if someone else has pushed since your last fetch' },

  { name: 'delete a whole tree', tool: 'Bash', action: 'ask',
    match: 'rm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)' },
  { name: 'rewrite git history', tool: 'Bash', action: 'ask',
    match: 'reset\\s+--hard|filter-branch' },
  { name: 'read or write credentials', tool: '', action: 'ask',
    match: '\\.env\\b|id_rsa|\\.pem\\b|credentials\\.json|\\.aws/|\\.ssh/' },
  { name: 'publish or deploy', tool: 'Bash', action: 'ask',
    match: 'npm\\s+publish|vercel\\s+.*--prod|kubectl\\s+(apply|delete)|terraform\\s+apply' },
];

/** First rule whose tool and pattern both match. Null when nothing matches. */
export function matchRule(rules, ev) {
  const text = String(ev.action || '');
  // Fall back to the prefix of the action ("Bash:...") when the caller did not
  // name the tool. A missing field used to make every capability rule quietly
  // miss, which fails in the one direction a guard must never fail in.
  const tool = String(ev.tool || text.split(':')[0] || '').toLowerCase();
  for (const r of rules || []) {
    if (r.tool && r.tool.toLowerCase() !== tool) continue;
    let re;
    try { re = new RegExp(r.match, 'i'); } catch { continue; }  // a bad pattern must not break the check
    if (re.test(text)) return r;
  }
  return null;
}

// Build the replacement tool_input for a rewrite rule. Returns null when the
// edit would not actually change anything, which demotes the rule to an ask:
// claiming to have made something safer without having done so is worse than
// admitting the pattern was not handled.
function rewriteInput(rule, input) {
  if (!rule.replace || !rule.field) return null;
  const before = input?.[rule.field];
  if (typeof before !== 'string') return null;
  let re;
  try { re = new RegExp(rule.replace[0], 'gi'); } catch { return null; }
  const after = before.replace(re, rule.replace[1]);
  return after === before ? null : { ...input, [rule.field]: after };
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
    const input = rewriteInput(hit, ev.input);
    if (input) return Verdict.rewrite(input, `${hit.name} — ${hit.why}`, of);
    return Verdict.ask(`would ${hit.name}`, of);   // could not make it safer; ask instead
  }

  // Deliberately does not latch anything: every separate dangerous action
  // deserves its own answer, not one blanket approval for the session.
  return Verdict.ask(`would ${hit.name}`, of);
}
