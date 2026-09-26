#!/usr/bin/env node
// Ship pending receipts to the control plane and exit.
//
// Started detached by the hooks (core/ship.mjs kick, named as the Claude Code
// adapter's shipper in adapters/claude-code/index.mjs), and runnable by hand:
//   node bin/ship.mjs          ship what is pending, print one line
import { readFileSync } from 'node:fs';
import { shipAll } from '../src/ship.mjs';
import { loadConfig } from '../src/store.mjs';
import { DEFAULTS } from '../src/policy.mjs';

let version = '';
try { version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch {}

const res = await shipAll({ ...DEFAULTS, ...loadConfig(), version });
if (process.stdout.isTTY || process.argv.includes('--print')) {
  if (res.skipped) console.log(`Not shipped: ${res.skipped}.`);
  else if (res.error) console.log(`Not shipped: ${res.error}. Receipts stay queued and ship on the next try.`);
  else console.log(`Shipped ${res.shipped} receipt(s)${res.rejected ? `; ${res.rejected} refused as altered or malformed` : ''}${res.pending ? '; more pending' : ''}.`);
}
