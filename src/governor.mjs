// Enforcer Governor daemon. Zero dependencies (node:http + node:fs + fetch).
// Serves the dashboard, exposes the /decide API the hook calls, streams
// decisions over SSE, and proxies agent traffic for non-Claude agents.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handoffRequest, resumeWith, postJSON, HANDOFF_OPTS, RESUME_OPTS } from './handoff.mjs';
import { makeState, decide, resolve, kill, release, verifyChain, getAgent, setModel, record, rollPeriods, burnRate, spawnRate, clientFor, sha256, priceOf, dollarsForTokens, weightsFor, MODELS, DEFAULTS, DEFAULT_RULES, tokensForDollars } from './policy.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const DATA_DIR = join(HOME, '.enforcer-governor');
const RECEIPTS = join(DATA_DIR, 'receipts.jsonl');
// Running day/week/month totals live on disk, or restarting the governor would
// hand a runaway fleet a fresh budget.
const PERIODS_FILE = join(DATA_DIR, 'periods.json');
// What the human set in the dashboard. Without this, a restart silently drops
// every limit back to the default while the spend total carries on climbing --
// you would believe you were capped when you were not.
const SAVED_FILE = join(DATA_DIR, 'config.json');
const SAVED_KEYS = ['dollars', 'model', 'soft', 'softAction', 'budgetOn', 'loopOn', 'rulesOn', 'burnLimit', 'fleetBurnLimit', 'fanoutLimit', 'retryLimit', 'rerouteOn', 'fallbackUrl', 'fallbackModel', 'clients', 'clientLimits',
                    'dailyLimit', 'weeklyLimit', 'monthlyLimit', 'operator'];

// Config: defaults <- governor.config.json (cwd) <- env.
// Dollars are the source of truth; budget (effective tokens) is derived, so
// nobody has to think in tokens unless they want to.
function syncBudget(cfg) {
  cfg.budget = tokensForDollars(cfg.dollars, priceOf(cfg.model).in);
  return cfg;
}
function loadConfig() {
  let cfg = { ...DEFAULTS, port: 4000 };
  const f = join(process.cwd(), 'governor.config.json');
  if (existsSync(f)) { try { cfg = { ...cfg, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch {} }
  // Dashboard choices outlive a restart, but an explicit env var still wins.
  if (existsSync(SAVED_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(SAVED_FILE, 'utf8'));
      for (const k of SAVED_KEYS) if (k in saved) cfg[k] = saved[k];
    } catch {}
  }
  if (process.env.GOVERNOR_DOLLARS) cfg.dollars = +process.env.GOVERNOR_DOLLARS;
  if (process.env.GOVERNOR_MODEL) cfg.model = process.env.GOVERNOR_MODEL;
  if (process.env.GOVERNOR_OPERATOR) cfg.operator = process.env.GOVERNOR_OPERATOR;
  syncBudget(cfg);
  // Explicit token budget still wins, for anyone who really does think in tokens.
  // It is kept apart from the derived one, because every agent's budget is
  // recomputed from dollars and its own model, and that recompute used to throw
  // the explicit figure away: the banner said 50,000 tokens, agents got 4 million.
  if (process.env.GOVERNOR_BUDGET) cfg.budget = cfg.budgetTokens = +process.env.GOVERNOR_BUDGET;
  if (process.env.GOVERNOR_PORT) cfg.port = +process.env.GOVERNOR_PORT;
  return cfg;
}

// "$20 per agent" has to mean $20 for every agent, so convert the dollar cap
// at each agent's OWN model price. A flat token cap would silently give a
// Haiku agent a quarter of the money an Opus agent gets.
function budgetFor(a) {
  if (CONFIG.budgetTokens > 0) return CONFIG.budgetTokens;
  return tokensForDollars(CONFIG.dollars, priceOf(a.model, CONFIG.model).in);
}

const CONFIG = loadConfig();
const state = makeState();
try {
  if (existsSync(PERIODS_FILE)) Object.assign(state.periods, JSON.parse(readFileSync(PERIODS_FILE, 'utf8')));
} catch {}
// Pick the chain back up where it stopped, so restarting the governor does not
// silently start a second chain and orphan every receipt written before it.
try { state.prevHash = state.chainStart = walkReceipts().head; } catch {}
let periodsDirty = false;
const clients = new Set(); // SSE connections

function broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(data); } catch {} }
}

function snapshot() {
  rollPeriods(state);
  return { agents: Object.values(state.agents).map(a => ({
    id: a.id, tokens: Math.round(a.tokens), budget: a.budget, soft: a.soft,
    status: a.status, cost: a.cost, model: a.model || '', task: a.task || '', billing: a.billing || '',
    client: a.client || '',
    burn: +burnRate(state, undefined, a.id).toFixed(2),
  })), config: {
    budget: CONFIG.budget, soft: CONFIG.soft, loopLimit: CONFIG.loopLimit,
    softAction: CONFIG.softAction, budgetOn: CONFIG.budgetOn, loopOn: CONFIG.loopOn,
    rulesOn: CONFIG.rulesOn, operator: CONFIG.operator, rules: CONFIG.rules || DEFAULT_RULES,
    dollars: CONFIG.dollars, model: CONFIG.model, models: MODELS,
    dailyLimit: CONFIG.dailyLimit, weeklyLimit: CONFIG.weeklyLimit, monthlyLimit: CONFIG.monthlyLimit,
    burnLimit: CONFIG.burnLimit, fleetBurnLimit: CONFIG.fleetBurnLimit, fleetBurn: +burnRate(state).toFixed(2),
    fanoutLimit: CONFIG.fanoutLimit, retryLimit: CONFIG.retryLimit, spawnRate: spawnRate(state),
    spent: { day: state.periods.day.usd, week: state.periods.week.usd, month: state.periods.month.usd },
    clientLimits: CONFIG.clientLimits, byClient: state.clients ? state.clients.month.by : {},
    rerouteOn: CONFIG.rerouteOn, fallbackModel: CONFIG.fallbackModel,
    clients: CONFIG.clients, unmapped: state.unmapped || {},
  } };
}

// The hash is written WITH the entry. Without it, the file is only a log: you
// can recompute a chain over edited entries and it verifies happily, because
// nothing on disk says what the hashes were meant to be.
// Writes go through ONE queue. The hashes are computed in decision order, so
// the lines have to land in decision order too. Concurrent appends do not
// guarantee that: twelve agents deciding at once was enough to interleave the
// file and break verification of a chain that was perfectly correct in memory.
// Persist what the human chose, so a restart cannot quietly un-cap them, or
// quietly re-enable checks they switched off.
async function saveConfig() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SAVED_FILE, JSON.stringify(Object.fromEntries(SAVED_KEYS.map(k => [k, CONFIG[k]])), null, 2));
  } catch {}
}

let writeQueue = Promise.resolve();
function persist(r) {
  const line = JSON.stringify({ ...r.entry, hash: r.hash }) + '\n';
  periodsDirty = true;
  writeQueue = writeQueue.then(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(RECEIPTS, line);
    } catch {}
  });
  return writeQueue;
}

// Walk the receipts on disk. This is the real verification -- the in-memory
// chain only covers what THIS process wrote, so before this a restart began a
// fresh chain and everything written earlier could be deleted without the
// remaining file failing a check. Returns the head hash so the chain continues
// across restarts, and the first line that does not add up.
//
// ponytail: reads the whole file. 700 receipts is ~0.1MB and instant; the
// upgrade path when it is not is a periodic checkpoint {line, hash} so verify
// starts from the last checkpoint instead of genesis.
export function walkReceipts(file = RECEIPTS) {
  const out = { head: 'genesis', n: 0, legacy: 0, brokeAt: 0 };
  if (!existsSync(file)) return out;
  let lineNo = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lineNo++;
    let obj; try { obj = JSON.parse(line); } catch { out.brokeAt ||= lineNo; continue; }
    const { hash, ...entry } = obj;
    const want = sha256(out.head + JSON.stringify(entry));
    if (!hash) { out.legacy++; out.head = want; continue; }   // written before hashes were stored
    if (hash !== want) { out.brokeAt ||= lineNo; }
    out.head = hash;   // keep going from what is recorded, so one break does not cascade
    out.n++;
  }
  out.n += out.legacy;
  return out;
}
// Flushed on a timer rather than per decision: the totals are small and losing
// at most a second of spend on a hard kill is not worth a write per tool call.
setInterval(async () => {
  if (!periodsDirty) return;
  periodsDirty = false;
  try { await mkdir(DATA_DIR, { recursive: true }); await writeFile(PERIODS_FILE, JSON.stringify(state.periods)); } catch {}
}, 1000).unref();

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// A browser tab on any other site must not be able to drive the governor. The
// dashboard is served from here, so it is always same-origin; SDKs and curl send
// no Origin at all. Only the proxy paths keep permissive CORS, for API clients.
const LOCAL_HOSTS = () => [`localhost:${CONFIG.port}`, `127.0.0.1:${CONFIG.port}`, `[::1]:${CONFIG.port}`];
const sameOrigin = (req) => {
  const o = req.headers.origin;
  return !o || LOCAL_HOSTS().map(h => 'http://' + h).includes(o);
};
// Only this machine. The daemon listened on every interface, so anyone on the
// same Wi-Fi could switch every check off; a request with no Origin passes the
// browser check, so the socket address is checked as well.
const fromThisMachine = (req) => {
  const a = String(req.socket.remoteAddress || '');
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
};
// A page on another site that rebinds its own name to 127.0.0.1 arrives with
// its own Host header, and it could read /state, prompt text included.
const localHost = (req) => {
  const h = String(req.headers.host || '');
  return LOCAL_HOSTS().includes(h) || ['localhost', '127.0.0.1', '[::1]'].includes(h);
};
// Routes that loosen something need the key the governor put in the dashboard
// page it served. It changes on every start and never touches disk. This stops
// anything that did not load the dashboard, which is every naive curl.
// ponytail: an agent with a shell can still fetch the dashboard and read the
// key, as the same user it can do anything the dashboard can. Against a
// deliberate adversary, isolate the agent; this closes the easy doors.
const CONTROL_KEY = randomBytes(24).toString('hex');
const LOOSENING = new Set(['/config', '/approve', '/release', '/uninstall', '/clients']);
// Names shown on the dashboard and written to the CSV come from callers, so
// they are cut to plain characters here, once, before anything stores them.
const cleanName = (v, max = 96) => typeof v === 'string'
  ? v.replace(/[^\w .:@/+-]/g, '').replace(/^[=+\-@]+/, '').slice(0, max) : '';

// ── Proxy: meter + gate real agent traffic ("any agent" path) ───────────────
// Gemini, Groq, Together and friends all speak the OpenAI chat-completions
// shape, so one env var makes the same route work for any of them.
// Gemini: GOVERNOR_OPENAI_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
const UPSTREAMS = {
  '/v1/messages': process.env.GOVERNOR_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
  '/v1/chat/completions': process.env.GOVERNOR_OPENAI_URL || 'https://api.openai.com/v1/chat/completions',
};
// Effective tokens from a provider response, weighted by THAT model's own
// price ratios. The response says which model served it, so a mixed fleet is
// billed correctly without anyone configuring anything.
function extractUsage(body, path) {
  try {
    const j = JSON.parse(body);
    const u = j.usage || {};
    const model = j.model || '';
    const w = weightsFor(model);
    if (path.includes('chat/completions')) {
      // OpenAI counts cached tokens INSIDE prompt_tokens. Billing the whole
      // prompt at full price and then adding the cache on top double-charges
      // the cached prefix, which is most of a long agent conversation.
      const cached = u.prompt_tokens_details?.cached_tokens || 0;
      const fresh = Math.max(0, (u.prompt_tokens || 0) - cached);
      return { model, tokens: Math.round(fresh + w.cacheRead * cached + w.out * (u.completion_tokens || 0)) };
    }
    return { model, tokens: Math.round((u.input_tokens || 0) + w.out * (u.output_tokens || 0)
      + w.cacheWrite * (u.cache_creation_input_tokens || 0) + w.cacheRead * (u.cache_read_input_tokens || 0)) };
  } catch { return { model: '', tokens: 0 }; }
}
// Ask the outgoing model for a brief, then run the work on the fallback with
// only that brief. Returns true if it handled the response.
//
// Repeated compaction degrades a session, so this fires once per agent. A
// second breach after a reroute is a real stop.
async function reroute(agent, body, pre, res, path) {
  const why = m => { console.log(`  reroute skipped: ${m}`); return false; };
  const known = getAgent(state, agent, CONFIG);
  if (known.handoffs) return why('this agent has already been handed over once');
  let j; try { j = JSON.parse(body.toString()); } catch { return why('the request body is not JSON'); }
  if (!Array.isArray(j.messages) || !j.messages.length) return why('the request carries no messages');
  known.handoffs = 1;
  try {
    // 1. The brief, written by the model that did the reasoning. Bounded, since
    //    this is money spent by an agent that has already run out.
    if (!UPSTREAMS[path]) return why(`no upstream configured for ${path}`);
    const hb = await postJSON(UPSTREAMS[path],
      { ...j, messages: handoffRequest(j.messages), ...HANDOFF_OPTS, stream: false },
      CONFIG.fallbackHeaders);
    let hj; try { hj = JSON.parse(hb.text); } catch { return why(`the outgoing model returned ${hb.status}, not JSON`); }
    const brief = (hj.choices?.[0]?.message?.content || hj.content?.[0]?.text || '').trim();
    // An empty brief is worse than no reroute: the fallback would start from
    // nothing and look like it had lost the task. Fail back to the refusal.
    if (brief.length < 80) { known.handoffs = 0; return why(`the outgoing model returned a ${brief.length}-character brief, too short to hand over`); }

    // 2. The work, on the fallback, from the brief alone.
    const out = await postJSON(CONFIG.fallbackUrl,
      { ...j, model: CONFIG.fallbackModel || j.model,
        messages: resumeWith(brief, j.messages), ...RESUME_OPTS, stream: false },
      CONFIG.fallbackHeaders);
    const text = out.text;

    const r = record(state, known, 'allow',
      `out of budget, so it was handed to ${CONFIG.fallbackModel || 'the fallback model'} with a ${brief.length}-character brief`,
      known.tokens, 'policy', undefined, { rule: 'reroute' });
    r.brief = brief;
    broadcast('decision', { ...r, model: CONFIG.fallbackModel || 'fallback' });
    await persist(r);
    res.writeHead(out.status, { 'content-type': 'application/json',
      'x-enforcer-verdict': 'reroute', 'x-enforcer-receipt': r.receipt,
      'x-enforcer-handoff-chars': String(brief.length) });
    res.end(text);
    return true;
  } catch (e) { known.handoffs = 0; return why(`${e.message}${e.cause ? ' (' + e.cause.message + ')' : ''}`); }
}

async function handleProxy(req, res, path) {
  const agent = cleanName(req.headers['x-enforcer-agent'], 128) || 'proxy-agent';
  // On the API route there is no working directory to derive a client from,
  // so one header names it. This read was lost in an edit and every proxy
  // request crashed on the undefined variable for five releases, because
  // nothing tested this path.
  const client = cleanName(req.headers['x-enforcer-client']) || '';
  // Pre-check: if this agent is already grounded/over budget, refuse before spending.
  const pre = decide(state, { agent, client, deltaTokens: 0, action: 'proxy:' + path, precheck: true }, CONFIG);
  let body = await readBody(req);
  if (pre.verdict === 'deny') {
    // The refusal is saved before any reroute: it is a decision in the chain
    // either way, and saving it only on the 429 path left a gap on disk that
    // made verify call the record tampered with after every reroute.
    broadcast('decision', { ...pre, model: 'proxy' }); await persist(pre);
    const moved = CONFIG.rerouteOn && CONFIG.fallbackUrl && await reroute(agent, body, pre, res, path);
    if (moved) return;
    return json(res, 429, { error: { type: 'enforcer_blocked', message: 'GVNR blocked this agent: ' + pre.reason, receipt: pre.receipt } });
  }
  const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
  let upstream;
  try {
    upstream = await fetch(UPSTREAMS[path], { method: 'POST', headers, body });
  } catch (e) { return json(res, 502, { error: { message: 'upstream unreachable: ' + e.message } }); }
  const respBody = await upstream.text();
  // Only the proxy sees what the provider actually answered. A 429 or a 5xx
  // that the caller retries is the cheapest possible way to spend real money.
  if (upstream.status >= 400) {
    const k = getAgent(state, agent, CONFIG);
    (k.fails ||= []).push(Date.now());
    while (k.fails.length > 40) k.fails.shift();
  }
  const { tokens: used, model } = extractUsage(respBody, path);
  // Price this agent at whatever model actually answered, before judging it.
  const known = getAgent(state, agent, CONFIG);
  if (model) setModel(known, model);
  if (!known.budgetRaised) known.budget = budgetFor(known);
  // Keyed on the latest two messages: a stuck agent repeats its last turn while
  // the conversation behind it keeps growing, so a whole-body key never matched.
  let turn = String(body);
  // The system prompt, model and tool list are part of what makes a request
  // different: a batch job that only changes its system prompt is not a loop.
  try { const j = JSON.parse(turn); if (Array.isArray(j.messages)) turn = JSON.stringify([j.system, j.model, Array.isArray(j.tools) ? j.tools.length : 0, j.messages.slice(-2)]); } catch {}
  const post = decide(state, { agent, client, deltaTokens: used, action: 'proxy:' + path + '#' + sha256(turn).slice(0, 16) }, CONFIG);
  post.agent.lastUsed = used;
  broadcast('decision', { ...post, model: model || 'proxy' }); await persist(post);
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'x-enforcer-verdict': post.verdict, 'x-enforcer-receipt': post.receipt });
  res.end(respBody);
}

// One bad request must never take the daemon down: a dead governor fails open
// on everything, so a crash here is a way to switch every check off.
const server = http.createServer((req, res) => handle(req, res).catch(e => {
  try { if (!res.headersSent) json(res, 500, { error: String(e && e.message || e) }); else res.end(); } catch {}
}));

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!fromThisMachine(req)) return json(res, 403, { error: 'the governor only answers this machine' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin requests to the governor are refused' });
  if (!UPSTREAMS[path] && !localHost(req)) return json(res, 403, { error: 'unexpected Host header' });
  if (req.method === 'POST' && LOOSENING.has(path) && req.headers['x-gvnr-key'] !== CONTROL_KEY)
    return json(res, 403, { error: 'this control needs the dashboard. Open it and use the button there' });

  // Proxy paths (real agent traffic)
  if (req.method === 'POST' && UPSTREAMS[path]) return handleProxy(req, res, path);

  // Decision API  -  the hook posts here
  if (req.method === 'POST' && path === '/decide') {
    const ev = JSON.parse((await readBody(req)).toString() || '{}');
    if (!ev || typeof ev !== 'object') return json(res, 400, { error: 'expected a JSON object' });
    // The clock and the pre-check flag are the governor's, not the caller's:
    // an old ts reset the day, week and month totals.
    delete ev.ts; delete ev.precheck;
    ev.agent = cleanName(ev.agent, 128); ev.client = cleanName(ev.client);
    for (const k of ['task', 'tool', 'model', 'billing', 'cwd', 'action']) if (k in ev && typeof ev[k] !== 'string') delete ev[k];
    // Price the agent at its own model BEFORE judging it, not after, or the
    // first action of every session is measured against the wrong cap.
    const a = getAgent(state, ev.agent || 'default', CONFIG);
    if (ev.model) setModel(a, ev.model);
    if (ev.task) a.task = ev.task;
    if (!a.budgetRaised) a.budget = budgetFor(a);
    const r = decide(state, ev, CONFIG);
    broadcast('decision', { ...r, model: ev.model || '', task: ev.task || '', billing: ev.billing || '' });
    await persist(r);
    return json(res, 200, r);
  }
  if (req.method === 'POST' && path === '/approve') {
    const { agent } = JSON.parse((await readBody(req)).toString() || '{}');
    const r = resolve(state, agent, true, CONFIG); if (r) { broadcast('decision', r); await persist(r); }
    return json(res, 200, r || { error: 'unknown agent' });
  }
  if (req.method === 'POST' && path === '/deny') {
    const { agent } = JSON.parse((await readBody(req)).toString() || '{}');
    const r = resolve(state, agent, false, CONFIG); if (r) { broadcast('decision', r); await persist(r); }
    return json(res, 200, r || { error: 'unknown agent' });
  }
  if (req.method === 'POST' && path === '/release') {
    const { agent } = JSON.parse((await readBody(req)).toString() || '{}');
    const r = release(state, agent || 'default');
    // This decision goes in the chain like any other, so it has to reach the
    // FILE like any other. Without this, resuming an agent left a link that
    // existed in memory and not on disk, and every later line failed to
    // verify: the tool reported its own record as tampered with.
    if (r) await persist(r);
    broadcast('decision', r); return json(res, 200, r || { error: 'no such agent' });
  }
  if (req.method === 'POST' && path === '/kill') {
    const { agent } = JSON.parse((await readBody(req)).toString() || '{}');
    const r = kill(state, agent); if (r) { broadcast('decision', r); await persist(r); }
    return json(res, 200, r || { error: 'unknown agent' });
  }
  if (req.method === 'POST' && path === '/config') {
    const patch = JSON.parse((await readBody(req)).toString() || '{}');
    for (const k of ['budgetOn', 'loopOn', 'rulesOn', 'softAction', 'budget', 'soft', 'dollars', 'model', 'dailyLimit', 'weeklyLimit', 'monthlyLimit', 'operator', 'burnLimit', 'fleetBurnLimit', 'fanoutLimit', 'retryLimit', 'rerouteOn', 'fallbackUrl', 'fallbackModel', 'clients', 'clientLimits']) {
      if (k in patch) CONFIG[k] = patch[k];
    }
    // Raising the limit has to affect the agent already running, not just the
    // next one. Without this, changing it mid-session looks like a dead control.
    if ('budget' in patch) CONFIG.budgetTokens = +patch.budget > 0 ? +patch.budget : 0;
    else if ('dollars' in patch) CONFIG.budgetTokens = 0;
    if ('dollars' in patch || 'model' in patch || 'budget' in patch) {
      if (!('budget' in patch)) syncBudget(CONFIG);
      for (const a of Object.values(state.agents)) {
        // A limit a human deliberately raised must survive a config change.
        // Clearing budgetRaised here silently undid every "let it keep going"
        // the moment the dashboard pushed config (which it does on its own,
        // when it auto-detects the model) -- so approving looked like a no-op.
        // A global raise can still lift them; it just can never lower them.
        const next = budgetFor(a);
        a.budget = a.budgetRaised ? Math.max(a.budget, next) : next;
        if (a.status === 'grounded' && a.tokens < a.budget) { a.status = 'active'; a.escalated = false; }
      }
    }
    // Persist what the human chose, so a restart cannot quietly un-cap them.
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(SAVED_FILE, JSON.stringify(Object.fromEntries(SAVED_KEYS.map(k => [k, CONFIG[k]])), null, 2));
    } catch {}
    broadcast('config', snapshot().config);
    broadcast('agents', snapshot().agents);
    return json(res, 200, snapshot().config);
  }
  if (req.method === 'GET' && path === '/state') return json(res, 200, snapshot());
  // The record, as a spreadsheet. Every field an audit asks for, one row per
  // decision, plus the chain verdict in the filename so the file cannot be
  // passed off as verified when it was not.
  if (req.method === 'GET' && path === '/receipts.csv') {
    const w = walkReceipts();
    const cols = ['ts', 'iso', 'client', 'agent', 'operator', 'verdict', 'reason', 'rule', 'tool', 'model', 'tokens', 'usd', 'authority', 'hash'];
    const esc = v => {
      let t = v === undefined || v === null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;          // never a formula in a spreadsheet
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const rows = [cols.join(',')];
    if (existsSync(RECEIPTS)) {
      for (const line of readFileSync(RECEIPTS, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        e.iso = new Date(e.ts).toISOString();
        e.usd = dollarsForTokens(e.tokens || 0, priceOf(e.model, CONFIG.model).in).toFixed(4);
        rows.push(cols.map(c => esc(e[c])).join(','));
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `enforcer-receipts-${stamp}-${w.brokeAt ? 'CHAIN-BROKEN' : 'verified'}.csv`;
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"` });
    return res.end(rows.join('\n') + '\n');
  }

  if (req.method === 'POST' && path === '/uninstall') {
    const out = [];
    try {
      const { uninstall } = await import('./install.mjs');
      for (const scope of [false, true]) {           // this project, then global
        const f = uninstall(scope);
        if (f) out.push(f);
      }
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    // Stop enforcing immediately as well. Removing the hook only takes effect
    // on the next session, and someone pressing this wants it off NOW.
    CONFIG.budgetOn = false; CONFIG.loopOn = false; CONFIG.rulesOn = false;
    for (const a of Object.values(state.agents)) { a.status = 'active'; a.escalated = false; }
    saveConfig();
    broadcast('snapshot', snapshot());
    return json(res, 200, { ok: true, files: out });
  }

  // Name the folders. Sent from the dashboard once the tool has noticed work
  // happening in more than one place, with the guesses already filled in.
  if (req.method === 'POST' && path === '/clients') {
    const patch = JSON.parse((await readBody(req)).toString() || '{}');
    CONFIG.clients = { ...(CONFIG.clients || {}), ...(patch.clients || {}) };
    // Replace rather than merge, so clearing a cap in the dashboard actually
    // clears it instead of leaving the old figure behind.
    if (patch.limits) CONFIG.clientLimits = patch.limits;
    for (const p of Object.keys(patch.clients || {})) delete state.unmapped[p];
    // Re-attribute the agents already running, so the screen agrees with the
    // mapping immediately instead of at their next action.
    for (const a of Object.values(state.agents)) {
      if (a.cwd) { const n = clientFor(a.cwd, CONFIG.clients); if (n) a.client = n; }
    }
    await saveConfig();
    broadcast('config', snapshot().config);
    return json(res, 200, { ok: true, clients: CONFIG.clients });
  }

  if (req.method === 'GET' && path === '/verify') {
    const w = walkReceipts();
    return json(res, 200, {
      ok: w.brokeAt === 0 && verifyChain(state), receipts: w.n,
      brokeAt: w.brokeAt || undefined,
      unverifiable: w.legacy || undefined,   // receipts written before hashes were stored
    });
  }

  // SSE stream
  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // Dashboard (inject live flag)
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    try {
      let html = await readFile(join(ROOT, 'public', 'dashboard.html'), 'utf8');
      html = html.replace('/*__LIVE__*/', `window.__GOVERNOR_LIVE__=true;window.__GVNR_KEY__=${JSON.stringify(CONTROL_KEY)};`);
      // Never inside a frame: a framed dashboard carries its own origin and key,
      // so a click tricked out of the person would count as theirs.
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'" });
      return res.end(html);
    } catch { return json(res, 500, { error: 'dashboard not found' }); }
  }

  json(res, 404, { error: 'not found' });
}

// Listening is opt-in, so importing this file (a test, a tool) does not start a
// daemon and grab port 4000 as a side effect of the import.
export function start() {
server.listen(CONFIG.port, () => {
  const url = `http://localhost:${CONFIG.port}`;
  console.log(`\n  GVNR (Enforcer Governor) is running.`);
  console.log(`\n  Your dashboard:  ${url}  (opening it now)`);
  // One tailored next step beats a menu of five.
  import('./detect.mjs').then(({ nextStep }) => {
    const { lines } = nextStep(url);
    console.log('');
    for (const l of lines) console.log(l);
  }).catch(() => {
    console.log(`\n  Point any agent at this address: OPENAI_BASE_URL=${url}/v1`);
  });
  const r = priceOf(CONFIG.model);
  console.log(CONFIG.budgetTokens > 0
    ? `\n  Spend limit: ${CONFIG.budgetTokens.toLocaleString()} tokens per agent (GOVERNOR_BUDGET), it checks with you at ${Math.round(CONFIG.soft * 100)}%.`
    : `\n  Spend limit: $${CONFIG.dollars} per agent at ${r.label} rates (${CONFIG.budget.toLocaleString()} tokens), it checks with you at ${Math.round(CONFIG.soft * 100)}%.`);
  console.log(`  Change it in the dashboard, no restart needed.`);
  const caps = [['a day', CONFIG.dailyLimit], ['a week', CONFIG.weeklyLimit], ['a month', CONFIG.monthlyLimit]]
    .filter(([, v]) => v > 0).map(([w, v]) => `$${v} ${w}`);
  console.log(caps.length
    ? `  Across ALL agents together: ${caps.join(', ')}.`
    : `  No total cap across all agents yet. Set one in the dashboard: a per-agent limit does not bound a team.`);
  console.log(`  A record of every decision is kept at ${RECEIPTS}`);
  console.log(`  Stop it any time with Ctrl+C. Your agents keep working if it is off.\n`);
  // Auto-open the dashboard so nobody has to know what localhost means.
  // ponytail: darwin/win/linux openers only; anything exotic just reads the URL above.
  if (process.stdout.isTTY && !process.env.CI && !process.argv.includes('--no-open')) {
    import('node:child_process').then(({ spawn }) => {
      const cmd = process.platform === 'darwin' ? ['open', url]
        : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
      try { spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref(); } catch {}
    });
  }
});
}

// `node src/governor.mjs` still just runs. The CLI calls start() itself.
if (process.argv[1] && process.argv[1].endsWith('governor.mjs')) start();
