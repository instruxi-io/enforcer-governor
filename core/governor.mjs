// The governor, as one object any harness can drive.
//
// Everything a harness needs is here: decide before a tool runs, record what
// happened after, count a spawn, brief the agent at a turn boundary, open and
// close a session, ship the record. What is NOT here is the harness itself --
// how it hands over a tool call, how it measures spend, how it words a refusal
// to a person. Those belong to the adapter (adapters/claude-code/ is the first),
// which calls this and translates the answer.
//
// The failure contract is the one gate.mjs has always kept, and a new adapter
// inherits it by calling before():
//   - capability rules need no state and FAIL CLOSED: a refusal is still made,
//     and recorded unhashed, when the state cannot be read;
//   - spend and rate checks need state and FAIL OPEN, saying so;
//   - a tenant policy that cannot be reached leaves the local rule in charge.
import { createHash } from 'node:crypto';
import { gate } from './gate.mjs';
import { matchRule, DEFAULT_RULES } from './capability.mjs';
import { consult } from './central.mjs';
import { evaluate as economics } from './economics.mjs';
import { DEFAULTS, priceOf, tokensForDollars, dollarsForTokens, getAgent, setModel, clientFor, sha256 } from './policy.mjs';
import { withLock, loadState, saveState, loadConfig, writeReceipt } from './store.mjs';
import { effective, refresh, stale } from './managed.mjs';
import { kick } from './ship.mjs';
import { brief as briefFor, markTold } from './brief.mjs';
import { costUsd } from './cost.mjs';

// The tool a receipt names: the harness's own name when the adapter gave one,
// so the record and the console read as they always have ('Bash', not
// 'shell'). An older caller put that name in `tool`; an adapter that sets
// `name` is taken at its word, even when it is empty. Nothing is inferred from
// the action text here -- a receipt states what the caller said, no more.
const recorded = (event) => String(('name' in event ? event.name : event.tool) || '');

/**
 * How a harness reports spend. Claude Code's comes from its transcript and its
 * status-line figure (adapters/claude-code/meter.mjs); a harness with no figure
 * at all can omit it, and the spend checks then see nothing spent.
 *
 *   read(event, cfg)  -> { tokens, model, task?, usd, source }   before each call
 *   total(event)      -> { tokens, model, usd, source }          at session end
 */
export const NO_COST = Object.freeze({
  read: () => ({ tokens: 0, model: '', usd: null, source: 'none' }),
  total: () => ({ tokens: 0, model: '', usd: null, source: 'none' }),
});

/**
 * @param {object} opts
 * @param {string} [opts.harness]  who is asking: 'claude-code', 'mcp-proxy'.
 *   Every receipt this governor writes carries it, so a record shared by two
 *   harnesses -- or a console reading a fleet of them -- can tell them apart.
 * @param {string} [opts.adapterVersion]  the adapter's version, on every
 *   receipt beside the harness: a decision is only explainable against the
 *   code that made it.
 * @param {{read: Function, total: Function}} [opts.cost]  see NO_COST
 */
export function createGovernor({ harness = 'unknown', adapterVersion = '', cost = NO_COST } = {}) {
  // Stamped on every receipt, after every other field (see verdict.mjs entry()).
  const stamp = { harness, adapterVersion };
  // Local config under the tenant's managed floor: stricter wins, per setting.
  // Read from a cache that session.start() refreshes; no decision waits on the
  // network for it.
  const config = () => effective({ ...DEFAULTS, ...loadConfig() });

  /**
   * Decide before a tool runs, and record the decision.
   *
   * event: { agent, action, tool, name, input, raw?, fields?, cwd, billing,
   *          session?, transcript? }
   *   action is the text the rules match (see the adapter's matchText).
   *   tool   is the kind in the core's vocabulary (shell, edit, ... tools.mjs);
   *   name   what the harness called it ('Bash'), which is what receipts record;
   *   input  the canonical fields (command, path, content, url);
   *   raw    the harness's own input, which a rewrite edits and hands back;
   *   fields canonical field -> the harness's key, for that rewrite.
   * An older caller that sends only `tool: 'Bash'` is still understood.
   *
   * Returns { verdict, spend: { model, tokens, budget }, config }. The verdict
   * is a Verdict (verdict.mjs); the adapter words it for its harness.
   */
  async function before(event) {
    const cfg = config();
    // The tenant's policy is asked BEFORE taking the lock, and only when a
    // local rule matched: the network must never sit inside the lock, and an
    // unmatched call has nothing to ask about.
    const rules = cfg.rulesOn === false ? [] : (cfg.rules || DEFAULT_RULES);
    const matched = matchRule(rules, event);
    const central = matched ? await consult(matched, cfg) : null;

    const spend = { model: cfg.model, tokens: 0, budget: 0 };
    // Who the agent acted for, and for which project, from config and the
    // working directory: a rule decides before economics stamps these on the
    // agent, and those first receipts are the ones an audit reads first.
    const acting = (a) => ({
      operator: a?.operator || cfg.operator || '',
      client: a?.client || clientFor(event.cwd, cfg.clients) || '',
    });

    // One lock covers deciding AND recording: the chain hashes each entry
    // against the previous head, so parallel calls must not interleave.
    const held = withLock(() => {
      const state = loadState();
      const reading = cost.read(event, cfg);
      // Price the agent at its OWN model before judging it.
      const a = getAgent(state, event.agent, cfg);
      if (reading.model) setModel(a, reading.model);
      if (!a.budgetRaised) a.budget = tokensForDollars(cfg.dollars, priceOf(a.model, cfg.model).in);

      const v = gate(event, cfg, {
        withState: (fn) => ({ ok: true, value: fn(state, reading) }),
        economics,
        central,
      });

      spend.model = a.model; spend.tokens = a.tokens; spend.budget = a.budget;
      const entry = v.entry({ agent: event.agent, tool: recorded(event), model: a.model || '',
        tokens: Math.round(a.tokens), ...acting(a),
        meter: reading.source, ...stamp });
      const hash = sha256(state.prevHash + JSON.stringify(entry));
      state.prevHash = hash;
      writeReceipt(entry, hash);
      saveState(state);
      return v;
    });

    // The blind path: capability needs no state, so it still gets to refuse,
    // and the refusal is recorded without a hash rather than hidden or forged.
    const verdict = held.ok && held.value ? held.value : gate(event, cfg, { central });
    if (!held.ok || !held.value) {
      writeReceipt(verdict.entry({ agent: event.agent, tool: recorded(event), ...acting(), chained: false, ...stamp }), undefined);
    }
    return { verdict, spend, config: cfg };
  }

  /**
   * Record what happened after a tool ran. A failure feeds the retry-rate
   * check: the rate-limited call is cheap, the retry after it is what costs.
   */
  function after(event, { failed = false } = {}) {
    if (failed) {
      withLock(() => {
        const state = loadState();
        const a = getAgent(state, event.agent, { ...DEFAULTS, ...loadConfig() });
        (a.fails ||= []).push(Date.now());
        while (a.fails.length > 40) a.fails.shift();
        saveState(state);
      });
    }
    // Ship what has been decided, without waiting (at most every 30s).
    if (loadConfig().shipOn !== false) kick();
  }

  /** Count a new agent starting, for the fan-out rate check. */
  function spawned(id = 'subagent') {
    withLock(() => {
      const state = loadState();
      const now = Date.now();
      (state.spawns ||= []).push({ t: now, id });
      // A minute is every rate check's window; keep a little more so a burst
      // spanning the boundary is still visible.
      state.spawns = state.spawns.filter(s => s.t > now - 120000);
      saveState(state);
    });
  }

  /**
   * What to tell the agent at a turn boundary, or null. Said once per
   * situation. Fails open and silent: a governor that cannot read its state
   * has nothing useful to say.
   */
  function brief(agent) {
    const held = withLock(() => {
      const cfg = { ...DEFAULTS, ...loadConfig() };
      const state = loadState();
      const a = (state.agents || {})[agent];
      const b = briefFor(a, cfg);
      if (b) { markTold(a, b.situation); saveState(state); }
      return b;
    });
    return held.ok ? held.value : null;
  }

  const session = {
    /** Pick up the tenant's managed floor when the cached copy is stale. */
    async start() {
      if (stale()) { try { await refresh({ ...DEFAULTS, ...loadConfig() }); } catch {} }
    },
    /**
     * Close the record with what the session cost: a summary receipt an audit
     * can read without replaying every line. `total` is the harness's figure
     * when it has one; `source` says which kind it was.
     */
    end(event) {
      withLock(() => {
        const state = loadState();
        const agent = event.agent;
        const { tokens, model, usd: harnessFigure, source } = cost.total(event);
        const a = state.agents[agent];
        if (!a && !tokens) return;
        const usd = harnessFigure ?? dollarsForTokens(tokens, priceOf(model).in);
        // ONE number, two readers: the sentence and the field a machine sums.
        const c = costUsd(usd);
        const entry = { ts: new Date().toISOString(), agent, verdict: 'summary',
          reason: `session ended after $${usd.toFixed(2)}`, tokens: Math.round(tokens),
          ...(model ? { model } : {}), ...(a?.client ? { client: a.client } : {}),
          ...(a?.operator ? { operator: a.operator } : {}),
          // Appended last so every field above keeps its position in the hash.
          meter: source,
          ...(c === undefined ? {} : { cost_usd: c }),
          // ...and these after it, for the same reason.
          ...(harness ? { harness } : {}), ...(adapterVersion ? { adapter_version: adapterVersion } : {}) };
        const hash = createHash('sha256').update(state.prevHash + JSON.stringify(entry)).digest('hex');
        writeReceipt(entry, hash);
        state.prevHash = hash;
        saveState(state);
      });
    },
  };

  /** Ship the record now-ish: delayMs is the throttle (0 at session end). */
  function flush(delayMs = 30_000) {
    if (loadConfig().shipOn !== false) kick(delayMs);
  }

  return { harness, adapterVersion, config, before, after, spawned, brief, session, flush };
}
