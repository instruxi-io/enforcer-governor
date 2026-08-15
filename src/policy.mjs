// Enforcer Governor  -  pure policy engine.
// No I/O, no deps. decide() is a pure function of (state, event, config).
// This is the whole brain: everything else is plumbing around it.
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Published list prices, USD per million tokens. `in` = input, `out` = output,
// `cin` = cached input. Sources: Anthropic and OpenAI pricing pages.
//
// We measure spend in EFFECTIVE TOKENS: input-token-equivalents at that model's
// own price. One effective token always costs `in` / 1e6 dollars, so dollars
// <-> tokens is a single multiply no matter which model or provider is running.
//
// The output multiplier is NOT a constant across providers. Anthropic prices
// output at 5x input on every current model, which is why a flat 5x worked
// while this only spoke to Claude. OpenAI is 6x on the 5.6 family, 8x on gpt-5,
// and 4x on gpt-4o -- so a flat 5x mis-bills every OpenAI model. Weights are
// therefore derived per model from the prices below.
export const MODELS = {
  // ── Anthropic ──  cache read 0.1x input, 5-minute cache write 1.25x
  'claude-opus-5':     { p: 'anthropic', label: 'Opus 5',      in: 5,    out: 25 },
  'claude-opus-4-8':   { p: 'anthropic', label: 'Opus 4.8',    in: 5,    out: 25 },
  'claude-sonnet-5':   { p: 'anthropic', label: 'Sonnet 5',    in: 3,    out: 15 },
  'claude-sonnet-4-6': { p: 'anthropic', label: 'Sonnet 4.6',  in: 3,    out: 15 },
  'claude-haiku-4-5':  { p: 'anthropic', label: 'Haiku 4.5',   in: 1,    out: 5  },
  // ── OpenAI ──  cached input priced explicitly, no separate cache-write charge
  'gpt-5.6-sol':       { p: 'openai', label: 'GPT-5.6 Sol',    in: 5,    out: 30,  cin: 0.50  },
  'gpt-5.6-terra':     { p: 'openai', label: 'GPT-5.6 Terra',  in: 2,    out: 12,  cin: 0.20  },
  'gpt-5.6-luna':      { p: 'openai', label: 'GPT-5.6 Luna',   in: 0.20, out: 1.20, cin: 0.02 },
  'gpt-5.5-pro':       { p: 'openai', label: 'GPT-5.5 Pro',    in: 30,   out: 180 },
  'gpt-5.5':           { p: 'openai', label: 'GPT-5.5',        in: 5,    out: 30,  cin: 0.50  },
  'gpt-5.4-mini':      { p: 'openai', label: 'GPT-5.4 mini',   in: 0.75, out: 4.50, cin: 0.075 },
  'gpt-5.4-nano':      { p: 'openai', label: 'GPT-5.4 nano',   in: 0.20, out: 1.25, cin: 0.02 },
  'gpt-5.4-pro':       { p: 'openai', label: 'GPT-5.4 Pro',    in: 30,   out: 180 },
  'gpt-5.4':           { p: 'openai', label: 'GPT-5.4',        in: 2.50, out: 15,  cin: 0.25  },
  'gpt-5.1':           { p: 'openai', label: 'GPT-5.1',        in: 1.25, out: 10,  cin: 0.125 },
  'gpt-5-mini':        { p: 'openai', label: 'GPT-5 mini',     in: 0.25, out: 2,   cin: 0.025 },
  'gpt-5-nano':        { p: 'openai', label: 'GPT-5 nano',     in: 0.05, out: 0.40, cin: 0.005 },
  'gpt-5-pro':         { p: 'openai', label: 'GPT-5 Pro',      in: 15,   out: 120 },
  'gpt-5':             { p: 'openai', label: 'GPT-5',          in: 1.25, out: 10,  cin: 0.125 },
  'gpt-4.1-mini':      { p: 'openai', label: 'GPT-4.1 mini',   in: 0.40, out: 1.60, cin: 0.10 },
  'gpt-4.1-nano':      { p: 'openai', label: 'GPT-4.1 nano',   in: 0.10, out: 0.40, cin: 0.025 },
  'gpt-4.1':           { p: 'openai', label: 'GPT-4.1',        in: 2,    out: 8,   cin: 0.50  },
  'gpt-4o-mini':       { p: 'openai', label: 'GPT-4o mini',    in: 0.15, out: 0.60, cin: 0.075 },
  'gpt-4o':            { p: 'openai', label: 'GPT-4o',         in: 2.50, out: 10,  cin: 1.25  },
  'o4-mini':           { p: 'openai', label: 'o4-mini',        in: 1.10, out: 4.40, cin: 0.275 },
  'o3-mini':           { p: 'openai', label: 'o3-mini',        in: 1.10, out: 4.40, cin: 0.55 },
  'o3':                { p: 'openai', label: 'o3',             in: 2,    out: 8,   cin: 0.50  },
};

// Longest key first, so 'gpt-5.6-sol' matches before the 'gpt-5' substring.
const KEYS = Object.keys(MODELS).sort((a, b) => b.length - a.length);

export const DEFAULT_MODEL = 'claude-opus-5';

// Look up a model from whatever string the agent reported. Unknown models fall
// back to the priciest in their family, so an unrecognised model is over- rather
// than under-charged and can never quietly run past its limit.
export function priceOf(model = '', fallback = DEFAULT_MODEL) {
  const m = String(model).toLowerCase();
  const key = KEYS.find(k => m.includes(k));
  if (key) return { key, ...MODELS[key] };
  if (/^(gpt|o[134]\b|chatgpt)/.test(m)) return { key: 'gpt-5.5', ...MODELS['gpt-5.5'] };
  if (m.includes('claude')) return { key: DEFAULT_MODEL, ...MODELS[DEFAULT_MODEL] };
  return { key: fallback, ...(MODELS[fallback] || MODELS[DEFAULT_MODEL]) };
}

// Cost weights relative to input=1, for turning raw usage into effective tokens.
export function weightsFor(model) {
  const m = priceOf(model);
  return {
    out: m.out / m.in,
    cacheRead: (m.cin ?? m.in * 0.1) / m.in,
    // Anthropic bills a 5-minute cache write at 1.25x input. OpenAI has no
    // separate cache-write charge, so those tokens are just ordinary input.
    cacheWrite: m.p === 'anthropic' ? 1.25 : 1,
  };
}

export const tokensForDollars = (usd, perM) => Math.round((usd / perM) * 1e6);
export const dollarsForTokens = (tok, perM) => (tok / 1e6) * perM;

export const DEFAULTS = {
  // Budgets are COST-WEIGHTED effective tokens (input=1, output 5x,
  // cache-create 1.25x, cache-read 0.1x), so long cached sessions are
  // measured by what they cost, not by raw context re-reads.
  dollars: 20,                // what the human actually sets: spend cap per agent, USD
  model: 'claude-opus-5',     // which model's prices convert dollars -> tokens
  budget: 4000000,            // == $20 at Opus 5 rates. Derived from dollars+model.
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

  // Master switch wins over everything, including a grounded agent. Turning the
  // governor off in the dashboard has to actually let work through, otherwise
  // there is no way back and the user is stuck.
  if (cfg.budgetOn === false && cfg.loopOn === false) {
    a.status = 'active'; a.escalated = false;
    return record(state, a, 'allow', 'governor off', a.tokens, 'human');
  }

  // A grounded agent stays grounded until released. Say how to get out of it,
  // because a dead end with no instructions is how people abandon the tool.
  if (a.status === 'grounded') {
    return record(state, a, 'deny',
      'agent grounded. Resume it in the dashboard, or run: npx enforcer-governor uninstall-hook',
      a.tokens);
  }

  // The hook/proxy reports the session's cumulative token total; trust it if given.
  if (typeof ev.tokens === 'number') a.tokens = ev.tokens;
  else if (typeof ev.deltaTokens === 'number') a.tokens += ev.deltaTokens;
  if (typeof ev.cost === 'number') a.cost = ev.cost;

  // Loop / waste: the same action signature showing up too often in the recent
  // window. Counting OCCURRENCES rather than a back-to-back streak matters:
  // a stuck agent usually alternates (read A, edit A, read A, edit A...), and a
  // consecutive-only check never fires on that at all.
  const sig = ev.action || `${ev.tool || 'tool'}:${JSON.stringify(ev.args ?? '')}`;
  a.recent.push(sig);
  if (a.recent.length > cfg.loopWindow) a.recent.shift();
  const repeats = a.recent.reduce((n, s) => n + (s === sig ? 1 : 0), 0);
  a.loopStreak = repeats;

  if (cfg.loopOn && repeats >= cfg.loopLimit) {
    a.status = 'grounded';
    return record(state, a, 'deny',
      `waste: same action ${repeats}x in the last ${a.recent.length}`, a.tokens);
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
    a.budgetRaised = true; // a human overrode the cap; stop recomputing it
    a.status = 'active';
    a.escalated = false;
    return record(state, a, 'allow', 'budget raised +50%', a.tokens, 'human');
  }
  a.status = 'grounded';
  return record(state, a, 'deny', 'escalation denied', a.tokens, 'human');
}

// Release a grounded agent and give it room to finish. This is the way out.
export function release(state, agentId, extra = 1.5) {
  const a = state.agents[agentId];
  if (!a) return null;
  a.budget = Math.round(Math.max(a.budget, a.tokens) * extra);
  a.budgetRaised = true; // a human overrode the cap; stop recomputing it
  a.status = 'active';
  a.escalated = false;
  a.loopStreak = 0;
  return record(state, a, 'allow', 'released by a human, budget raised', a.tokens, 'human');
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
