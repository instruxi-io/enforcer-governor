// The sweep. What it must delete, and — the part that matters — what it must not.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweep } from '../src/sweep.mjs';

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };

const DAY = 24 * 3600 * 1000;
const home = () => mkdtempSync(join(tmpdir(), 'gov-sweep-'));
const write = (dir, name, ageDays = 0) => {
  const p = join(dir, name);
  writeFileSync(p, '{}');
  if (ageDays) { const t = (Date.now() - ageDays * DAY) / 1000; utimesSync(p, t, t); }
  return p;
};

ok('old scratch files go, recent ones stay', () => {
  const dir = home();
  write(dir, 'cost-old.json', 30);
  write(dir, 'cursor-old.json', 8);
  write(dir, 'cost-live.json', 0);
  write(dir, 'cursor-live.json', 3);
  const r = sweep({ sweepDays: 7 }, { dir });
  assert.equal(r.removed, 2);
  assert.deepEqual(readdirSync(dir).sort(), ['cost-live.json', 'cursor-live.json']);
});

ok('the record and the durable state are never swept', () => {
  // The whole safety argument is the filename pattern, so it is the thing to
  // pin: a sweep that could reach receipts.jsonl or state.json is data loss,
  // and nothing else in this directory has a session id in its name.
  const dir = home();
  for (const n of ['receipts.jsonl', 'state.json', 'config.json', 'credentials.json',
                   'outbox.json', 'install.json', 'policy-cache.json', 'token', '.lock']) write(dir, n, 400);
  const r = sweep({ sweepDays: 1 }, { dir });
  assert.equal(r.removed, 0);
  assert.equal(readdirSync(dir).length, 9);
});

ok('0 keeps everything, for an audit that wants the working files', () => {
  const dir = home();
  write(dir, 'cost-ancient.json', 999);
  assert.equal(sweep({ sweepDays: 0 }, { dir }).removed, 0);
  assert.equal(sweep({ sweepDays: 'nonsense' }, { dir }).removed, 0);
  assert.equal(readdirSync(dir).length, 1);
});

ok('a missing directory is not an error', () => {
  assert.deepEqual(sweep({ sweepDays: 7 }, { dir: join(tmpdir(), 'gov-sweep-does-not-exist') }),
    { removed: 0, bytes: 0, skipped: 0 });
});

console.log(`\n  ${pass} passed`);
