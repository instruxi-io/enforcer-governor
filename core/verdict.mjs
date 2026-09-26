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
// The tenant's own policy, decided by Enforcer. Like a capability refusal it
// refuses an ACTION, never the agent — it is a capability decision made
// centrally instead of by a local pattern.
export const POLICY = 'policy';
export const ECONOMICS = 'economics';
export const OPERATOR = 'operator';

export class Verdict {
  constructor({ action, reason, source, rule = null, input = null, checked = [], advice = null, policy = null }) {
    this.action = action;
    this.reason = reason;
    this.source = source;
    this.rule = rule;
    this.input = input;
    this.checked = checked;
    this.advice = advice;
    // What the tenant's policy said, when it was asked: allow | deny | ask |
    // silent | unreachable. Null when no rule matched, so nobody was asked.
    this.policy = policy;
    Object.freeze(this);
  }

  /** Did a capability rule produce this? Callers used to infer it from entry.rule. */
  get isCapability() { return this.source === CAPABILITY || this.source === POLICY; }
  /** A capability refusal blocks THIS action; the agent is free to do something else. */
  get stopsAgent() { return this.action === DENY && !this.isCapability; }
  get blocks() { return this.action === DENY; }
  get needsHuman() { return this.action === ASK; }

  /**
   * The receipt body. The chain hashes this, so field order must stay stable.
   * `chained` is the caller's to state: only the writer knows whether it managed
   * to hash this line onto a readable head. It is a different fact from
   * `unchecked` - a capability refusal decided while the state was healthy is
   * chained but never reaches economics, and conflating the two would label a
   * perfectly good receipt as degraded.
   */
  entry({ ts = new Date().toISOString(), agent, tool = '', model = '', tokens = 0,
          operator = '', client = '', chained = true, meter = undefined,
          harness = '', adapterVersion = '' } = {}) {
    return {
      ts, agent, verdict: this.action, reason: this.reason, source: this.source,
      rule: this.rule || undefined,
      rewrote: this.input ? true : undefined,
      tool, model, tokens, operator: operator || undefined, client: client || undefined,
      meter: meter || undefined,
      // Present only on the degraded path: an answer given without reading the
      // books at all, so a reader can tell an allow that was checked from one
      // that was assumed. A capability refusal is not degraded and never
      // carries it, even though economics did not run.
      unchecked: (this.source === ECONOMICS && !this.checked.includes(ECONOMICS)) || undefined,
      chained: chained ? undefined : false,
      // Appended last so every earlier field keeps its position in the hash.
      policy: this.policy || undefined,
      // Which harness asked, and which version of its adapter: 'claude-code',
      // 'mcp-proxy'. Appended after policy for the same reason policy was
      // appended after chained -- a receipt written before these existed
      // hashes exactly as it did, and one written after simply has two more
      // keys at the end. Absent when the caller did not say.
      harness: harness || undefined,
      adapter_version: adapterVersion || undefined,
    };
  }

  static allow(reason, opts = {}) { return new Verdict({ ...opts, action: ALLOW, reason }); }
  static deny(reason, opts = {}) { return new Verdict({ ...opts, action: DENY, reason }); }
  static ask(reason, opts = {}) { return new Verdict({ ...opts, action: ASK, reason }); }
  static rewrite(input, reason, opts = {}) { return new Verdict({ ...opts, action: REWRITE, reason, input }); }
}
