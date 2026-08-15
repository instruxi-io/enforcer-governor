// Enforcer Governor daemon. Zero dependencies (node:http + node:fs + fetch).
// Serves the dashboard, exposes the /decide API the hook calls, streams
// decisions over SSE, and proxies agent traffic for non-Claude agents.
import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeState, decide, resolve, kill, release, verifyChain, getAgent, rateFor, DEFAULTS, RATES, tokensForDollars } from './policy.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const DATA_DIR = join(HOME, '.enforcer-governor');
const RECEIPTS = join(DATA_DIR, 'receipts.jsonl');

// Config: defaults <- governor.config.json (cwd) <- env.
// Dollars are the source of truth; budget (effective tokens) is derived, so
// nobody has to think in tokens unless they want to.
function syncBudget(cfg) {
  const perM = (RATES[cfg.rate] || RATES.opus).perM;
  cfg.budget = tokensForDollars(cfg.dollars, perM);
  return cfg;
}
function loadConfig() {
  let cfg = { ...DEFAULTS, port: 4000 };
  const f = join(process.cwd(), 'governor.config.json');
  if (existsSync(f)) { try { cfg = { ...cfg, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch {} }
  if (process.env.GOVERNOR_DOLLARS) cfg.dollars = +process.env.GOVERNOR_DOLLARS;
  if (process.env.GOVERNOR_RATE) cfg.rate = process.env.GOVERNOR_RATE;
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
  const perM = (RATES[rateFor(a.model, CONFIG.rate)] || RATES.opus).perM;
  return tokensForDollars(CONFIG.dollars, perM);
}

const CONFIG = loadConfig();
const state = makeState();
const clients = new Set(); // SSE connections

function broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(data); } catch {} }
}

function snapshot() {
  return { agents: Object.values(state.agents).map(a => ({
    id: a.id, tokens: Math.round(a.tokens), budget: a.budget, soft: a.soft,
    status: a.status, cost: a.cost, model: a.model || '', task: a.task || '',
  })), config: {
    budget: CONFIG.budget, soft: CONFIG.soft, loopLimit: CONFIG.loopLimit,
    softAction: CONFIG.softAction, budgetOn: CONFIG.budgetOn, loopOn: CONFIG.loopOn,
    dollars: CONFIG.dollars, rate: CONFIG.rate, rates: RATES,
  } };
}

async function persist(r) {
  try { await mkdir(DATA_DIR, { recursive: true }); await appendFile(RECEIPTS, JSON.stringify(r.entry) + '\n'); } catch {}
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };

// ── Proxy: meter + gate real agent traffic ("any agent" path) ───────────────
const UPSTREAMS = {
  '/v1/messages': 'https://api.anthropic.com/v1/messages',
  '/v1/chat/completions': 'https://api.openai.com/v1/chat/completions',
};
// Cost-weighted effective tokens (same weights as the hook: input=1,
// output 5x, cache-create 1.25x, cache-read 0.1x).
function extractUsage(body, path) {
  try {
    const j = JSON.parse(body);
    const u = j.usage || {};
    if (path.includes('chat/completions')) return Math.round((u.prompt_tokens || 0) + 5 * (u.completion_tokens || 0));
    return Math.round((u.input_tokens || 0) + 5 * (u.output_tokens || 0)
      + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0));
  } catch { return 0; }
}
async function handleProxy(req, res, path) {
  const agent = req.headers['x-enforcer-agent'] || 'proxy-agent';
  // Pre-check: if this agent is already grounded/over budget, refuse before spending.
  const pre = decide(state, { agent, deltaTokens: 0, action: 'proxy:' + path }, CONFIG);
  if (pre.verdict === 'deny') {
    broadcast('decision', { ...pre, model: 'proxy' }); await persist(pre);
    return json(res, 429, { error: { type: 'enforcer_blocked', message: 'Enforcer blocked this agent: ' + pre.reason, receipt: pre.receipt } });
  }
  const body = await readBody(req);
  const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
  let upstream;
  try {
    upstream = await fetch(UPSTREAMS[path], { method: 'POST', headers, body });
  } catch (e) { return json(res, 502, { error: { message: 'upstream unreachable: ' + e.message } }); }
  const respBody = await upstream.text();
  const used = extractUsage(respBody, path);
  const post = decide(state, { agent, deltaTokens: used, action: 'proxy:' + path }, CONFIG);
  post.agent.lastUsed = used;
  broadcast('decision', { ...post, model: 'proxy' }); await persist(post);
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
    if (ev.model) a.model = ev.model;
    if (ev.task) a.task = ev.task;
    if (!a.budgetRaised) a.budget = budgetFor(a);
    const r = decide(state, ev, CONFIG);
    broadcast('decision', { ...r, model: ev.model || '', task: ev.task || '' });
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
    for (const k of ['budgetOn', 'loopOn', 'softAction', 'budget', 'soft', 'dollars', 'rate']) {
      if (k in patch) CONFIG[k] = patch[k];
    }
    // Raising the limit has to affect the agent already running, not just the
    // next one. Without this, changing it mid-session looks like a dead control.
    if ('dollars' in patch || 'rate' in patch) {
      if (!('budget' in patch)) syncBudget(CONFIG);
      for (const a of Object.values(state.agents)) {
        a.budgetRaised = false; a.budget = budgetFor(a);
        if (a.status === 'grounded' && a.tokens < a.budget) { a.status = 'active'; a.escalated = false; }
      }
    }
    broadcast('config', snapshot().config);
    broadcast('agents', snapshot().agents);
    return json(res, 200, snapshot().config);
  }
  if (req.method === 'GET' && path === '/state') return json(res, 200, snapshot());
  if (req.method === 'GET' && path === '/verify') return json(res, 200, { ok: verifyChain(state), receipts: state.chain.length });

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
  const r = RATES[CONFIG.rate] || RATES.opus;
  console.log(`\n  Spend limit: $${CONFIG.dollars} per agent at ${r.label} rates (${CONFIG.budget.toLocaleString()} tokens), ask-a-human at ${Math.round(CONFIG.soft * 100)}%.`);
  console.log(`  Change it in the dashboard, no restart needed.`);
  console.log(`  Receipts: ${RECEIPTS}`);
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
