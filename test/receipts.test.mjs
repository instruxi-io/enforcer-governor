// The receipt file is the record, not the in-memory chain: it has to survive a
// restart and it has to fail loudly on an edit or a deletion ANYWHERE in it.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../src/policy.mjs';
import { walkReceipts } from '../src/governor.mjs';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
const dir = mkdtempSync(join(tmpdir(), 'gov-receipts-'));
const file = join(dir, 'receipts.jsonl');

// The control plane needs a token, so the tests carry one rather than routing
// around the check -- a suite that authenticates is also the suite that would
// notice if authentication stopped working.
const TOK = 'test-token-' + '0'.repeat(20);
const AUTH = { headers: { authorization: 'Bearer ' + TOK } };

// Build a chain the same way record() does.
const chain = (entries) => {
  let h = 'genesis';
  return entries.map(e => { h = sha256(h + JSON.stringify(e)); return JSON.stringify({ ...e, hash: h }); }).join('\n') + '\n';
};
const rows = [1, 2, 3, 4].map(i => ({ ts: 1700000000000 + i, agent: 'a', verdict: 'allow', reason: 'ok', tokens: i * 10 }));

writeFileSync(file, chain(rows));
let w = walkReceipts(file);
assert(w.brokeAt === 0 && w.n === 4, `an untouched file should verify, got ${JSON.stringify(w)}`);
const head = w.head;

// Appending continues from the head, which is what a restarted governor does.
writeFileSync(file, chain(rows) + JSON.stringify({ ...rows[0], tokens: 99, hash: sha256(head + JSON.stringify({ ...rows[0], tokens: 99 })) }) + '\n');
assert(walkReceipts(file).brokeAt === 0, 'appending from the recovered head should verify');

// Edit one field in the middle.
const edited = chain(rows).split('\n');
edited[2] = JSON.stringify({ ...JSON.parse(edited[2]), tokens: 1 });
writeFileSync(file, edited.join('\n'));
assert(walkReceipts(file).brokeAt === 3, 'an edited receipt must be named');

// Remove one line entirely. This is the case a chain kept only in memory missed.
const short = chain(rows).split('\n'); short.splice(1, 1);
writeFileSync(file, short.join('\n'));
assert(walkReceipts(file).brokeAt === 2, 'a deleted receipt must be named');

console.log('receipts survive a restart and fail loudly on edits and deletions ok');

// Concurrency. The hashes are computed in decision order, so the lines must
// land in decision order. Twelve agents deciding at once was enough to
// interleave concurrent appends and break a chain that was correct in memory.
{
  const { spawn } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'gov-conc-'));
  const port = 47311;   // unlikely to collide with anything else on the machine
  const gov = spawn(process.execPath, ['src/governor.mjs', 'start', '--no-open'],
    { env: { ...process.env, HOME: home, GOVERNOR_PORT: String(port), GOVERNOR_TOKEN: TOK }, stdio: 'ignore' });
  const up = async () => { for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://localhost:${port}/verify`, AUTH)).json();
      if (typeof j.ok === 'boolean') return true;          // it is ours, not a squatter
      return false;
    } catch { await new Promise(r => setTimeout(r, 100)); }
  } return false; };
  try {
    assert(await up(), `the governor did not come up on ${port}, or something else is listening there`);
    await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(`http://localhost:${port}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH.headers },
      body: JSON.stringify({ agent: 'c' + i, deltaTokens: 1000, tool: 'Read', action: 'Read:f' + i, model: 'claude-opus-5' }),
    })));
    const v = await (await fetch(`http://localhost:${port}/verify`, AUTH)).json();
    assert(v.ok && v.receipts === 40, `40 concurrent decisions broke the chain: ${JSON.stringify(v)}`);
    console.log('the chain holds under concurrent decisions ok');
  } finally { gov.kill(); }
}

// Every route that records a decision must also write it. Resuming an agent
// wrote to the in-memory chain and not to the file, so the file's next line
// hashed against a predecessor that was not there and /verify called the
// whole record broken. The tool accusing its own receipts is the worst
// possible failure of the one claim it makes.
{
  const { spawn } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'gov-lifecycle-'));
  const port = 47312;
  const gov = spawn(process.execPath, ['src/governor.mjs', 'start', '--no-open'],
    { env: { ...process.env, HOME: home, GOVERNOR_PORT: String(port), GOVERNOR_TOKEN: TOK }, stdio: 'ignore' });
  const post = (p, b) => fetch(`http://localhost:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH.headers }, body: JSON.stringify(b) });
  try {
    for (let i = 0; i < 60; i++) {
      try { const j = await (await fetch(`http://localhost:${port}/verify`, AUTH)).json(); if (typeof j.ok === 'boolean') break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    // Walk an agent through every route that records: decide, kill, release, decide.
    await post('/decide', { agent: 'a', tokens: 100, tool: 'Read', action: 'Read:x', model: 'claude-opus-5' });
    await post('/kill', { agent: 'a' });
    await post('/release', { agent: 'a' });
    await post('/decide', { agent: 'a', tokens: 200, tool: 'Read', action: 'Read:y', model: 'claude-opus-5' });
    const v = await (await fetch(`http://localhost:${port}/verify`, AUTH)).json();
    assert(v.ok, `the chain broke after a normal kill and resume: ${JSON.stringify(v)}`);
    console.log('the chain survives the whole agent lifecycle ok');
  } finally { gov.kill(); }
}

// The proxy path had no test at all, and an undefined variable crashed every
// request through it for five releases. This walks a real request through a
// real governor to a real upstream, which is the only way that class of bug
// gets caught.
{
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const home = mkdtempSync(join(tmpdir(), 'gov-proxy-'));
  const upstreamPort = 47320, port = 47321;

  let seen = null;
  const upstream = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      seen = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', model: seen.model,
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
    });
  });
  await new Promise(r => upstream.listen(upstreamPort, r));

  const gov = spawn(process.execPath, ['src/governor.mjs', 'start', '--no-open'], {
    env: { ...process.env, HOME: home, GOVERNOR_PORT: String(port), GOVERNOR_TOKEN: TOK,
           GOVERNOR_OPENAI_URL: `http://localhost:${upstreamPort}/v1/chat/completions` },
    stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) {
      try { const j = await (await fetch(`http://localhost:${port}/verify`, AUTH)).json(); if (typeof j.ok === 'boolean') break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    const r = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-enforcer-agent': 'p1', 'x-enforcer-client': 'Acme Corp' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert(r.status === 200, `a normal proxy request must succeed, got ${r.status}`);
    assert(r.headers.get('x-enforcer-verdict') === 'allow', 'the verdict belongs on the response');
    assert(seen && seen.model === 'claude-opus-5', 'the request must reach the upstream unchanged');

    const st = await (await fetch(`http://localhost:${port}/state`, AUTH)).json();
    const a = st.agents.find(x => x.id === 'p1');
    assert(a && a.tokens > 0, 'usage from the response must be metered onto the agent');
    assert(st.config.byClient['Acme Corp'] > 0, 'the client header must attribute the spend');
    console.log('a request through the proxy is metered, attributed and receipted ok');
  } finally { gov.kill(); upstream.close(); }
}

// The daemon can switch off every check and hand over the whole record, so the
// door has to stay shut. Before this it did not: POST /config was
// unauthenticated and the preflight answered `access-control-allow-origin: *`,
// which put "disable enforcement" and "download the work log" inside reach of
// any page open in the user's browser. These assertions are the regression
// guard -- and the last one is the one that matters, because a check that
// returns 401 while the write still lands would pass all the others.
{
  const { spawn } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'gov-authz-'));
  const port = 47331;
  const gov = spawn(process.execPath, ['src/governor.mjs', 'start', '--no-open'],
    { env: { ...process.env, HOME: home, GOVERNOR_PORT: String(port), GOVERNOR_TOKEN: TOK }, stdio: 'ignore' });
  const at = p => `http://localhost:${port}${p}`;
  const code = async (p, o) => { try { return (await fetch(at(p), o)).status; } catch { return 0; } };
  try {
    for (let i = 0; i < 60; i++) {
      try { const j = await (await fetch(at('/verify'), AUTH)).json(); if (typeof j.ok === 'boolean') break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    const patch = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rulesOn: false }) };

    assert(await code('/config', patch) === 401, 'an unauthenticated config write must be refused');
    assert(await code('/receipts.csv') === 401, 'the record must not be readable without the token');
    assert(await code('/state') === 401, 'state must not be readable without the token');
    assert(await code('/events') === 401, 'the event stream must not be open to anyone');
    // A wrong token of the right length: the compare must reject on value, not length.
    assert(await code('/state', { headers: { authorization: 'Bearer ' + 'x'.repeat(TOK.length) } }) === 401,
      'a wrong token of the correct length must still be refused');
    // No CORS at all. Refusing the preflight is also what keeps a cross-origin
    // POST "simple", where the missing Authorization header fails the check.
    assert(await code('/config', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }) === 403,
      'the preflight must not hand a browser permission to call this daemon');
    // DNS rebinding: same-origin is not enough, because a rebound page could
    // just GET / and read the token out of the page we serve it. This one needs
    // a raw request -- fetch() treats Host as a forbidden header and quietly
    // rewrites it, so a fetch-based version of this test passes without ever
    // exercising the check.
    const { request } = await import('node:http');
    const rawHostStatus = await new Promise(resolve => {
      const r = request({ host: '127.0.0.1', port, path: '/state', method: 'GET',
        headers: { host: 'evil.example', authorization: 'Bearer ' + TOK } },
        res2 => { res2.resume(); resolve(res2.statusCode); });
      r.on('error', () => resolve(0));
      r.end();
    });
    assert(rawHostStatus === 403,
      `a request whose Host is not localhost must be refused even with a valid token, got ${rawHostStatus}`);

    const st = await (await fetch(at('/state'), AUTH)).json();
    assert(st.config.rulesOn === true, 'none of the refused writes may have landed');
    console.log('the local API refuses unauthenticated callers, preflights and rebound hosts ok');
  } finally { gov.kill(); }
}
