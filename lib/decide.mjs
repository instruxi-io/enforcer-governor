// The governor's decision, harness-neutral. Takes the common event
//   {hook_event_name, tool_name, tool_input, tool_response?, session_id, cwd,
//    transcript_path?, model?}
// decides, writes the tamper-evident log (through the core), and returns a
// plain answer. A harness shim translates the answer into its own vocabulary;
// nothing below the shim knows what that vocabulary is.
//
// Answer: { decision: 'allow'|'deny'|'ask'|null, reason, updatedInput?, notice?, record, line }
//   decision null = no objection (the harness's own flow decides); `notice` is
//   a message for the person, `reason` already begins with the machine line.
import { toolEvent } from '../adapters/claude-code/events.mjs';
import { priceOf } from '../src/policy.mjs';
import { governor } from '../adapters/claude-code/index.mjs';
import { decisionRecord, decisionLine } from '../core/codes.mjs';

export async function decide(ev) {
  const event = toolEvent(ev);
  const { verdict, spend } = await governor().before(event);
  const spent = spend.tokens, budget = spend.budget;
  const record = decisionRecord(verdict, { tool: event.name, run_id: event.runId });
  const line = decisionLine(record);
  const answer = (decision, reason, extra = {}) => ({ decision, reason: line + '\n' + reason, record, line, ...extra });

  const perM = priceOf(spend.model || '').in;
  const usd = t => '$' + ((t / 1e6) * perM).toFixed(2);
  const of = budget ? `${usd(spent)} of its ${usd(budget)} limit` : `${usd(spent)} so far`;

  // A tenant decision quotes the tenant, as written.
  if (verdict.action === 'deny' && verdict.source === 'policy')
    return answer('deny', `Your organisation's Enforcer policy refused this action: ${verdict.reason}. The agent is not stopped and can carry on with something else.`);
  if (verdict.action === 'ask' && verdict.source === 'policy')
    return answer('ask', `Your organisation's Enforcer policy wants you to confirm this action: ${verdict.reason}. Allow it this once?`);

  // On a subscription the dollar figures are API-equivalent, not billed.
  const onPlan = event.billing === 'plan';
  const money = onPlan ? ' (API-equivalent usage: your subscription is not billed these amounts)' : '';
  const turnOff = onPlan ? ' or turn spend limits off with /enforcer-governor:set budgetOn false' : '';

  if (verdict.action === 'deny')
    return answer('deny', verdict.stopsAgent
      ? `Enforcer stopped this agent: ${verdict.reason}. It has spent ${of}${money}. Raise the limit with /enforcer-governor:limit${turnOff}.`
      : `Enforcer refused this action: it is ${verdict.reason}. The agent is not stopped and can carry on with something else.`);

  if (verdict.action === 'ask')
    return answer('ask', verdict.isCapability
      ? `Enforcer wants you to confirm: this action ${verdict.reason}. Allow it this once?`
      : `Enforcer is checking with you: ${verdict.reason}. It has spent ${of}. Allow it to keep going?`);

  // An affirmative grant: only the graph-worker rules allow.
  if (verdict.action === 'allow' && verdict.source === 'capability')
    return answer('allow', `Enforcer allowed this: ${verdict.reason}.`);

  // A rewrite is put to the person as an ask carrying the rewritten input.
  if (verdict.action === 'rewrite')
    return answer('ask', `Enforcer rewrote this command — ${verdict.reason}. Run the rewritten form?`,
      { updatedInput: verdict.input, notice: `Enforcer rewrote this command — ${verdict.reason}.` });

  // Advice never changes the decision.
  if (verdict.advice)
    return { decision: null, notice: `Enforcer: ${verdict.advice.why} (${of}). Consider /model ${verdict.advice.suggest}.`, record, line };

  // The one silent pass that speaks is the blind one.
  if (!verdict.checked.includes('economics')) return { decision: null, notice: `Enforcer: ${verdict.reason}`, record, line };
  return { decision: null, record, line };
}
