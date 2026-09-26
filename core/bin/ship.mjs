#!/usr/bin/env node
// Ship pending receipts to the control plane and exit: the core's own
// shipper, for a harness that has no entry point of its own.
//
// kick() (../ship.mjs) starts a shipper as a detached process so that no tool
// call ever waits on the network. It used to start the PLUGIN's bin/ship.mjs,
// found by walking out of core/ -- which is a file the published package does
// not have, so every adapter but Claude Code's would have kicked a script that
// is not there, silently, and never shipped a receipt. An adapter that has its
// own shipper names it to createGovernor({ shipper }); the Claude Code adapter
// does, and keeps the plugin's (which also reports the plugin version).
//
//   node core/bin/ship.mjs [--version <v>] [--print]
import { shipAll } from '../ship.mjs';
import { loadConfig } from '../store.mjs';
import { DEFAULTS } from '../policy.mjs';

const at = process.argv.indexOf('--version');
const version = at > 0 ? String(process.argv[at + 1] || '') : '';

const res = await shipAll({ ...DEFAULTS, ...loadConfig(), version });
if (process.stdout.isTTY || process.argv.includes('--print')) {
  if (res.skipped) console.log(`Not shipped: ${res.skipped}.`);
  else if (res.error) console.log(`Not shipped: ${res.error}. Receipts stay queued and ship on the next try.`);
  else console.log(`Shipped ${res.shipped} receipt(s)${res.rejected ? `; ${res.rejected} refused as altered or malformed` : ''}${res.pending ? '; more pending' : ''}.`);
}
