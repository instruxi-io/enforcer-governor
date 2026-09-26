// What the AGENT should be told, as opposed to what the human should be told.
//
// v1 and v2 could only interrupt. When an agent crossed the warn mark the
// human got a question and the agent got nothing, so the only lever was to
// stop work that was already half done. The harness has a second channel —
// additionalContext puts text into the model's own context — and it changes
// what the product can be: an agent that knows it is near the limit can land
// what it has instead of opening a new front. Self-correction beats
// interdiction, and it happens before the money is spent rather than after.
//
// Two rules keep this from becoming a tax:
//
// 1. TERSE. Every word here is billed on every subsequent turn of the session,
//    forever, because it joins the cached prefix. A governor that inflates
//    context to save money has argued itself out of a job. One sentence.
//
// 2. ONCE PER TRANSITION. Repeating a warning every turn is how a warning
//    stops being read, and it costs more each time it is repeated. The brief
//    fires when the situation CHANGES and then goes quiet, so `said` is state,
//    not a log.

const PCT = (a) => (a.budget > 0 ? a.tokens / a.budget : 0);

/** The situation, as one of a few named states. Null means nothing worth saying. */
function situationOf(a, cfg) {
  if (!a) return null;
  if (a.status === 'grounded') return 'stopped';
  if (cfg.loopOn !== false && a.loopStreak >= Math.max(2, cfg.loopLimit - 1) && a.loopStreak < cfg.loopLimit) {
    return 'repeating';
  }
  if (cfg.budgetOn === false) return null;
  const pct = PCT(a);
  if (pct >= cfg.soft) return 'near-limit';
  // Warn early enough to be actionable. At the soft mark the turn is usually
  // already committed; two thirds is where changing approach still helps.
  if (pct >= cfg.soft * 0.85) return 'approaching';
  return null;
}

const LINES = {
  approaching: (a, pct) =>
    `Enforcer: this session is at ${pct}% of its spend limit. Prefer finishing work in progress over starting anything new.`,
  'near-limit': (a, pct) =>
    `Enforcer: this session is at ${pct}% of its spend limit and will be stopped at 100%. Wrap up and summarise what is done rather than beginning new work.`,
  repeating: (a) =>
    `Enforcer: you have run the same action ${a.loopStreak} times. Change approach — repeating it again will be blocked as a loop.`,
  stopped: () =>
    `Enforcer: this agent is stopped and further tool calls will be refused. Say what you completed and what remains.`,
};

/**
 * @returns {{text:string, situation:string}|null} null means say nothing —
 *   which is most of the time, and is the point.
 */
export function brief(a, cfg = {}) {
  const situation = situationOf(a, cfg);
  if (!situation) return null;
  if (a.said === situation) return null;          // already told it; do not nag
  const pct = Math.round(PCT(a) * 100);
  return { text: LINES[situation](a, pct), situation };
}

/** Record that the agent has been told, so the next turn stays quiet. */
export function markTold(a, situation) { a.said = situation; }
