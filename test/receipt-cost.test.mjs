// The money field on a receipt. `node test/receipt-cost.test.mjs`.
//
// Until 2.3.0 the governor knew what a session had spent and said so only in
// prose — "session ended after $6.34" — so the control plane had to parse an
// English sentence to chart spend, and receipts.cost_usd was 0 on every row in
// production. The figure is now a field as well.
//
// The hard part is the chain: hash = sha256(prev + body), and the body is the
// entry JSON minus its hash. Adding a field changes the body, so these tests
// exist to prove what that does NOT break — receipts written by an older
// governor still verify, still ship, and still chain onto the new ones.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const HOOK = new URL('../hooks/session.mjs', import.meta.url).pathname;

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

/** A governor home with one known agent, shipping switched off. */
function home({ harness = null, tokens = 0 } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'gov-cost-'));
  const dir = join(h, '.enforcer-governor');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ shipOn: false }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    prevHash: 'genesis',
    agents: { 'claude:sess1234': { id: 'claude:sess1234', tokens, client: 'acme', budget: 1e9 } },
  }));
  if (harness !== null) {
    writeFileSync(join(dir, 'cost-sess1234.json'), JSON.stringify({ usd: harness, at: Date.now() }));
  }
  return { h, dir };
}

/** Run SessionEnd and return the receipt lines it left behind. */
function endSession(h, ev = {}) {
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'sess1234', ...ev }),
    env: { ...process.env, GOVERNOR_HOME: join(h, '.enforcer-governor'), HOME: h, ENFORCER_HOME: h },
    encoding: 'utf8',
  });
  const file = join(h, '.enforcer-governor', 'receipts.jsonl');
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── the field itself ────────────────────────────────────────────────────────

const { costUsd, COST_MAX } = await import('../adapters/claude-code/meter.mjs');

ok('a cost outside what the control plane accepts is left off, not zeroed', () => {
  // The server stores a missing cost as 0 and reads that back as "never
  // reported". A fabricated zero would be indistinguishable from a real one.
  for (const bad of [NaN, Infinity, -0.01, COST_MAX, COST_MAX + 1, '3.40', null, undefined]) {
    assert.equal(costUsd(bad), undefined, String(bad));
  }
});

ok('a cost is rounded to the six decimals the column actually stores', () => {
  assert.equal(costUsd(6.3412345678), 6.341235);
  assert.equal(costUsd(0), 0);
  assert.equal(costUsd(0.0000004), 0);      // below the column's resolution
});

ok('a value that only exceeds the limit AFTER rounding is refused, not shipped', () => {
  // The server rejects >= 1e6. 999999.9999999 passes a raw bounds check and
  // then rounds to exactly 1e6, so bounding the raw value would ship a receipt
  // the control plane refuses — and a refused receipt is resent forever.
  assert.equal(costUsd(999999.9999999), undefined);
  assert.equal(costUsd(999999.999998), 999999.999998);
});

// ── the summary receipt ─────────────────────────────────────────────────────

ok('the session summary carries the harness figure as a field', () => {
  const { h } = home({ harness: 6.3412345678 });
  const [receipt] = endSession(h);
  assert.equal(receipt.verdict, 'summary');
  assert.equal(receipt.cost_usd, 6.341235);
  assert.equal(receipt.meter, 'harness');
});

ok('the prose sentence is unchanged, and says the same number as the field', () => {
  // The control plane parses this sentence when a receipt has no field (older
  // governors), and a person reads it in /enforcer-governor:status. One figure,
  // two readers: a receipt must not say $6.34 in prose and something else in
  // its field.
  const { h } = home({ harness: 6.34 });
  const [receipt] = endSession(h);
  assert.match(receipt.reason, /^session ended after \$6\.34$/);
  assert.equal(receipt.cost_usd, 6.34);
});

ok('with no harness figure it falls back to our own arithmetic, and says so', () => {
  const { h } = home({ harness: null });
  const [receipt] = endSession(h);
  assert.equal(receipt.meter, 'transcript');
  assert.equal(receipt.cost_usd, 0);        // no transcript read, so nothing spent
  assert.match(receipt.reason, /^session ended after \$0\.00$/);
});

ok('a stale harness figure is not trusted, exactly as the hook does not trust it', () => {
  const { h, dir } = home({ harness: null });
  writeFileSync(join(dir, 'cost-sess1234.json'),
    JSON.stringify({ usd: 99, at: Date.now() - 60 * 60 * 1000 }));
  const [receipt] = endSession(h);
  assert.equal(receipt.meter, 'transcript');
  assert.notEqual(receipt.cost_usd, 99);
});

// ── the chain ───────────────────────────────────────────────────────────────

ok('the hash covers the body INCLUDING the new field', () => {
  const { h } = home({ harness: 4.5 });
  const [receipt] = endSession(h);
  const { hash, ...body } = receipt;
  assert.equal(sha256('genesis' + JSON.stringify(body)), hash);
  // And the field is genuinely inside what was hashed.
  assert.ok(JSON.stringify(body).includes('"cost_usd":4.5'));
});

ok('a receipt written before this version still verifies and still ships', async () => {
  const { h, dir } = home({ harness: 2 });
  // A 2.2.0 line: no cost_usd, no meter. Written by hand exactly as the older
  // governor wrote it, then chained onto by this version.
  const old = { ts: '2026-09-16T10:00:00.000Z', agent: 'claude:sess1234', verdict: 'allow',
    reason: 'in budget', source: 'economics', tool: 'Bash', model: 'claude-opus-5', tokens: 1000 };
  const oldHash = sha256('genesis' + JSON.stringify(old));
  appendFileSync(join(dir, 'receipts.jsonl'), JSON.stringify({ ...old, hash: oldHash }) + '\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    prevHash: oldHash,
    agents: { 'claude:sess1234': { id: 'claude:sess1234', tokens: 1000, budget: 1e9 } },
  }));

  const lines = endSession(h);
  assert.equal(lines.length, 2, 'the old line is kept, not rewritten');
  assert.deepEqual(lines[0], { ...old, hash: oldHash }, 'the old line is byte-for-byte untouched');

  // The whole file verifies: old shape, then new shape, one chain.
  process.env.GOVERNOR_HOME = join(h, '.enforcer-governor');
  const { verify } = await import('../src/store.mjs?chain');
  const v = verify(join(h, '.enforcer-governor', 'receipts.jsonl'));
  assert.equal(v.ok, true, 'a mixed-shape file must verify');
  assert.equal(v.receipts, 2);

  // And both survive the trip through the shipper, which rebuilds each body by
  // removing `hash` — the step that would break if field order shifted.
  const { toOtlp } = await import('../src/ship.mjs');
  const { body, count, prev } = toOtlp(lines, 'genesis', 'install-1', '2.3.0');
  assert.equal(count, 2);
  const records = body.resourceLogs[0].scopeLogs[0].logRecords;
  for (const r of records) {
    const attrs = Object.fromEntries(r.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue]));
    assert.equal(attrs['enforcer.receipt.chained'], true);
    assert.equal(sha256(attrs['enforcer.receipt.prev'] + r.body.stringValue), attrs['enforcer.receipt.hash'],
      'each shipped record must hash from the prev it declares');
  }
  assert.equal(records[1].attributes.find((a) => a.key === 'enforcer.receipt.prev').value.stringValue, oldHash,
    'the new-shape receipt chains onto the old-shape one');
  assert.equal(prev, lines[1].hash);
});

console.log(`\n  ${pass} passed`);
