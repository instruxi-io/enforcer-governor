// Works out what the user actually has, so the tool gives one tailored next
// step instead of a menu. The decision "which of these five am I?" is the real
// friction, not the install.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

// Is the Claude Code hook already wired, here or globally?
function hookState() {
  for (const [scope, file] of [
    ['project', join(process.cwd(), '.claude', 'settings.json')],
    ['global', join(HOME, '.claude', 'settings.json')],
  ]) {
    if (!existsSync(file)) continue;
    try {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      const hooks = JSON.stringify(s?.hooks?.PreToolUse ?? '');
      if (hooks.includes('enforcer-governor')) return { wired: true, scope };
    } catch { /* unreadable settings are not our problem to fix here */ }
  }
  return { wired: false };
}

export function detect() {
  const claudeHere = existsSync(join(process.cwd(), '.claude'));
  const claudeUser = existsSync(join(HOME, '.claude'));
  const cursorHere = existsSync(join(process.cwd(), '.cursor'));
  const cursorApp = process.platform === 'darwin'
    && existsSync('/Applications/Cursor.app');
  return {
    claudeCode: claudeHere || claudeUser,
    claudeCodeInProject: claudeHere,
    cursor: cursorHere || cursorApp,
    hook: hookState(),
  };
}

// One tailored instruction. Returns lines to print, most relevant first.
export function nextStep(url) {
  const d = detect();
  const out = [];

  if (d.hook.wired) {
    out.push(`  Claude Code is already wired (${d.hook.scope}). Start a new session and it is governed.`);
    return { lines: out, d };
  }

  if (d.claudeCode) {
    out.push(`  Claude Code detected. To govern it:`);
    out.push(`      npx --yes enforcer-governor install-hook`);
    out.push(d.claudeCodeInProject
      ? `      run it here, then start a NEW Claude Code session`
      : `      run it inside your project, then start a NEW Claude Code session`);
    if (d.cursor) out.push(`  Cursor detected too: set its base URL to ${url}/v1`);
    return { lines: out, d };
  }

  if (d.cursor) {
    out.push(`  Cursor detected. Settings > Models > override the base URL:`);
    out.push(`      ${url}/v1`);
    return { lines: out, d };
  }

  out.push(`  Point any agent at this address to govern it:`);
  out.push(`      OPENAI_BASE_URL=${url}/v1     (or ANTHROPIC_BASE_URL=${url})`);
  return { lines: out, d };
}
