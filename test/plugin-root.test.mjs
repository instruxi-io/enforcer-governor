// ~/.enforcer/plugin-root is how the status line and the telemetry headers
// shim find the installed plugin across version upgrades. It is computed from
// the file's own location, so moving telemetry.mjs (src/ -> adapters/claude-code/)
// silently pointed it one directory too shallow until the '..' count followed.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gov-root-'));
process.env.ENFORCER_HOME = home;
const { recordPluginRoot } = await import('../adapters/claude-code/telemetry.mjs');
recordPluginRoot();
const root = readFileSync(join(home, 'plugin-root'), 'utf8').trim();
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
if (!existsSync(join(root, '.claude-plugin', 'plugin.json'))) fail(`plugin-root ${root} is not the plugin root (no .claude-plugin/plugin.json)`);
if (!existsSync(join(root, 'statusline', 'spend.mjs'))) fail(`plugin-root ${root} has no statusline/spend.mjs, which the status line command runs`);
console.log('plugin-root names the plugin root, where the status line lives ok');
