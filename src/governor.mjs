// Enforcer Governor daemon. Zero dependencies (node:http + node:fs + fetch).
// Serves the dashboard, exposes the /decide API the hook calls, streams
// decisions over SSE, and proxies agent traffic for non-Claude agents.
import http from 'node:http';
import { readFile, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeState, decide, resolve, kill, release, verifyChain, getAgent, setModel, record, rollPeriods, sha256, priceOf, weightsFor, modelAdvice, taskShape, MODELS, DEFAULTS, DEFAULT_RULES, tokensForDollars } from './policy.mjs';

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
const SAVED_KEYS = ['dollars', 'model', 'soft', 'softAction', 'budgetOn', 'loopOn', 'rulesOn', 'adviseModel', 'enforceModel',
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
  if (process.env.GOVERNOR_BUDGET) cfg.budget = +process.env.GOVERNOR_BUDGET;
  if (process.env.GOVERNOR_PORT) cfg.port = +process.env.GOVERNOR_PORT;
  return cfg;
}

// "$20 per agent" has to mean $20 for every agent, so convert the dollar cap
// at each agent's OWN model price. A flat token cap would silently give a
// Haiku agent a quarter of the money an Opus agent gets.
function budgetFor(a) {
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
    status: a.status, cost: a.cost, model: a.model || '', task: a.task || '',
    // Carried on the snapshot too, or the advice only ever appears on a card
    // built by a live decision and vanishes the moment you reload the page.
    advice: CONFIG.adviseModel !== false ? modelAdvice(a.model, taskShape(a.task)) : null,
  })), config: {
    budget: CONFIG.budget, soft: CONFIG.soft, loopLimit: CONFIG.loopLimit,
    softAction: CONFIG.softAction, budgetOn: CONFIG.budgetOn, loopOn: CONFIG.loopOn,
    rulesOn: CONFIG.rulesOn, operator: CONFIG.operator, rules: CONFIG.rules || DEFAULT_RULES,
    adviseModel: CONFIG.adviseModel, enforceModel: CONFIG.enforceModel,
    dollars: CONFIG.dollars, model: CONFIG.model, models: MODELS,
    dailyLimit: CONFIG.dailyLimit, weeklyLimit: CONFIG.weeklyLimit, monthlyLimit: CONFIG.monthlyLimit,
    spent: { day: state.periods.day.usd, week: state.periods.week.usd, month: state.periods.month.usd },
  } };
}

// The hash is written WITH the entry. Without it, the file is only a log: you
// can recompute a chain over edited entries and it verifies happily, because
// nothing on disk says what the hashes were meant to be.
async function persist(r) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(RECEIPTS, JSON.stringify({ ...r.entry, hash: r.hash }) + '\n');
    periodsDirty = true;
  } catch {}
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
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };

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
async function handleProxy(req, res, path) {
  const agent = req.headers['x-enforcer-agent'] || 'proxy-agent';
  // Pre-check: if this agent is already grounded/over budget, refuse before spending.
  const pre = decide(state, { agent, deltaTokens: 0, action: 'proxy:' + path }, CONFIG);
  if (pre.verdict === 'deny') {
    broadcast('decision', { ...pre, model: 'proxy' }); await persist(pre);
    return json(res, 429, { error: { type: 'enforcer_blocked', message: 'Enforcer blocked this agent: ' + pre.reason, receipt: pre.receipt } });
  }
  let body = await readBody(req);
  // The one place a downgrade is actually possible: we own this request, so we
  // can rewrite the model before forwarding. Off unless explicitly enabled --
  // silently changing someone's model is a big decision. Only ever downgrades:
  // spending MORE of someone's money without asking is not ours to do.
  let swapped = null;
  if (CONFIG.enforceModel) {
    try {
      const j = JSON.parse(body.toString());
      const known = state.agents[agent];
      const advice = modelAdvice(j.model, taskShape(known && known.task));
      if (advice && advice.cheaper) {
        j.model = advice.suggest;
        body = Buffer.from(JSON.stringify(j));
        swapped = advice;
      }
    } catch {}
  }
  const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
  let upstream;
  try {
    upstream = await fetch(UPSTREAMS[path], { method: 'POST', headers, body });
  } catch (e) { return json(res, 502, { error: { message: 'upstream unreachable: ' + e.message } }); }
  const respBody = await upstream.text();
  const { tokens: used, model } = extractUsage(respBody, path);
  // Price this agent at whatever model actually answered, before judging it.
  const known = getAgent(state, agent, CONFIG);
  // Changing someone's model is an enforcement action, so it gets its own
  // receipt in the chain. An unrecorded intervention is exactly the thing this
  // tool exists to stop.
  if (swapped) {
    const sw = record(state, known, 'allow', `switched this request to ${swapped.label}: ${swapped.why}`, known.tokens, 'policy');
    broadcast('decision', { ...sw, model: swapped.suggest }); await persist(sw);
  }
  if (model) setModel(known, model);
  if (!known.budgetRaised) known.budget = budgetFor(known);
  const post = decide(state, { agent, deltaTokens: used, action: 'proxy:' + path }, CONFIG);
  post.agent.lastUsed = used;
  broadcast('decision', { ...post, model: model || 'proxy', advice: post.advice || null }); await persist(post);
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'x-enforcer-verdict': post.verdict, 'x-enforcer-receipt': post.receipt });
  res.end(respBody);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); return res.end(); }

  // Proxy paths (real agent traffic)
  if (req.method === 'POST' && UPSTREAMS[path]) return handleProxy(req, res, path);

  // Decision API  -  the hook posts here
  if (req.method === 'POST' && path === '/decide') {
    const ev = JSON.parse((await readBody(req)).toString() || '{}');
    // Price the agent at its own model BEFORE judging it, not after, or the
    // first action of every session is measured against the wrong cap.
    const a = getAgent(state, ev.agent || 'default', CONFIG);
    if (ev.model) setModel(a, ev.model);
    if (ev.task) a.task = ev.task;
    if (!a.budgetRaised) a.budget = budgetFor(a);
    const r = decide(state, ev, CONFIG);
    broadcast('decision', { ...r, model: ev.model || '', task: ev.task || '', advice: r.advice || null });
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
    broadcast('decision', r); return json(res, 200, r || { error: 'no such agent' });
  }
  if (req.method === 'POST' && path === '/kill') {
    const { agent } = JSON.parse((await readBody(req)).toString() || '{}');
    const r = kill(state, agent); if (r) { broadcast('decision', r); await persist(r); }
    return json(res, 200, r || { error: 'unknown agent' });
  }
  if (req.method === 'POST' && path === '/config') {
    const patch = JSON.parse((await readBody(req)).toString() || '{}');
    for (const k of ['budgetOn', 'loopOn', 'rulesOn', 'softAction', 'budget', 'soft', 'dollars', 'model', 'dailyLimit', 'weeklyLimit', 'monthlyLimit', 'operator', 'adviseModel', 'enforceModel']) {
      if (k in patch) CONFIG[k] = patch[k];
    }
    // Raising the limit has to affect the agent already running, not just the
    // next one. Without this, changing it mid-session looks like a dead control.
    if ('dollars' in patch || 'model' in patch) {
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
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
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
      html = html.replace('/*__LIVE__*/', 'window.__GOVERNOR_LIVE__=true;');
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
    } catch { return json(res, 500, { error: 'dashboard not found' }); }
  }

  json(res, 404, { error: 'not found' });
});

// Listening is opt-in, so importing this file (a test, a tool) does not start a
// daemon and grab port 4000 as a side effect of the import.
export function start() {
server.listen(CONFIG.port, () => {
  const url = `http://localhost:${CONFIG.port}`;
  console.log(`\n  Enforcer Governor is running.`);
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
  console.log(`\n  Spend limit: $${CONFIG.dollars} per agent at ${r.label} rates (${CONFIG.budget.toLocaleString()} tokens), it checks with you at ${Math.round(CONFIG.soft * 100)}%.`);
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
