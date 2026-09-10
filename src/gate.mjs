// The gate. Composes the two layers, and owns the one thing v1 and v2 only
// ever expressed in comments: THEY FAIL IN OPPOSITE DIRECTIONS, ON PURPOSE.
//
//   capability  needs no state  ->  FAIL CLOSED
//   economics   needs state     ->  FAIL OPEN
//
// Both halves of that are load-bearing. Failing closed on spend would mean a
// governor that blocks real work over a missing file of its own, which has
// failed at something more important than enforcing. Failing open on
// capability made `rm ~/.enforcer-governor/state.json` a way to switch off
// every rule — and, worse, it was the state the tool sat in by default: on the
// machine this was found on, the v1 hook ran before all 19 tool calls of a
// session and enforced nothing, because the daemon it asked was not running.
// Every call returned "allow (not checked)" and nobody noticed.
//
// Everything the gate needs is injected. That is not ceremony: it means the
// whole decision path is testable without a lock, a disk, or a clock, and it
// is the seam where the cost source is swapped for the harness's own figure
// without any of the logic below knowing.

import { Verdict, ECONOMICS, CAPABILITY } from './verdict.mjs';
import { evaluate as capability, DEFAULT_RULES } from './capability.mjs';

/**
 * @param ev    {{action,tool,input,agent,cwd,model,task}}  what the agent wants to do
 * @param cfg   config (rulesOn / budgetOn / loopOn / rules ...)
 * @param deps  {{ withState, economics }}
 *   withState(fn) -> { ok, value }   run fn under the lock; never throws
 *   economics(state, ev, cfg) -> Verdict|null   Layer B; null means no opinion
 * @returns {Verdict}
 */
export function gate(ev, cfg = {}, deps = {}) {
  const rules = cfg.rulesOn === false ? [] : (cfg.rules || DEFAULT_RULES);

  // Layer A runs first and runs unconditionally. "You may not do this"
  // outranks "you have budget left" — a cheap command is still the destructive
  // one, and the rule that stops it must not depend on the bookkeeping being
  // healthy. It is also why this call sits ABOVE the state load rather than
  // inside its success branch.
  const cap = capability(rules, ev);
  if (cap && cap.action !== 'allow') return cap;

  // Spend and loop off does NOT mean capability off — hence this sitting below
  // the call above rather than at the top of the function, which is where v2
  // had it. There it returned early on `budgetOn === false && loopOn === false`
  // and took the capability rules down with it, whatever `rulesOn` said. The
  // README has always described three independent switches ("rulesOn the
  // capability rules ... all three off is fully inert"), so the code and the
  // documented contract disagreed, and the code was the wrong one: turning off
  // spend tracking silently gave up `curl | sh` and `rm -rf` as well. Nothing
  // in the suite pinned it, which is why it survived.
  if (cfg.budgetOn === false && cfg.loopOn === false) {
    return Verdict.allow('spend and loop checks are switched off',
      { source: ECONOMICS, checked: [CAPABILITY, ECONOMICS] });
  }

  // withState hands back a `reading` alongside the state: what this session has
  // cost so far. It is passed IN rather than computed here on purpose — that is
  // the seam where the harness's own total_cost_usd replaces our arithmetic
  // without a single check in economics.mjs knowing the difference.
  const held = typeof deps.withState === 'function'
    ? deps.withState((state, reading) => deps.economics(state, { ...ev, ...(reading || {}) }, cfg))
    : { ok: false };

  // The blind path. Capability already had its say above and found nothing, so
  // the honest answer is "allowed, and I did not look at the money" — recorded
  // as such via checked[], not buried in a sentence a reader has to parse.
  if (!held.ok) {
    return Verdict.allow('Enforcer could not read its own state, so spend was not checked. Nothing is blocked.',
      { source: ECONOMICS, checked: [CAPABILITY] });
  }

  const econ = held.value;
  if (econ) return econ;
  return Verdict.allow('in budget', { source: ECONOMICS, checked: [CAPABILITY, ECONOMICS] });
}
