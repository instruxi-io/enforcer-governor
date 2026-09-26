// What a verdict becomes in a harness that cannot do what it asks.
//
// The core answers allow, deny, ask or rewrite, and it answers the same way
// for every harness: whether a person can be asked, or an input swapped, is
// not something a rule should know. But an adapter has to do SOMETHING with an
// ask its harness cannot show and a rewrite its harness cannot run, and the
// one thing it must never do is let the call through. That rule is the same
// in every adapter (plan section 3.4), so it lives here once rather than in
// each adapter's own words:
//
//   - `ask` with no way to ask becomes `deny`. It fails closed, because only a
//     rule that wanted a person to look produces `ask`, and nobody looked.
//   - `rewrite` with no way to rewrite becomes `deny`, and the reason names
//     the safer form -- "use --force-with-lease" -- so the agent can run that
//     instead of stopping. Running the ORIGINAL, which is what an adapter that
//     ignored the rewrite would do, is exactly the action the rule exists to
//     prevent.
//
// The degraded verdict keeps the original's source, rule, checked layers and
// tenant opinion, so it reads the same to the adapter's wording (a capability
// refusal still refuses the action and does not stop the agent). It is NOT
// what the receipt records: the core writes the receipt inside before(), with
// the verdict the rules produced, and the record says what was decided rather
// than how one harness managed to show it. An adapter degrades AFTER before().
//
// Pure, like verdict.mjs: no store, no disk, no network.

import { Verdict, ASK, REWRITE } from './verdict.mjs';

// The part of the rewritten input that differs from what the agent sent: the
// safer form, in the harness's own terms. Only string values are quoted -- a
// rule rewrites text -- and the order is the input's own.
function saferForm(raw, input) {
  if (!input || typeof input !== 'object') return [];
  const before = raw && typeof raw === 'object' ? raw : {};
  return Object.keys(input).filter((k) => typeof input[k] === 'string' && input[k] !== before[k]).map((k) => input[k]);
}

/**
 * @param {Verdict} verdict  what before() decided
 * @param {object}  caps
 * @param {boolean} [caps.canAsk=true]      can the harness put a question to a person?
 * @param {boolean} [caps.canRewrite=true]  can the harness run a different input?
 * @param {object}  [caps.raw]  the harness's own input as the agent sent it, so
 *   a refused rewrite can name what changed; without it the whole rewritten
 *   input's text values are named.
 * @returns {{ verdict: Verdict, degraded: null | 'ask' | 'rewrite' }}
 *   `degraded` says which answer the harness could not give, so the adapter
 *   can say so; null when the verdict stands as it was.
 */
export function degrade(verdict, { canAsk = true, canRewrite = true, raw } = {}) {
  if (!verdict) return { verdict, degraded: null };
  const keep = { source: verdict.source, rule: verdict.rule, checked: verdict.checked, policy: verdict.policy };

  if (verdict.action === ASK && !canAsk) {
    return { verdict: Verdict.deny(`${verdict.reason}, and there is no way to ask a person to confirm it here`, keep), degraded: ASK };
  }

  if (verdict.action === REWRITE && !canRewrite) {
    const safer = saferForm(raw, verdict.input);
    const use = safer.length ? `; run the safer form instead: ${safer.map((s) => '`' + s + '`').join(', ')}` : '';
    return { verdict: Verdict.deny(`${verdict.reason}${use}`, keep), degraded: REWRITE };
  }

  return { verdict, degraded: null };
}
