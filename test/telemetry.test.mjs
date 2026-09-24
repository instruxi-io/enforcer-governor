// Usage counts: off by default, never on CI, exactly the fields promised, at most once a day.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'DO_NOT_TRACK', 'GVNR_TELEMETRY']) delete process.env[k];
const got = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push(JSON.parse(b)); res.statusCode = 204; res.end(); }); });
await new Promise(r => srv.listen(0, r));
process.env.GVNR_DATA_DIR = mkdtempSync(join(tmpdir(), 'gvnr-t-'));
process.env.GVNR_TELEMETRY_URL = `http://127.0.0.1:${srv.address().port}/api/t`;
const t = await import('../src/telemetry.mjs');

assert.equal(t.blocked({ CI: 'true' }) !== '', true, 'CI never sends');
assert.equal(t.blocked({ GITHUB_ACTIONS: 'true' }) !== '', true);
assert.equal(t.blocked({ DO_NOT_TRACK: '1' }) !== '', true, 'DO_NOT_TRACK is honoured');
assert.equal(t.blocked({}), '');

t.init();
assert.equal(t.status().on, false, 'off by default');
assert.equal(t.status().asked, false);
assert.equal(await t.tick(), false, 'nothing is sent while off');
assert.equal(got.length, 0);

t.set(true);
assert.equal(await t.tick(new Date('2026-09-24T09:00:00Z')), true);
assert.equal(await t.tick(new Date('2026-09-24T10:00:00Z')), false, 'once a day');
t.noteDecision();
assert.equal(await t.tick(new Date('2026-09-24T11:00:00Z')), true, 'one more once it has checked an action');
assert.equal(await t.tick(new Date('2026-09-24T12:00:00Z')), false);
assert.equal(await t.tick(new Date('2026-09-25T09:00:00Z')), true, 'next day');
assert.deepEqual(Object.keys(got[0]).sort(), ['id', 'k', 'on', 'os', 'v'], 'exactly the promised fields');
assert.deepEqual([got[0].on, got[1].on], [0, 1]);
assert.match(got[0].id, /^[a-f0-9]{32}$/);

const r = await t.survey('very', 'x'.repeat(500));
assert.equal(r.sent, true);
assert.equal(got.at(-1).b.length, 280, 'benefit text is capped');
assert.equal((await t.survey('maybe')).ok, false);

t.set(false);
assert.equal(await t.tick(new Date('2026-09-26T09:00:00Z')), false, 'switching off stops it');
srv.close();
console.log('telemetry ok');
