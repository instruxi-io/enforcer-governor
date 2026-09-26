// Layer B — what an agent may SPEND. Stateful, and therefore the half that
// fails open (see gate.mjs for why that asymmetry is deliberate).
//
// v2 ran these as one 150-line waterfall inside decide(), interleaved with the
// state mutation that feeds them, so the order of the checks — which IS the
// policy — could only be read by tracing the function top to bottom. Here the
// order is a list you can read in one screen, and each check is a named
// function that can be tested on its own.
//
// Two things this layer deliberately does NOT do. It does not record: judging
// and writing the receipt are separate jobs, and fusing them in v2 meant every
// early return had to remember to call record() with the right arguments. And
// it does not compute cost — a reading is handed to it. That is the seam where
// the harness's own total_cost_usd replaces our arithmetic without any check
// below noticing.

import { Verdict, ECONOMICS, CAPABILITY, OPERATOR } from './verdict.mjs';
import { nameOf } from './tools.mjs';
import {
  PERIODS, burnRate, spawnRate, addSpend, getAgent, setModel, clientFor,
  rollPeriods, modelAdvice, taskShape, BURN_WINDOW,
} from './policy.mjs';

const of = { source: ECONOMICS, checked: [CAPABILITY, ECONOMICS] };
const ground = (a, by) => { a.status = 'grounded'; a.groundedBy = by; };
const pause = (a) => { a.status = 'paused'; };

// ── advancing the world ─────────────────────────────────────────────────────
//
// Everything that changes because this call happened, before anything judges
// it. Kept apart from the checks so that "what we learned" and "what we
// decided" are not the same forty lines.
export function ingest(state, ev, cfg, now) {
  rollPeriods(state, now);
  const a = getAgent(state, ev.agent || 'default', cfg);
  if (cfg.operator) a.operator = cfg.operator;
  if (ev.task) a.task = ev.task;
  if (ev.model) setModel(a, ev.model);
  a.tool = nameOf(ev) || a.tool;   // the harness's name, not the kind: state reads as it always has
  if (ev.cwd) a.cwd = ev.cwd;
  // An explicit client always wins over a derived one, so a header or a config
  // entry can correct a directory that guessed wrong.
  const named = ev.client || clientFor(ev.cwd, cfg.clients);
  if (named) a.client = named;
  if (named && named[0] === '?' && ev.cwd && state.unmapped) state.unmapped[ev.cwd] = named.slice(1);
  if (ev.billing) a.billing = ev.billing;

  // Do NOT trust the reported total blindly. A NaN is the worst case, because
  // every comparison against the budget silently evaluates false and the agent
  // is never stopped at all. Infinity poisons the running totals permanently,
  // and a negative lets a caller rewind its own spend.
  const clean = n => (typeof n === 'number' && Number.isFinite(n) && n >= 0) ? n : null;
  const was = a.tokens;
  const abs = clean(ev.tokens), delta = clean(ev.deltaTokens);
  // Cumulative totals only move forward; a lower figure means a restarted or
  // re-read transcript, not spend that un-happened.
  if (abs !== null) a.tokens = Math.max(a.tokens, abs);
  else if (delta !== null) a.tokens += delta;
  if (typeof ev.cost === 'number') a.cost = ev.cost;
  addSpend(state, a, a.tokens - was, now);

  const sig = ev.action || `${nameOf(ev) || 'tool'}:${JSON.stringify(ev.args ?? '')}`;
  a.recent.push(sig);
  if (a.recent.length > cfg.loopWindow) a.recent.shift();
  a.loopStreak = a.recent.reduce((n, s) => n + (s === sig ? 1 : 0), 0);
  return a;
}

// ── the checks, in the order they run ───────────────────────────────────────
// Order is the policy. Read it as one list.

/** A human stop and a loop stop latch; spend stops do not, so raising a limit frees an agent. */
function latched(state, a, ev, cfg) {
  const LATCH = a.groundedBy === 'human' || a.groundedBy === 'loop';
  if (a.status === 'grounded' && LATCH) {
    return Verdict.deny(a.groundedBy === 'loop'
      ? 'it was stopped for looping. Resume it with /enforcer-governor:resume'
      : 'you stopped this agent. Resume it with /enforcer-governor:resume',
      { ...of, source: OPERATOR });
  }
  if (a.status === 'grounded') { a.status = 'active'; a.groundedBy = undefined; }
  return null;
}

/** Fleet totals first: agents can each sit inside their own limit and together blow the budget. */
function periodCaps(state, a, ev, cfg) {
  if (!cfg.budgetOn || !state.periods) return null;
  const caps = { day: cfg.dailyLimit, week: cfg.weeklyLimit, month: cfg.monthlyLimit };
  const word = { day: 'today', week: 'this week', month: 'this month' };
  for (const [name] of PERIODS) {
    const cap = caps[name], spent = state.periods[name].usd;
    if (cap > 0 && spent >= cap) {
      ground(a, name);
      return Verdict.deny(`your agents have spent $${spent.toFixed(2)} ${word[name]}, which is your $${cap} limit`, of);
    }
  }
  return null;
}

/** Occurrences in a window, not a consecutive streak: a stuck agent usually alternates. */
function loop(state, a, ev, cfg) {
  if (!cfg.loopOn || a.loopStreak < cfg.loopLimit) return null;
  ground(a, 'loop');
  return Verdict.deny(
    `it repeated the same action ${a.loopStreak} times in its last ${a.recent.length} - that is a loop`, of);
}

/** Speed before totals: by the time a daily cap notices, the day's money is gone. */
function burn(state, a, ev, cfg, now) {
  if (!cfg.budgetOn || a.burnFlagged) return null;
  const mine = burnRate(state, now, a.id), all = burnRate(state, now);
  const hit = cfg.burnLimit > 0 && mine >= cfg.burnLimit ? ['this agent is spending', mine, cfg.burnLimit]
            : cfg.fleetBurnLimit > 0 && all >= cfg.fleetBurnLimit ? ['your agents together are spending', all, cfg.fleetBurnLimit]
            : null;
  if (!hit) return null;
  a.burnFlagged = true; pause(a);
  return Verdict.ask(`${hit[0]} $${hit[1].toFixed(2)} a minute, over your $${hit[2]} a minute mark`, of);
}

/** Flagged once per burst, so a genuine twenty-agent job asks one question, not twenty. */
function fanout(state, a, ev, cfg, now) {
  if (!cfg.budgetOn || !(cfg.fanoutLimit > 0) || state.fanoutFlagged) return null;
  const spawned = spawnRate(state, now);
  if (spawned < cfg.fanoutLimit) return null;
  state.fanoutFlagged = true; pause(a);
  return Verdict.ask(
    `${spawned} new agents started in the last minute, and you asked to be told past ${cfg.fanoutLimit}`, of);
}

/** A rate-limited call fails cheaply; the retry does not. */
function retryStorm(state, a, ev, cfg, now) {
  if (!cfg.budgetOn || !(cfg.retryLimit > 0) || !a.fails || a.retryFlagged) return null;
  const recent = a.fails.reduce((n, t) => n + (t > now - BURN_WINDOW ? 1 : 0), 0);
  if (recent < cfg.retryLimit) return null;
  a.retryFlagged = true; pause(a);
  return Verdict.ask(
    `it hit ${recent} errors in a minute and kept going, which is a retry loop, not progress`, of);
}

function clientCap(state, a, ev, cfg) {
  if (!cfg.budgetOn || !a.client || !state.clients) return null;
  const cap = (cfg.clientLimits || {})[a.client];
  const spent = state.clients.month.by[a.client] || 0;
  if (!(cap > 0) || spent < cap) return null;
  ground(a, 'client');
  return Verdict.deny(
    `work for ${a.client} has cost $${spent.toFixed(2)} this month, which is its $${cap} limit`, of);
}

function hardLimit(state, a, ev, cfg) {
  if (!cfg.budgetOn || a.tokens < a.budget) return null;
  ground(a, 'limit');
  return Verdict.deny('it reached your spend limit', of);
}

function softLimit(state, a, ev, cfg) {
  if (!cfg.budgetOn || a.escalated || a.tokens < a.budget * a.soft) return null;
  a.escalated = true;
  if (cfg.softAction === 'escalate') {
    pause(a);
    return Verdict.ask(`it has used ${Math.round(a.soft * 100)}% of your spend limit`, of);
  }
  ground(a, 'soft');
  return Verdict.deny('it passed the warn-me mark, and you set that to stop it', of);
}

const CHECKS = [latched, periodCaps, loop, burn, fanout, retryStorm, clientCap, hardLimit, softLimit];

/**
 * Run Layer B. Advances state, then judges.
 * @returns {Verdict|null} null means no opinion — the gate turns that into an allow.
 */
export function evaluate(state, ev, cfg, now = Date.now()) {
  const a = ingest(state, ev, cfg, now);
  for (const check of CHECKS) {
    const v = check(state, a, ev, cfg, now);
    if (v) return v;
  }
  // Advisory only: never changes the verdict, only says the model and the job
  // look mismatched. A hook cannot switch models, so this is for the human.
  const advice = cfg.adviseModel !== false ? modelAdvice(a.model, taskShape(a.task || ev.task)) : null;
  return advice ? Verdict.allow('inside the limit, doing new work', { ...of, advice }) : null;
}
