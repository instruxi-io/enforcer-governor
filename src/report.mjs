#!/usr/bin/env node
// Everything the slash commands print. Plain text on stdout -- these are read
// by a person mid-session, so money first and jargon never.
import { loadState, loadConfig, saveConfig, saveState, verify, withLock, writeReceipt, RECEIPTS } from './store.mjs';
import { DEFAULTS, priceOf, dollarsForTokens, burnRate, release } from './policy.mjs';

const [, , cmd, arg] = process.argv;
const cfg = { ...DEFAULTS, ...loadConfig() };
const state = loadState();
const usd = (t, m) => '$' + dollarsForTokens(t, priceOf(m, cfg.model).in).toFixed(2);

if (cmd === 'verify') {
  const v = verify();
  if (!v.receipts) console.log('No decisions recorded yet.');
  else if (v.ok) console.log(`All ${v.receipts} records check out.${v.unverifiable ? ` (${v.unverifiable} carry no hash and could not be chain-checked: either written before hashes were stored, or decided while the governor could not read its own chain.)` : ''}`);
  else console.log(`The record does NOT check out. Line ${v.brokeAt} of ${v.receipts} does not match the one before it.\nFile: ${RECEIPTS}`);
  process.exit(0);
}

if (cmd === 'limit') {
  const d = Number(arg);
  if (!Number.isFinite(d) || d <= 0) { console.log('Give a dollar amount, e.g. /enforcer-governor:limit 40'); process.exit(0); }
  saveConfig({ ...loadConfig(), dollars: d });
  console.log(`Spend limit is now $${d} per agent, at ${priceOf(cfg.model).label} rates. Agents already running pick this up on their next action.`);
  process.exit(0);
}

// The way out of being stopped. release() has existed since v1 and nothing ever
// called it, so "resume it" was advice with no command behind it. Held under the
// lock because it mutates state and appends a receipt: a human overriding the
// governor is exactly the kind of decision the record has to carry.
if (cmd === 'resume') {
  const held = withLock(() => {
    const s = loadState();
    const stopped = Object.entries(s.agents || {}).filter(([, a]) => a.status === 'grounded');
    if (!stopped.length) return { msg: 'No agent is stopped. Nothing to resume.' };

    let ids = arg ? [arg, 'claude:' + arg].filter(id => s.agents[id]) : stopped.map(([id]) => id);
    if (arg && !ids.length) return { msg: `No agent called ${arg}. Stopped right now: ${stopped.map(([id]) => id).join(', ')}` };
    // With no argument and several stopped, name them rather than guess: resuming
    // the wrong agent spends real money on work nobody asked to continue.
    if (!arg && ids.length > 1) {
      return { msg: `${ids.length} agents are stopped. Name one:\n` + ids.map(id => `  /enforcer-governor:resume ${id.replace(/^claude:/, '')}`).join('\n') };
    }
    const id = ids[0];
    const out = release(s, id);
    writeReceipt(out.entry, out.hash);
    saveState(s);
    const a = s.agents[id];
    return { msg: `${id} is running again, with its limit raised to ${usd(a.budget, a.model)}. Recorded as your decision.` };
  });
  console.log(held.ok && held.value ? held.value.msg
    : 'Could not take the lock on the governor state, so nothing was changed. Try again.');
  process.exit(0);
}

const agents = Object.values(state.agents || {});
if (!agents.length) { console.log('No agents seen yet.'); process.exit(0); }

console.log(`Limit: $${cfg.dollars} per agent  ·  warns at ${Math.round(cfg.soft * 100)}%  ·  $${cfg.burnLimit}/min per agent, $${cfg.fleetBurnLimit}/min across all`);
console.log('');
for (const a of agents.sort((x, y) => (y.tokens || 0) - (x.tokens || 0)).slice(0, 12)) {
  const pct = a.budget ? Math.round((a.tokens / a.budget) * 100) : 0;
  // Say WHY it stopped, not just that it did. "STOPPED" alone sends people to
  // the state file; the reason tells them whether to raise a limit or resume.
  const why = { limit: 'over its limit', soft: 'past the warn mark', loop: 'looping',
                client: 'client cap', day: 'daily cap', week: 'weekly cap', month: 'monthly cap',
                human: 'you stopped it' }[a.groundedBy] || '';
  const flag = a.status === 'grounded' ? `  STOPPED${why ? ' - ' + why : ''}`
             : a.escalated ? '  WAITING ON YOU' : '';
  console.log(`  ${a.id.padEnd(18)} ${usd(a.tokens || 0, a.model).padStart(8)}  ${String(pct).padStart(3)}%${a.client ? '  ' + a.client : ''}${flag}`);
}
if (agents.some(a => a.status === 'grounded')) {
  console.log('\nStopped agents run again with /enforcer-governor:resume. Raising the limit');
  console.log('with /enforcer-governor:limit also frees any agent stopped for spending.');
}
const burn = burnRate(state);
if (burn > 0) console.log(`\nRight now: $${burn.toFixed(2)}/min across every agent.`);
const v = verify();
console.log(`\nRecord: ${v.receipts} decisions, ${v.ok ? 'all check out' : `BROKEN at line ${v.brokeAt}`}.`);
