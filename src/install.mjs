// Wires the PreToolUse hook into a Claude Code settings.json.
// Default target is the current project (./.claude/settings.json) so it never
// silently changes global behavior. Pass --global to target ~/.claude.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dir, 'hook.mjs');
const HOME = process.env.HOME || process.env.USERPROFILE || '.';

export function install(global = false) {
  const dir = global ? join(HOME, '.claude') : join(process.cwd(), '.claude');
  const file = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });

  let settings = {};
  if (existsSync(file)) { try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { console.error('Could not parse ' + file + '; aborting so nothing is lost.'); process.exit(1); } }

  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];

  const command = `node "${HOOK}"`;
  const already = JSON.stringify(settings.hooks.PreToolUse).includes('hook.mjs');
  if (already) { console.log('Enforcer hook already installed in ' + file); return file; }

  settings.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command }] });
  writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(`\n  Installed the Enforcer hook into ${file}`);
  console.log(`  Every tool call in ${global ? 'ALL projects' : 'this project'} now checks the governor first.`);
  return file;
}
