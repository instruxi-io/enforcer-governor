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
import { evaluate as economics } from '../src/economics.mjs';
import { DEFAULTS, priceOf, tokensForDollars, getAgent, setModel } from '../src/policy.mjs';
import { readUsage } from '../src/usage.mjs';
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

let priced = cfg.model, spent = 0, budget = 0;

// One lock covers deciding AND recording. They cannot be separated: the chain
// hashes each entry against the previous head, so a second lock acquisition
// between the two lets a parallel hook interleave and the record stops
// verifying — which is exactly what happens with 40 concurrent tool calls.
const held = withLock(() => {
  const state = loadState();
  const reading = readUsage(ev.session_id, ev.transcript_path);
  // Price the agent at its OWN model before judging it: "$20 per agent" has to
  // mean $20 whether it is on Opus or Haiku, and a flat token cap would quietly
  // give one of them a quarter of the other's money.
  const a = getAgent(state, agent, cfg);
  if (reading.model) setModel(a, reading.model);
  if (!a.budgetRaised) a.budget = tokensForDollars(cfg.dollars, priceOf(a.model, cfg.model).in);

  const v = gate(event, cfg, {
    withState: (fn) => ({ ok: true, value: fn(state, reading) }),
    economics,
  });

  priced = a.model; spent = a.tokens; budget = a.budget;
  const entry = v.entry({ agent, tool: ev.tool_name || '', model: a.model || '',
    tokens: Math.round(a.tokens), operator: a.operator || '', client: a.client || '' });
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
const verdict = held.ok && held.value ? held.value : gate(event, cfg, {});
if (!held.ok || !held.value) writeReceipt(verdict.entry({ agent, tool: ev.tool_name || '', chained: false }), undefined);

// ── wording ─────────────────────────────────────────────────────────────────
// A refusal and a stop are different events and must not read the same. A
// capability refusal blocks THIS action and the agent carries on; offering to
// raise the limit there sends someone to a control that will not help.
const perM = priceOf(priced || '').in;
const usd = t => '$' + ((t / 1e6) * perM).toFixed(2);
const of = budget ? `${usd(spent)} of its ${usd(budget)} limit` : `${usd(spent)} so far`;

if (verdict.action === 'deny') {
  emit(EVENT, { permissionDecision: 'deny', permissionDecisionReason: verdict.stopsAgent
    ? `Enforcer stopped this agent: ${verdict.reason}. It has spent ${of}. Raise the limit with /enforcer-governor:limit.`
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
  emit(EVENT, {
    permissionDecision: 'allow',
    permissionDecisionReason: `Enforcer: ${of}`,
    updatedInput: verdict.input,
    systemMessage: `Enforcer rewrote this command — ${verdict.reason}.`,
  });
}

if (verdict.advice) {
  emit(EVENT, { permissionDecision: 'allow', permissionDecisionReason: `Enforcer: ${of}`,
    systemMessage: `Enforcer: ${verdict.advice.why}. Consider /model ${verdict.advice.suggest}.` });
}

emit(EVENT, { permissionDecision: 'allow',
  permissionDecisionReason: verdict.checked.includes('economics') ? `Enforcer: ${of}` : verdict.reason });
