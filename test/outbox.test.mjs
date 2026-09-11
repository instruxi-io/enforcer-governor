// The shipping queue. `node test/outbox.test.mjs`.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-outbox-'));
process.env.HOME = home; process.env.USERPROFILE = home;
mkdirSync(join(home, '.enforcer-governor'), { recursive: true });
const FILE = join(home, '.enforcer-governor', 'receipts.jsonl');

const { pending, markShipped, markFailure, stats } = await import('../src/outbox.mjs');

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };
const add = (n) => appendFileSync(FILE, JSON.stringify({ verdict: 'allow', n, hash: 'h' + n }) + '\n');

ok('an empty record has nothing to ship', () => {
  writeFileSync(FILE, '');
  assert.deepEqual(pending().lines, []);
  assert.equal(stats().behind, false);
});

ok('new receipts are pending', () => {
  add(1); add(2); add(3);
  const p = pending();
  assert.equal(p.lines.length, 3);
  assert.equal(p.lines[2].n, 3);
  assert.ok(stats().unshippedBytes > 0);
});

ok('shipping advances the watermark and does not resend', () => {
  const p = pending();
  markShipped(p.to);
  assert.deepEqual(pending().lines, []);
  assert.equal(stats().behind, false);
});

ok('only new receipts ship after that', () => {
  add(4);
  const p = pending();
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0].n, 4);
  markShipped(p.to);
});

ok('a half-written tail is left for next time', () => {
  // Shipping a truncated receipt would fail verification on the far side.
  appendFileSync(FILE, '{"verdict":"allow","n":5,"hash":"h5"}');   // no newline
  assert.equal(pending().lines.length, 0, 'incomplete line must not ship');
  appendFileSync(FILE, '\n');
  assert.equal(pending().lines.length, 1);
});

ok('the watermark never moves backwards', () => {
  const p = pending();
  markShipped(p.to);
  assert.equal(markShipped(p.to - 10), false, 'a late slow batch must not un-ship newer work');
  assert.deepEqual(pending().lines, []);
});

ok('a truncated record restarts rather than reading a meaningless offset', () => {
  writeFileSync(FILE, '');
  add(9);
  const p = pending();
  assert.equal(p.from, 0);
  assert.equal(p.lines.length, 1, 're-shipping is harmless; the server dedupes on hash');
});

ok('a stale watermark does not lock the queue forever', () => {
  // pending() restarts when the record shrinks; markShipped has to accept the
  // smaller offset that follows, or every later batch is refused and the same
  // receipts ship on every pass forever.
  const p = pending();
  assert.ok(p.lines.length > 0);
  assert.equal(markShipped(p.to), true);
  assert.deepEqual(pending().lines, []);
});

ok('an unparseable line does not wedge the queue behind it', () => {
  appendFileSync(FILE, 'not json\n');
  add(10);
  const p = pending();
  assert.equal(p.lines.length, 1, 'the good line after a bad one must still ship');
  assert.equal(p.lines[0].n, 10);
  assert.ok(p.to > p.from, 'the bad line must be consumed, not left to block the queue');
  markShipped(p.to);
  assert.deepEqual(pending().lines, []);
});

ok('a failure is recorded without losing the watermark', () => {
  const before = stats();
  markFailure('connect ECONNREFUSED');
  const after = stats();
  assert.match(after.lastError.message, /ECONNREFUSED/);
  assert.equal(after.unshippedBytes, before.unshippedBytes);
});

ok('reading is bounded by the limit', () => {
  for (let i = 20; i < 40; i++) add(i);
  assert.equal(pending(5).lines.length, 5);
});

console.log(`\n  ${pass} passed`);
