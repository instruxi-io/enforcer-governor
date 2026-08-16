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
