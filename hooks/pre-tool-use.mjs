#!/usr/bin/env node
// The decision. Runs before every tool call: reads what the agent is about to
// do, asks the policy, and answers in Claude Code's own permission vocabulary.
import { input, emit, allow, matchText, agentOf, billing } from './lib.mjs';
import { decide, getAgent, setModel, DEFAULTS, priceOf, tokensForDollars } from '../src/policy.mjs';
import { readUsage } from '../src/usage.mjs';
import { withLock, loadState, saveState, loadConfig, writeReceipt } from '../src/store.mjs';

const EVENT = 'PreToolUse';
const ev = input();

let r;
const held = withLock(() => {
  const cfg = { ...DEFAULTS, ...loadConfig() };
  const state = loadState();
  const agent = agentOf(ev);
  const { tokens, model, task } = readUsage(ev.session_id, ev.transcript_path);

  // Price the agent at its OWN model before judging it, not after: "$20 per
  // agent" has to mean $20 whether it is on Opus or Haiku, and a flat token
  // cap would quietly give one of them a quarter of the other's money.
  const a = getAgent(state, agent, cfg);
  if (model) setModel(a, model);
  if (task) a.task = task;
  if (!a.budgetRaised) a.budget = tokensForDollars(cfg.dollars, priceOf(a.model, cfg.model).in);

  const out = decide(state, {
    agent, tokens, task,
    action: matchText(ev.tool_name, ev.tool_input),
    tool: ev.tool_name,
    model: model || 'claude-code',
    cwd: ev.cwd,
    billing: billing(),
  }, cfg);

  writeReceipt(out.entry, out.hash);
  saveState(state);
  return { out, model: a.model };
});

// No lock, unreadable state, anything at all: allow. Enforcement that breaks
// the user's real work has failed at something more important than enforcing.
if (!held.ok || !held.value) {
  allow(EVENT, 'Enforcer could not read its own state, so this was not checked. Nothing is blocked.');
}
const { out: res, model: priced } = held.value;
r = res;

// The one message a person reads, mid-work, at the moment they are stopped.
// It has to be in money and it has to say what to do next; a raw token count
// answers neither.
const perM = priceOf(priced || '').in;
const usd = t => '$' + ((t / 1e6) * perM).toFixed(2);
const spent = usd(r.agent.tokens);
const of = r.agent.budget ? `${spent} of its ${usd(r.agent.budget)} limit` : `${spent} so far`;

// A refusal and a stop are different events and must not read the same. A
// capability refusal blocks THIS action and the agent carries on; offering to
// raise the limit there sends someone to a control that will not help.
const capability = !!(r.entry && r.entry.rule);

if (r.verdict === 'deny') {
  emit(EVENT, { permissionDecision: 'deny', permissionDecisionReason: capability
    ? `Enforcer refused this action: it is ${r.reason}. The agent is not stopped and can carry on with something else.`
    : `Enforcer stopped this agent: ${r.reason}. It has spent ${of}. Raise the limit with /governor limit.` });
}

if (r.verdict === 'escalate') {
  emit(EVENT, { permissionDecision: 'ask', permissionDecisionReason: capability
    ? `Enforcer wants you to confirm: this action would ${r.reason.replace(/^wants to /, '')}. Allow it this once?`
    : `Enforcer is checking with you: ${r.reason}. It has spent ${of}. Allow it to keep going?` });
}

// A hook cannot change the model, so the honest move is to tell the human, who
// can switch with /model. systemMessage surfaces it without interrupting.
if (r.advice) {
  emit(EVENT, { permissionDecision: 'allow', permissionDecisionReason: `Enforcer: ${of}`,
    systemMessage: `Enforcer: ${r.advice.why}. Consider /model ${r.advice.suggest}.` });
}

allow(EVENT, `Enforcer: ${of}`);
