// The receipt file is the record, not the in-memory chain: it has to survive a
// restart and it has to fail loudly on an edit or a deletion ANYWHERE in it.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../src/policy.mjs';
import { walkReceipts } from '../src/governor.mjs';

// Throw rather than exit: exiting skipped the finally blocks, which left the
// governor each test started running and holding its port.
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); throw new Error(m); } };
const dir = mkdtempSync(join(tmpdir(), 'gov-receipts-'));
const file = join(dir, 'receipts.jsonl');

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
  const port = 47000 + Math.floor(Math.random() * 900);
  const gov = spawn(process.execPath, ['src/governor.mjs', 'start', '--no-open'],
    { env: { ...process.env, HOME: home, GOVERNOR_PORT: String(port) }, stdio: 'ignore' });
  const up = async () => { for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://localhost:${port}/verify`)).json();
      if (typeof j.ok === 'boolean') return true;          // it is ours, not a squatter
      return false;
    } catch { await new Promise(r => setTimeout(r, 100)); }
  } return false; };
  try {
    assert(await up(), `the governor did not come up on ${port}, or something else is listening there`);
    await Promise.all(Array.from({ length: 40 }, (_, i) => fetch(`http://localhost:${port}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'c' + i, deltaTokens: 1000, tool: 'Read', action: 'Read:f' + i, model: 'claude-opus-5' }),
    })));
    const v = await (await fetch(`http://localhost:${port}/verify`)).json();
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
  const port = 47000 + Math.floor(Math.random() * 900) + 1000;
  const gov = spawn(process.execPath, ['src/governor.mjs', 'start', '--no-open'],
    { env: { ...process.env, HOME: home, GOVERNOR_PORT: String(port) }, stdio: 'ignore' });
  let key = '';
  const post = (p, b) => fetch(`http://localhost:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gvnr-key': key }, body: JSON.stringify(b) });
  try {
    for (let i = 0; i < 60; i++) {
      try { const j = await (await fetch(`http://localhost:${port}/verify`)).json(); if (typeof j.ok === 'boolean') break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    key = (await (await fetch(`http://localhost:${port}/`)).text()).match(/__GVNR_KEY__="([0-9a-f]+)"/)[1];
    // Walk an agent through every route that records: decide, kill, release, decide.
    await post('/decide', { agent: 'a', tokens: 100, tool: 'Read', action: 'Read:x', model: 'claude-opus-5' });
    await post('/kill', { agent: 'a' });
    await post('/release', { agent: 'a' });
    await post('/decide', { agent: 'a', tokens: 200, tool: 'Read', action: 'Read:y', model: 'claude-opus-5' });
    const v = await (await fetch(`http://localhost:${port}/verify`)).json();
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
  const port = 49000 + Math.floor(Math.random() * 900), upstreamPort = port + 1000;

  let seen = null;
  const upstream = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      seen = JSON.parse(b || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', model: seen.model,
        choices: [{ message: { role: 'assistant', content: 'Brief: the agent was summarising support tickets by theme, three themes found so far, continue from ticket 120 onwards.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
    });
  });
  await new Promise(r => upstream.listen(upstreamPort, r));

  const gov = spawn(process.execPath, ['src/governor.mjs', 'start', '--no-open'], {
    env: { ...process.env, HOME: home, GOVERNOR_PORT: String(port),
           GOVERNOR_OPENAI_URL: `http://localhost:${upstreamPort}/v1/chat/completions` },
    stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) {
      try { const j = await (await fetch(`http://localhost:${port}/verify`)).json(); if (typeof j.ok === 'boolean') break; }
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

    const st = await (await fetch(`http://localhost:${port}/state`)).json();
    const a = st.agents.find(x => x.id === 'p1');
    assert(a && a.tokens > 0, 'usage from the response must be metered onto the agent');
    assert(st.config.byClient['Acme Corp'] > 0, 'the client header must attribute the spend');
    console.log('a request through the proxy is metered, attributed and receipted ok');

    // A normal conversation is many requests. Every proxy agent used to be
    // grounded as a loop on its second one, because each request was checked
    // twice under the same name.
    for (let turn = 2; turn <= 6; turn++) {
      const rr = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-enforcer-agent': 'p1' },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hello' }, { role: 'user', content: 'turn ' + turn }] }),
      });
      assert(rr.status === 200, `turn ${turn} of a conversation must succeed, got ${rr.status}`);
    }
    console.log('a multi-turn conversation through the proxy is not mistaken for a loop ok');
    const vv = await (await fetch(`http://localhost:${port}/verify`)).json();
    assert(vv.ok, `proxy requests must leave a record that verifies: ${JSON.stringify(vv)}`);
    console.log('proxy requests leave a receipt chain that verifies on disk ok');

    // A batch job that only changes its system prompt is not a loop.
    for (let n = 1; n <= 6; n++) {
      const rr = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-enforcer-agent': 'batch' },
        body: JSON.stringify({ model: 'claude-opus-5', system: 'document ' + n, messages: [{ role: 'user', content: 'Summarise the document.' }] }),
      });
      assert(rr.status === 200, `batch item ${n} must succeed, got ${rr.status}`);
    }
    console.log('a batch job that changes only its system prompt is not a loop ok');

    // A reroute is two decisions: the refusal, then the handover. Both must be
    // on disk, or verify calls the record tampered with after every reroute.
    const key = (await (await fetch(`http://localhost:${port}/`)).text()).match(/__GVNR_KEY__="([0-9a-f]+)"/)[1];
    const cfg = b => fetch(`http://localhost:${port}/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gvnr-key': key }, body: JSON.stringify(b) });
    await cfg({ rerouteOn: true, fallbackUrl: `http://localhost:${upstreamPort}/v1/chat/completions`, fallbackModel: 'local-model', dollars: 0.0001 });
    const rr = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-enforcer-agent': 'p1' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'one more turn' }] }),
    });
    assert(rr.headers.get('x-enforcer-verdict') === 'reroute', `an out-of-budget agent should be rerouted, got ${rr.status} ${rr.headers.get('x-enforcer-verdict')}`);
    const vr = await (await fetch(`http://localhost:${port}/verify`)).json();
    assert(vr.ok, `the chain must verify after a reroute: ${JSON.stringify(vr)}`);
    console.log('a reroute leaves a receipt chain that verifies on disk ok');
  } finally { gov.kill(); upstream.close(); }
}
