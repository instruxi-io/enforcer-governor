#!/usr/bin/env node
// Ambient spend, always in the chrome. This is the one piece of this plugin a
// developer benefits from rather than tolerates: the governor stops being a
// dashboard you have to open and becomes a number you glance at.
import { readFileSync } from 'node:fs';
import { loadState, loadConfig } from '../src/store.mjs';
import { DEFAULTS, priceOf, dollarsForTokens } from '../src/policy.mjs';

let ev = {}; try { ev = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {}
const cfg = { ...DEFAULTS, ...loadConfig() };
const id = ev.session_id ? 'claude:' + String(ev.session_id).slice(0, 8) : 'claude-code';
const a = (loadState().agents || {})[id];
if (!a) process.exit(0);

const spent = dollarsForTokens(a.tokens || 0, priceOf(a.model, cfg.model).in);
const cap = a.budget ? dollarsForTokens(a.budget, priceOf(a.model, cfg.model).in) : 0;
const pct = cap ? spent / cap : 0;
// Only the last state earns a colour. A status line that is always shouting
// stops being read, and the point of this one is the moment it changes.
const mark = a.status === 'grounded' ? '\x1b[31m■\x1b[0m'
           : a.escalated             ? '\x1b[33m■\x1b[0m'
           : pct >= cfg.soft         ? '\x1b[33m·\x1b[0m'
           : '\x1b[2m·\x1b[0m';
process.stdout.write(cap
  ? `${mark} $${spent.toFixed(2)}/$${cap.toFixed(0)}`
  : `${mark} $${spent.toFixed(2)}`);
