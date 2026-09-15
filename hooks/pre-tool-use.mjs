// The decision. Runs before every tool call: reads what the agent is about to
// do, asks the gate, and answers in Claude Code's own permission vocabulary.
//
// This file used to hold the policy as well as the plumbing — the capability
// branch, the spend branch and the blind-fallback branch were all inline, and
// the blind branch was a second, subtly different copy of the first. It is now
// only plumbing: build the event, call the gate, record the answer, translate
// it for the harness. The two-layer semantics live in gate.mjs, and the one
// thing this file still owns is the wording, because these sentences are read
// by a person mid-work at the moment they are interrupted.
import { input, emit, matchText, agentOf, billing } from './lib.mjs';
import { gate } from '../src/gate.mjs';
import { matchRule, DEFAULT_RULES } from '../src/capability.mjs';
import { consult } from '../src/central.mjs';
import { evaluate as economics } from '../src/economics.mjs';
import { DEFAULTS, priceOf, tokensForDollars, getAgent, setModel } from '../src/policy.mjs';
import { read as meter } from '../src/meter.mjs';
import { withLock, loadState, saveState, loadConfig, writeReceipt } from '../src/store.mjs';
import { sha256 } from '../src/policy.mjs';

const EVENT = 'PreToolUse';
const ev = input();
const cfg = { ...DEFAULTS, ...loadConfig() };
const agent = agentOf(ev);
const event = {
  agent,
  action: matchText(ev.tool_name, ev.tool_input),
  input: ev.tool_input,
  tool: ev.tool_name,
  cwd: ev.cwd,
  billing: billing(),
};

// Ask the tenant's policy BEFORE taking the lock, and only when a local rule
// matched. The network must never sit inside the lock — forty parallel tool
// calls would queue behind one slow round trip — and an unmatched call has
// nothing to ask about, so it pays nothing.
const rules = cfg.rulesOn === false ? [] : (cfg.rules || DEFAULT_RULES);
const matched = matchRule(rules, event);
const central = matched ? await consult(matched, cfg) : null;

let priced = cfg.model, spent = 0, budget = 0;

// One lock covers deciding AND recording. They cannot be separated: the chain
// hashes each entry against the previous head, so a second lock acquisition
// between the two lets a parallel hook interleave and the record stops
// verifying — which is exactly what happens with 40 concurrent tool calls.
const held = withLock(() => {
  const state = loadState();
  const reading = meter(ev.session_id, ev.transcript_path, cfg);
  // Price the agent at its OWN model before judging it: "$20 per agent" has to
  // mean $20 whether it is on Opus or Haiku, and a flat token cap would quietly
  // give one of them a quarter of the other's money.
  const a = getAgent(state, agent, cfg);
  if (reading.model) setModel(a, reading.model);
  if (!a.budgetRaised) a.budget = tokensForDollars(cfg.dollars, priceOf(a.model, cfg.model).in);

  const v = gate(event, cfg, {
    withState: (fn) => ({ ok: true, value: fn(state, reading) }),
    economics,
    central,
  });

  priced = a.model; spent = a.tokens; budget = a.budget;
  // The receipt says where the money figure came from. "How did you know what
  // this cost" deserves an answer, not an assumption.
  const entry = v.entry({ agent, tool: ev.tool_name || '', model: a.model || '',
    tokens: Math.round(a.tokens), operator: a.operator || '', client: a.client || '',
    meter: reading.source });
  const hash = sha256(state.prevHash + JSON.stringify(entry));
  state.prevHash = hash;
  writeReceipt(entry, hash);
  saveState(state);
  return v;
});

// The blind path. Capability needs no state, so it still gets to refuse — that
// asymmetry is the whole point of gate.mjs. The receipt is written without a
// hash: there is no readable chain tail to hash against, and verify() counts an
// unhashed line as unverifiable rather than as a break. Recording nothing would
// hide a real refusal; forging a link would cry tampering on an honest file.
const verdict = held.ok && held.value ? held.value : gate(event, cfg, { central });
if (!held.ok || !held.value) writeReceipt(verdict.entry({ agent, tool: ev.tool_name || '', chained: false }), undefined);

// ── wording ─────────────────────────────────────────────────────────────────
// A refusal and a stop are different events and must not read the same. A
// capability refusal blocks THIS action and the agent carries on; offering to
// raise the limit there sends someone to a control that will not help.
const perM = priceOf(priced || '').in;
const usd = t => '$' + ((t / 1e6) * perM).toFixed(2);
const of = budget ? `${usd(spent)} of its ${usd(budget)} limit` : `${usd(spent)} so far`;

// A tenant decision quotes the tenant. Its reason is a sentence someone in the
// organisation wrote for exactly this moment, so it is shown as written rather
// than squeezed into "it is <reason>".
if (verdict.action === 'deny' && verdict.source === 'policy') {
  emit(EVENT, { permissionDecision: 'deny',
    permissionDecisionReason: `Your organisation's Enforcer policy refused this action: ${verdict.reason}. The agent is not stopped and can carry on with something else.` });
}
if (verdict.action === 'ask' && verdict.source === 'policy') {
  emit(EVENT, { permissionDecision: 'ask',
    permissionDecisionReason: `Your organisation's Enforcer policy wants you to confirm this action: ${verdict.reason}. Allow it this once?` });
}

// On a subscription the dollar figures are what the same tokens would cost at
// API list prices — nobody is billed them. Saying "spent" there sent a user
// looking for a $364 charge that does not exist.
const onPlan = event.billing === 'plan';
const money = onPlan ? ' (API-equivalent usage: your subscription is not billed these amounts)' : '';
const turnOff = onPlan ? ' or turn spend limits off with /enforcer-governor:set budgetOn false' : '';

if (verdict.action === 'deny') {
  emit(EVENT, { permissionDecision: 'deny', permissionDecisionReason: verdict.stopsAgent
    ? `Enforcer stopped this agent: ${verdict.reason}. It has spent ${of}${money}. Raise the limit with /enforcer-governor:limit${turnOff}.`
    : `Enforcer refused this action: it is ${verdict.reason}. The agent is not stopped and can carry on with something else.` });
}

if (verdict.action === 'ask') {
  emit(EVENT, { permissionDecision: 'ask', permissionDecisionReason: verdict.isCapability
    ? `Enforcer wants you to confirm: this action ${verdict.reason}. Allow it this once?`
    : `Enforcer is checking with you: ${verdict.reason}. It has spent ${of}. Allow it to keep going?` });
}

// A rewrite runs the action in a form the policy accepts. It has to SAY so:
// silently editing what the agent asked for would make the governor an
// invisible actor in the transcript, and the receipt records it too.
if (verdict.action === 'rewrite') {
  // defer, carrying the rewrite. The governor's opinion is "run THIS form
  // instead", not "run it unchecked" — the user's own rules should still see
  // the rewritten command. Granting here would let a rewrite walk past a deny
  // rule that the original would have hit, which is the opposite of safer.
  emit(EVENT, {
    permissionDecision: 'defer',
    permissionDecisionReason: `Enforcer: ${of}`,
    updatedInput: verdict.input,
    systemMessage: `Enforcer rewrote this command — ${verdict.reason}.`,
  });
}

if (verdict.advice) {
  // Advice is not a verdict. It never changes the decision, so it must not
  // become one by arriving as an affirmative allow.
  emit(EVENT, { permissionDecision: 'defer', permissionDecisionReason: `Enforcer: ${of}`,
    systemMessage: `Enforcer: ${verdict.advice.why}. Consider /model ${verdict.advice.suggest}.` });
}

// DEFER, not allow. The distinction is the difference between composing with
// the user's own permission rules and quietly overriding them.
//
// `allow` from a PreToolUse hook is an affirmative grant that short-circuits
// what follows — that is why `defer` exists as a separate decision at all,
// and why settings rules take only allow/deny/ask while hooks take four. So a
// governor answering `allow` to every ordinary call was suppressing the deny
// rules and prompts the user configured in /permissions, on every call it
// permitted. For a tool whose own README calls that block "belt to the hooks'
// braces", cutting the braces was exactly the wrong failure.
//
// `defer` says what is actually true here: the governor has no objection, and
// nothing about that should stop Claude Code asking its own questions. The
// spend figure still rides along, so the reason line is unchanged.
emit(EVENT, { permissionDecision: 'defer',
  permissionDecisionReason: verdict.checked.includes('economics') ? `Enforcer: ${of}` : verdict.reason });
