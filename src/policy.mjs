// Enforcer Governor  -  pure policy engine.
// No I/O, no deps. decide() is a pure function of (state, event, config).
// This is the whole brain: everything else is plumbing around it.
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const DEFAULTS = {
  budget: 200000,     // hard token cap per agent per session
  soft: 0.75,         // escalate / warn at this fraction of budget
  loopLimit: 4,       // identical action repeats that trip a loop block
  loopWindow: 8,      // how many recent actions to remember
  budgetOn: true,
  loopOn: true,
  softAction: 'escalate', // 'escalate' -> ask a human; 'deny' -> auto-block
};

export function makeState() {
  return { agents: {}, chain: [], prevHash: 'genesis' };
}

export function getAgent(state, id, cfg) {
  if (!state.agents[id]) {
    state.agents[id] = {
      id, tokens: 0, recent: [], escalated: false, status: 'active',
      budget: cfg.budget, soft: cfg.soft, cost: 0,
    };
  }
  return state.agents[id];
}

// The one call. Returns { verdict, reason, receipt, hash, agent }.
// verdict is one of: allow | deny | escalate.
export function decide(state, ev, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const a = getAgent(state, ev.agent || 'default', cfg);

  // A grounded agent stays grounded until explicitly released.
  if (a.status === 'grounded') return record(state, a, 'deny', 'agent grounded', a.tokens);

  // The hook/proxy reports the session's cumulative token total; trust it if given.
  if (typeof ev.tokens === 'number') a.tokens = ev.tokens;
  else if (typeof ev.deltaTokens === 'number') a.tokens += ev.deltaTokens;
  if (typeof ev.cost === 'number') a.cost = ev.cost;

  // Loop / waste: identical action signature repeated back to back.
  const sig = ev.action || `${ev.tool || 'tool'}:${JSON.stringify(ev.args ?? '')}`;
  a.recent.push(sig);
  if (a.recent.length > cfg.loopWindow) a.recent.shift();
  let streak = 1;
  for (let i = a.recent.length - 2; i >= 0; i--) {
    if (a.recent[i] === sig) streak++; else break;
  }
  a.loopStreak = streak;

  if (cfg.loopOn && streak >= cfg.loopLimit) {
    a.status = 'grounded';
    return record(state, a, 'deny', `waste: identical action x${streak}`, a.tokens);
  }
  if (cfg.budgetOn && a.tokens >= a.budget) {
    a.status = 'grounded';
    return record(state, a, 'deny', 'hard budget reached', a.tokens);
  }
  if (cfg.budgetOn && !a.escalated && a.tokens >= a.budget * a.soft) {
    a.escalated = true;
    if (cfg.softAction === 'escalate') {
      a.status = 'paused';
      return record(state, a, 'escalate', `soft cap ${Math.round(a.soft * 100)}% reached`, a.tokens);
    }
    a.status = 'grounded';
    return record(state, a, 'deny', 'soft cap reached (auto-deny)', a.tokens);
  }
  return record(state, a, 'allow', 'within budget, on task', a.tokens);
}

// Human resolves an escalation.
export function resolve(state, agentId, approve, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const a = state.agents[agentId];
  if (!a) return null;
  if (approve) {
    a.budget = Math.round(a.budget * 1.5); // grant +50% and let it finish
    a.status = 'active';
    a.escalated = false;
    return record(state, a, 'allow', 'budget raised +50%', a.tokens, 'human');
  }
  a.status = 'grounded';
  return record(state, a, 'deny', 'escalation denied', a.tokens, 'human');
}

export function kill(state, agentId) {
  const a = state.agents[agentId];
  if (!a) return null;
  a.status = 'grounded';
  return record(state, a, 'deny', 'manual kill switch', a.tokens, 'human');
}

// Append a hash-chained receipt. Each hash folds in the previous one, so any
// later edit or deletion breaks the chain and verifyChain() catches it.
export function record(state, a, verdict, reason, tokens, authority) {
  const entry = { ts: Date.now(), agent: a.id, verdict, reason, tokens: Math.round(tokens) };
  if (authority) entry.authority = authority;
  const json = JSON.stringify(entry);
  const hash = sha256(state.prevHash + json);
  state.chain.push({ json, hash });
  state.prevHash = hash;
  return {
    verdict, reason, receipt: 'rcpt_' + hash.slice(0, 12), hash,
    agent: { id: a.id, tokens: Math.round(a.tokens), budget: a.budget, status: a.status, loopStreak: a.loopStreak || 0 },
    entry,
  };
}

export function verifyChain(state) {
  let h = 'genesis';
  for (const link of state.chain) {
    h = sha256(h + link.json);
    if (h !== link.hash) return false;
  }
  return true;
}
