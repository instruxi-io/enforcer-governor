// The answer to "may this agent do this, right now?", as a value.
//
// v2 returned an ad-hoc object from decide() and rebuilt the same shape in
// four other places, so every caller re-derived what a verdict meant: the hook
// tested `!!(r.entry && r.entry.rule)` to work out whether a refusal came from
// a capability rule or a spend limit, because nothing said so directly. Those
// are different events for the person reading them — one blocks an action and
// the agent carries on, the other stops the agent — and they must not read the
// same. Making the distinction a field rather than an inference is most of why
// this file exists.
//
// Two other things are recorded here that v2 left in prose. `checked` says
// which layers actually ran: when the governor cannot read its own state it
// still answers, and the difference between "allowed, in budget" and "allowed,
// did not look" belongs in the record rather than only in a sentence. And
// `source` names the layer that decided, which is what lets the receipt say
// who refused without the reader parsing English.

export const ALLOW = 'allow';
export const DENY = 'deny';
export const ASK = 'ask';
// New in v3. A rewrite is not a softer deny: it lets the action run in a form
// the policy accepts — --dry-run added, an rm narrowed, a --depth pinned. It
// is the verdict that does not cost the user their flow, and it is the one
// that most needs an audit trail, because it changes what the agent asked for.
export const REWRITE = 'rewrite';

export const CAPABILITY = 'capability';
export const ECONOMICS = 'economics';
export const OPERATOR = 'operator';

export class Verdict {
  constructor({ action, reason, source, rule = null, input = null, checked = [], advice = null }) {
    this.action = action;
    this.reason = reason;
    this.source = source;
    this.rule = rule;
    this.input = input;
    this.checked = checked;
    this.advice = advice;
    Object.freeze(this);
  }

  /** Did a capability rule produce this? Callers used to infer it from entry.rule. */
  get isCapability() { return this.source === CAPABILITY; }
  /** A capability refusal blocks THIS action; the agent is free to do something else. */
  get stopsAgent() { return this.action === DENY && this.source !== CAPABILITY; }
  get blocks() { return this.action === DENY; }
  get needsHuman() { return this.action === ASK; }

  /** The receipt body. The chain hashes this, so field order must stay stable. */
  entry({ ts = new Date().toISOString(), agent, tool = '', model = '', tokens = 0, operator = '', client = '' } = {}) {
    return {
      ts, agent, verdict: this.action, reason: this.reason, source: this.source,
      rule: this.rule || undefined,
      rewrote: this.input ? true : undefined,
      tool, model, tokens, operator: operator || undefined, client: client || undefined,
      // Absent when every layer ran. Present — and loud — when one did not, so
      // a reader can tell an allow that was checked from one that was assumed.
      unchecked: this.checked.includes(ECONOMICS) ? undefined : true,
    };
  }

  static allow(reason, opts = {}) { return new Verdict({ ...opts, action: ALLOW, reason }); }
  static deny(reason, opts = {}) { return new Verdict({ ...opts, action: DENY, reason }); }
  static ask(reason, opts = {}) { return new Verdict({ ...opts, action: ASK, reason }); }
  static rewrite(input, reason, opts = {}) { return new Verdict({ ...opts, action: REWRITE, reason, input }); }
}
