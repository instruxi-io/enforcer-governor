// The headless graph-worker policy, as governor rules.
//
// A graph worker is a `claude -p` session the dispatcher starts in a git
// worktree on branch graph/<key>. It has to push that branch, open a pull
// request from it and land it with land-pr.sh, and there is nobody to answer a
// permission prompt. Until 2.9 this policy lived in jev-hooks' bash gate, while
// two other PreToolUse hooks decided independently and a refusal was a
// sentence the dispatcher grepped. Here it is one set of rules with machine
// codes (codes.mjs), and the governor is the plugin that allows or denies it.
//
//   headless (no approval surface)      a person is present
//   ───────────────────────────────     ────────────────────────────────
//   push graph/<key>, alone   allow     ask   graph_push_confirm
//   gh pr create on graph/    allow     ask   graph_pr_confirm
//   land-pr.sh on graph/      allow     ask   graph_land_confirm
//   force-push                deny      (left to git.force_push: rewrite)
//   push to a default branch  deny      ask   push_default_branch
//   edit plugin/gov settings  deny      ask   governor_settings_edit
//
// Pure, like capability.mjs: the caller resolves the context first (whether
// the session is headless, which branch the worktree has checked out) and
// passes it on the event. Nothing here reads a file, the environment or git.
//
// ev.worker = { headless: boolean, branch: string|null }
//   branch: the checked-out branch of the directory the command runs in
//   (cwd, or `git -C <dir>`), null when it is not a git worktree.

import { Verdict, CAPABILITY } from './verdict.mjs';

export const WORKER_RULES = Object.freeze([
  { id: 'graph.push', name: 'push a graph/<key> branch' },
  { id: 'graph.pr_create', name: 'open a pull request from a graph/<key> branch' },
  { id: 'graph.land', name: 'land a graph/<key> pull request with land-pr.sh' },
  { id: 'git.push_default_branch', name: 'push to a default branch' },
  { id: 'git.force_push', name: 'force-push without a lease' },
  { id: 'governor.settings', name: 'edit plugin or governor settings' },
]);
const RULE = Object.fromEntries(WORKER_RULES.map(r => [r.id, r]));

export const DEFAULT_BRANCHES = Object.freeze(['main', 'master', 'develop', 'trunk']);
const GRAPH = /^graph\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const isGraph = (b) => typeof b === 'string' && GRAPH.test(b);

// Plugin and governor settings: Claude Code's settings files, installed plugin
// code (its hooks are part of the gate), and the governor's own home.
export const SETTINGS = /(^|[\s"'=\/])(\.claude\/settings(\.local)?\.json|\.claude\/plugins\/|managed-settings\.json|\.enforcer-governor\/)/;
// A shell command that changes a file, as opposed to reading it.
const MUTATES = /(^|[^0-9&<])>{1,2}(?!&)|\btee\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\b(cp|mv|rm|ln|chmod|chown|truncate|install|unlink)\s|\bjq\b[^|]*>|\bwriteFile|\bperl\s+-[a-zA-Z]*i/;

// The skill's own land-pr.sh invocation finds the script with a substitution;
// it is one command, so it is folded to its name before the shape is checked.
const LAND_LOOKUP = /^"?\$\(\s*ls\s+-d\s+[^()|;&]*\/land-pr\.sh\s*\|\s*tail\s+-1\s*\)"?/;
const META = /[;&|`\n<>]|\$\(/;

const verdict = (action, ruleId, code, reason) => {
  const of = { source: CAPABILITY, rule: RULE[ruleId].name, ruleId, checked: [CAPABILITY], code };
  return action === 'allow' ? Verdict.allow(reason, of)
    : action === 'deny' ? Verdict.deny(reason, of) : Verdict.ask(reason, of);
};

function commandOf(ev) {
  if (typeof ev.input?.command === 'string') return ev.input.command;
  if (typeof ev.raw?.command === 'string') return ev.raw.command;
  const a = String(ev.action || '');
  return a.replace(/^Bash:/, '').split('\n')[0];
}
const isShell = (ev) => ev.tool === 'shell' || ev.tool === 'Bash' || ev.name === 'Bash';
const isFileWrite = (ev) => ['edit', 'write', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(ev.tool) ||
  ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(ev.name);

/** Split a command into words; quotes group, nothing is expanded. */
export function words(cmd) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `git [-C dir] push ...`: the push's own words, or null when it is not one. */
export function pushArgs(cmd) {
  const w = words(cmd.trim());
  let i = 0;
  if (w[i] !== 'git') return null;
  i++;
  if (w[i] === '-C') i += 2;
  if (w[i] !== 'push') return null;
  return w.slice(i + 1);
}
export function gitDir(cmd) {
  const w = words(cmd.trim());
  return w[0] === 'git' && w[1] === '-C' ? w[2] : null;
}

const mentionsDelivery = (cmd) => /\bgit\s+(-C\s+\S+\s+)?push\b|\bgh\s+pr\s+create\b|land-pr\.sh/.test(cmd);

function push(args, ctx) {
  const { headless, branch } = ctx;
  let force = false, other = false;
  const pos = [];
  for (const a of args) {
    if (a === '-u' || a === '--set-upstream') continue;
    if (a === '--force-with-lease' || a.startsWith('--force-with-lease=')) continue;   // the skill's rebase path
    if (a === '-f' || a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) && !a.startsWith('--')) { force = true; continue; }
    if (a.startsWith('-')) { other = true; continue; }
    if (a.startsWith('+')) force = true;
    pos.push(a.replace(/^\+/, ''));
  }
  const [, refspec, ...extra] = pos;
  const src = refspec?.includes(':') ? refspec.split(':')[0] : refspec;
  const dst = (refspec?.includes(':') ? refspec.split(':')[1] : refspec)?.replace(/^refs\/heads\//, '');
  const toDefault = dst && DEFAULT_BRANCHES.includes(dst);

  if (force && headless) return verdict('deny', 'git.force_push', 'force_push', 'a headless worker may not force-push');
  if (force) return null;                         // git.force_push rewrites it to --force-with-lease
  if (toDefault) return headless
    ? verdict('deny', 'git.push_default_branch', 'push_default_branch', `a headless worker may not push to ${dst}`)
    : verdict('ask', 'git.push_default_branch', 'push_default_branch', `this pushes straight to ${dst}`);
  if (!isGraph(dst)) return headless
    ? verdict('deny', 'graph.push', 'push_needs_approval_surface',
      'only `git push -u origin graph/<key>` may run with nobody to ask')
    : null;
  if (!headless) return verdict('ask', 'graph.push', 'graph_push_confirm', `this pushes ${dst}`);
  if (other || extra.length) return verdict('deny', 'graph.push', 'push_needs_approval_surface',
    'only `git push -u origin graph/<key>` may run with nobody to ask');
  if (!isGraph(branch)) return verdict('deny', 'graph.push', 'outside_worktree',
    'the working directory is not a worktree on a graph/<key> branch');
  if (dst !== branch || (src && src !== 'HEAD' && src !== branch)) return verdict('deny', 'graph.push', 'branch_mismatch',
    `the worktree has ${branch} checked out, not ${dst}`);
  return verdict('allow', 'graph.push', 'graph_push_allowed', `headless worker pushing its own branch ${branch}`);
}

function prCreate(args, ctx) {
  const { headless, branch } = ctx;
  const h = args.indexOf('--head') >= 0 ? args[args.indexOf('--head') + 1] : (args.find(a => a.startsWith('--head='))?.slice(7));
  const head = h || branch;
  if (!isGraph(branch) && !isGraph(h)) return headless
    ? verdict('deny', 'graph.pr_create', 'outside_worktree', 'the working directory is not a worktree on a graph/<key> branch')
    : null;
  if (!headless) return verdict('ask', 'graph.pr_create', 'graph_pr_confirm', `this opens a pull request from ${head}`);
  if (!isGraph(branch)) return verdict('deny', 'graph.pr_create', 'outside_worktree',
    'the working directory is not a worktree on a graph/<key> branch');
  if (head !== branch) return verdict('deny', 'graph.pr_create', 'branch_mismatch', `the worktree has ${branch} checked out, not ${head}`);
  return verdict('allow', 'graph.pr_create', 'graph_pr_allowed', `headless worker opening a pull request from ${branch}`);
}

function land(ctx) {
  const { headless, branch } = ctx;
  if (!isGraph(branch)) return headless
    ? verdict('deny', 'graph.land', 'outside_worktree', 'land-pr.sh runs from a worktree on a graph/<key> branch')
    : null;
  if (!headless) return verdict('ask', 'graph.land', 'graph_land_confirm', `this merges the pull request from ${branch} when it is green`);
  return verdict('allow', 'graph.land', 'graph_land_allowed', `headless worker landing ${branch}`);
}

function settings(ev, ctx, cmd) {
  const path = isFileWrite(ev) ? String(ev.input?.path ?? ev.raw?.file_path ?? ev.raw?.notebook_path ?? '') : null;
  const hit = path != null ? SETTINGS.test(path) : (SETTINGS.test(cmd) && MUTATES.test(cmd));
  if (!hit) return null;
  return ctx.headless
    ? verdict('deny', 'governor.settings', 'governor_settings_edit', 'a headless worker may not change plugin or governor settings')
    : verdict('ask', 'governor.settings', 'governor_settings_edit', 'this changes plugin or governor settings');
}

/**
 * Evaluate the graph-worker rules.
 * @returns {Verdict|null} null: none of these rules has an opinion, and the
 *   capability rules and spend checks decide as they always did.
 */
export function evaluate(ev) {
  const ctx = { headless: !!ev.worker?.headless, branch: ev.worker?.branch ?? null };
  if (isFileWrite(ev)) return settings(ev, ctx, '');
  if (!isShell(ev)) return null;
  const raw = commandOf(ev).trim();
  const s = settings(ev, ctx, raw);
  if (s) return s;

  const cmd = raw.replace(LAND_LOOKUP, 'land-pr.sh').replace(/\s+2>&1\s*$/, '').trim();
  if (!mentionsDelivery(cmd)) return null;
  if (META.test(cmd)) return ctx.headless
    ? verdict('deny', 'graph.push', 'push_not_alone', 'a push, pull request or land must be the whole command, on its own')
    : null;

  const w = words(cmd);
  const args = pushArgs(cmd);
  if (args) return push(args, ctx);
  if (w[0] === 'gh' && w[1] === 'pr' && w[2] === 'create') return prCreate(w.slice(3), ctx);
  if (/(^|\/)land-pr\.sh$/.test(w[0] || '') || (w[0] === 'bash' && /(^|\/)land-pr\.sh$/.test(w[1] || ''))) return land(ctx);
  return null;
}

/**
 * Whether the session has nobody to answer a prompt. The dispatcher marks its
 * workers with JEV_HOOKS_HEADLESS=1 (or ENFORCER_HEADLESS=1); `claude -p`
 * reports the sdk-cli entrypoint. Takes the environment as an argument so the core
 * stays free of process state.
 */
export function headlessFrom(env = {}) {
  return env.ENFORCER_HEADLESS === '1' || env.JEV_HOOKS_HEADLESS === '1' ||
    String(env.CLAUDE_CODE_ENTRYPOINT || '') === 'sdk-cli';
}
