// Shipping receipts to the control plane, and pointing Claude Code's telemetry at it.
// `node test/ship.test.mjs`. No network: fetch is injected.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const home = mkdtempSync(join(tmpdir(), 'gov-ship-'));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.GOVERNOR_HOME = join(home, '.enforcer-governor');
process.env.ENFORCER_HOME = join(home, '.enforcer');
process.env.CLAUDE_SETTINGS_PATH = join(home, '.claude', 'settings.json');
delete process.env.ENFORCER_API_KEY;
mkdirSync(process.env.GOVERNOR_HOME, { recursive: true });

const { toOtlp, shipOnce, installId, RECEIPT_SCOPE } = await import('../src/ship.mjs');
const { saveCredentials } = await import('../src/credentials.mjs');
const { RECEIPTS } = await import('../src/store.mjs');
const { stats } = await import('../src/outbox.mjs');
const telemetry = await import('../adapters/claude-code/telemetry.mjs');

let pass = 0;
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Receipts exactly as writeReceipt writes them: {...entry, hash}, hash last.
function chainLines(prev, entries) {
  return entries.map((entry) => {
    const hash = sha(prev + JSON.stringify(entry));
    prev = hash;
    return { ...entry, hash };
  });
}
const entry = (n, verdict = 'deny') => ({ ts: `2026-09-14T12:00:0${n}.000Z`, agent: 'claude:abcd1234', verdict, reason: `r${n}`, source: 'capability', tool: 'Bash', model: 'claude-opus-5', tokens: n });
const attrs = (rec) => Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue]));

await ok('the shipped body is exactly the text that was hashed, chained to its predecessor', () => {
  const lines = chainLines('genesis', [entry(1), entry(2)]);
  const { body, prev, count } = toOtlp(lines, 'genesis', 'install-1');
  const recs = body.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(count, 2);
  assert.equal(body.resourceLogs[0].scopeLogs[0].scope.name, RECEIPT_SCOPE);
  for (const [i, r] of recs.entries()) {
    const a = attrs(r);
    assert.equal(sha(a['enforcer.receipt.prev'] + r.body.stringValue), a['enforcer.receipt.hash'], `record ${i} must verify on the server`);
  }
  assert.equal(attrs(recs[1])['enforcer.receipt.prev'], lines[0].hash);
  assert.equal(prev, lines[1].hash);
  const res = Object.fromEntries(body.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(res['enforcer.install_id'], 'install-1');
});

await ok('a record re-chained from genesis after a state reset is sent so it verifies (the server flags a break, not tampering)', () => {
  const before = chainLines('genesis', [entry(1)]);
  const after = chainLines('genesis', [entry(2)]);   // state was reset: chained from genesis again
  const recs = toOtlp([...before, ...after], 'genesis', 'i').body.resourceLogs[0].scopeLogs[0].logRecords;
  const a = attrs(recs[1]);
  assert.equal(a['enforcer.receipt.prev'], 'genesis');
  assert.equal(sha(a['enforcer.receipt.prev'] + recs[1].body.stringValue), a['enforcer.receipt.hash']);
});

await ok('an altered record is still sent as-is, so the server refuses it', () => {
  const [line] = chainLines('genesis', [entry(1)]);
  line.verdict = 'allow';   // edited after the fact
  const r = toOtlp([line], 'genesis', 'i').body.resourceLogs[0].scopeLogs[0].logRecords[0];
  const a = attrs(r);
  assert.notEqual(sha(a['enforcer.receipt.prev'] + r.body.stringValue), a['enforcer.receipt.hash']);
});

await ok('an unhashed blind-path record is marked unchained and does not move the chain', () => {
  const [first] = chainLines('genesis', [entry(1)]);
  const blind = entry(2);
  const { body, prev } = toOtlp([first, blind], 'genesis', 'i');
  const recs = body.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(attrs(recs[1])['enforcer.receipt.chained'], false);
  assert.equal(attrs(recs[1])['enforcer.receipt.hash'], undefined);
  assert.equal(prev, first.hash);
});

await ok('the install id is created once and kept', () => {
  const a = installId(), b = installId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(a, b);
});

// ── shipOnce: the network path ─────────────────────────────────────────────
await ok('signed out: nothing is sent', async () => {
  let calls = 0;
  const r = await shipOnce({}, { fetchImpl: async () => { calls++; } });
  assert.match(r.skipped, /not signed in/);
  assert.equal(calls, 0);
});

saveCredentials({ enforcer: { api_key: 'env3_' + 'k'.repeat(43), base_url: 'https://api.example.test' } });
const lines = chainLines('genesis', [entry(1), entry(2), entry(3)]);
for (const l of lines) appendFileSync(RECEIPTS, JSON.stringify(l) + '\n');

await ok('a refused credential does not advance the queue', async () => {
  const r = await shipOnce({}, { fetchImpl: async () => ({ status: 401, json: async () => ({}) }) });
  assert.match(r.error, /login/);
  assert.equal(stats().behind, true);
});

let captured;
await ok('ships pending receipts as OTLP/JSON with the Enforcer credential, then advances', async () => {
  const r = await shipOnce({}, { fetchImpl: async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return { status: 200, json: async () => ({}) };
  } });
  assert.equal(r.shipped, 3);
  assert.equal(captured.url, 'https://api.example.test/api/v1/governance/otlp/v1/logs');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.ok(captured.init.headers['X-API-Key'].startsWith('env3_'));
  assert.equal(captured.body.resourceLogs[0].scopeLogs[0].logRecords.length, 3);
  assert.equal(stats().behind, false);
});

await ok('the next batch continues the chain from where the last one stopped', async () => {
  const [next] = chainLines(lines[2].hash, [entry(4)]);
  appendFileSync(RECEIPTS, JSON.stringify(next) + '\n');
  let body;
  await shipOnce({}, { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return { status: 200, json: async () => ({}) }; } });
  const a = attrs(body.resourceLogs[0].scopeLogs[0].logRecords[0]);
  assert.equal(a['enforcer.receipt.prev'], lines[2].hash, 'the first record of a later batch must carry the previous batch\'s last hash');
});

await ok('a partial success advances past refused records and says so', async () => {
  appendFileSync(RECEIPTS, JSON.stringify({ ...entry(5), hash: 'f'.repeat(64) }) + '\n');
  const r = await shipOnce({}, { fetchImpl: async () => ({ status: 200, json: async () => ({ partialSuccess: { rejectedLogRecords: '1' } }) }) });
  assert.equal(r.rejected, 1);
  assert.equal(stats().behind, false, 'a record the server will never accept must not be resent forever');
  assert.match(stats().lastError.message, /refused/);
});

await ok('a server outage keeps the receipts queued', async () => {
  appendFileSync(RECEIPTS, JSON.stringify(chainLines('genesis', [entry(6)])[0]) + '\n');
  const r = await shipOnce({}, { fetchImpl: async () => ({ status: 503, json: async () => ({}) }) });
  assert.match(r.error, /503/);
  assert.equal(stats().behind, true);
});

// Leave one real export on disk for the cross-language contract check.
if (process.env.GOVERNOR_EXPORT_FIXTURE) writeFileSync(process.env.GOVERNOR_EXPORT_FIXTURE, JSON.stringify(captured.body));

// ── telemetry settings ─────────────────────────────────────────────────────
await ok('telemetry on writes the export settings and a helper, and keeps everything else', () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(process.env.CLAUDE_SETTINGS_PATH, JSON.stringify({ statusLine: { type: 'command', command: 'x' }, env: { KEEP_ME: '1' } }));
  const r = telemetry.enable({ centralUrl: 'https://api.example.test' });
  const s = JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'));
  assert.equal(r.endpoint, 'https://api.example.test/api/v1/governance/otlp');
  assert.equal(s.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(s.env.OTEL_EXPORTER_OTLP_ENDPOINT, r.endpoint);
  // Claude Code caches the helper's headers for 29 minutes by default and an
  // OAuth token lives 15: without this, half of every cycle sent an expired token.
  assert.ok(Number(s.env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS) > 0 && Number(s.env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS) < 15 * 60_000,
    'the header cache must refresh within an OAuth token\'s 15-minute life');
  assert.equal(s.env.KEEP_ME, '1');
  assert.deepEqual(s.statusLine, { type: 'command', command: 'x' });
  assert.match(s.otelHeadersHelper, /otel-headers\.mjs/);
  assert.equal(JSON.stringify(s).includes('env3_'), false, 'no credential may be written into settings');
  assert.equal(existsSync(process.env.CLAUDE_SETTINGS_PATH + '.enforcer-backup'), true);
  assert.equal(telemetry.status().on, true);
});

await ok('the headers shim prints the Enforcer headers from the shared sign-in', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [join(process.env.ENFORCER_HOME, 'otel-headers.mjs')], { env: process.env, encoding: 'utf8' });
  assert.ok(JSON.parse(out)['X-API-Key'].startsWith('env3_'));
});

await ok('telemetry off removes exactly what on wrote', () => {
  telemetry.disable();
  const s = JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'));
  assert.deepEqual(s.env, { KEEP_ME: '1' });
  assert.equal(s.otelHeadersHelper, undefined);
  assert.deepEqual(s.statusLine, { type: 'command', command: 'x' });
});

await ok('a settings file that is not valid JSON is never overwritten', () => {
  writeFileSync(process.env.CLAUDE_SETTINGS_PATH, '{ not json');
  assert.throws(() => telemetry.enable({}));
  assert.equal(readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'), '{ not json');
});

console.log(`\n  ${pass} passed`);
