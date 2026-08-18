#!/usr/bin/env node
// Everything the slash commands print. Plain text on stdout -- these are read
// by a person mid-session, so money first and jargon never.
import { loadState, loadConfig, saveConfig, verify, RECEIPTS } from './store.mjs';
import { DEFAULTS, priceOf, dollarsForTokens, burnRate } from './policy.mjs';

const [, , cmd, arg] = process.argv;
const cfg = { ...DEFAULTS, ...loadConfig() };
const state = loadState();
const usd = (t, m) => '$' + dollarsForTokens(t, priceOf(m, cfg.model).in).toFixed(2);

if (cmd === 'verify') {
  const v = verify();
  if (!v.receipts) console.log('No decisions recorded yet.');
  else if (v.ok) console.log(`All ${v.receipts} records check out.${v.unverifiable ? ` (${v.unverifiable} written before hashes were stored, reported as unverifiable.)` : ''}`);
  else console.log(`The record does NOT check out. Line ${v.brokeAt} of ${v.receipts} does not match the one before it.\nFile: ${RECEIPTS}`);
  process.exit(0);
}

if (cmd === 'limit') {
  const d = Number(arg);
  if (!Number.isFinite(d) || d <= 0) { console.log('Give a dollar amount, e.g. /governor:limit 40'); process.exit(0); }
  saveConfig({ ...loadConfig(), dollars: d });
  console.log(`Spend limit is now $${d} per agent, at ${priceOf(cfg.model).label} rates. Agents already running pick this up on their next action.`);
  process.exit(0);
}

const agents = Object.values(state.agents || {});
if (!agents.length) { console.log('No agents seen yet.'); process.exit(0); }

console.log(`Limit: $${cfg.dollars} per agent  ·  warns at ${Math.round(cfg.soft * 100)}%  ·  $${cfg.burnLimit}/min per agent, $${cfg.fleetBurnLimit}/min across all`);
console.log('');
for (const a of agents.sort((x, y) => (y.tokens || 0) - (x.tokens || 0)).slice(0, 12)) {
  const pct = a.budget ? Math.round((a.tokens / a.budget) * 100) : 0;
  const flag = a.status === 'grounded' ? '  STOPPED' : a.escalated ? '  WAITING ON YOU' : '';
  console.log(`  ${a.id.padEnd(18)} ${usd(a.tokens || 0, a.model).padStart(8)}  ${String(pct).padStart(3)}%${a.client ? '  ' + a.client : ''}${flag}`);
}
const burn = burnRate(state);
if (burn > 0) console.log(`\nRight now: $${burn.toFixed(2)}/min across every agent.`);
const v = verify();
console.log(`\nRecord: ${v.receipts} decisions, ${v.ok ? 'all check out' : `BROKEN at line ${v.brokeAt}`}.`);
