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
import { input, emit, pass } from './lib.mjs';
import { toolEvent } from '../adapters/claude-code/events.mjs';
import { priceOf } from '../src/policy.mjs';
import { governor } from '../adapters/claude-code/index.mjs';

const EVENT = 'PreToolUse';
const ev = input();
// Claude's tool call in the core's vocabulary: `shell` for Bash, the canonical
// fields, and Claude's own name and tool_input kept beside them for the receipt
// and for a rewrite (adapters/claude-code/events.mjs).
const event = toolEvent(ev);

// Deciding and recording live in the core (core/governor.mjs): the tenant
// policy check, the lock, the gate, the hash-chained receipt and the blind
// fallback. This hook owns what is Claude Code's: reading the hook JSON above,
// and the wording below.
const { verdict, spend } = await governor().before(event);
const priced = spend.model, spent = spend.tokens, budget = spend.budget;

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
//
// `ask`, carrying the rewrite, so the person confirms the form that will
// actually run. updatedInput only takes effect alongside allow or ask (defer
// drops it -- which is how rewrites used to silently not happen). `allow` would
// skip the prompt the user's own rules might have raised; with `ask`, their
// deny and ask rules still see the rewritten input.
if (verdict.action === 'rewrite') {
  emit(EVENT, {
    permissionDecision: 'ask',
    permissionDecisionReason: `Enforcer rewrote this command — ${verdict.reason}. Run the rewritten form?`,
    updatedInput: verdict.input,
  }, { systemMessage: `Enforcer rewrote this command — ${verdict.reason}.` });
}

// Advice is not a verdict. It never changes the decision, so it rides along
// with no decision at all.
if (verdict.advice) {
  pass(EVENT, { systemMessage: `Enforcer: ${verdict.advice.why} (${of}). Consider /model ${verdict.advice.suggest}.` });
}

// No objection: no decision. See pass() in lib.mjs for why this is neither
// `allow` nor `defer`. The one pass that speaks is the blind one -- an unchecked
// allow must say it was unchecked, because silence reads as "checked and fine".
if (!verdict.checked.includes('economics')) pass(EVENT, { systemMessage: `Enforcer: ${verdict.reason}` });
pass(EVENT);
