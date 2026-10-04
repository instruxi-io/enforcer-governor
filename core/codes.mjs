// Every decision the governor makes, as a machine code.
//
// Until 2.9 a refusal was a sentence, and the parent process that had to act
// on it (the graph dispatcher salvaging a denied push, a CI wrapper) grepped
// the sentence: 'DENIED: Bash'. A sentence is for the person reading it; a
// program needs a value that does not change when the wording does. This file
// is that value's ONE definition: the enum, what each code means, and the
// record every decision is written as.
//
// Codes are a published vocabulary, like rule ids: renaming one silently breaks
// every parent that branches on it. Add codes; never rename or reuse one.
//
// Pure: no file, no network, no state. Like capability.mjs it must import
// nothing that does I/O.

export const CODES = Object.freeze({
  // ── capability rules (capability.mjs DEFAULT_RULES) ──────────────────────
  pipe_to_shell: 'a script piped from curl/wget into a shell',
  force_push: 'a force-push (--force, -f or a +refspec)',
  destructive_delete: 'rm -rf of a whole tree',
  destructive_git: 'history rewrite: reset --hard or filter-branch',
  secret_in_command: 'the action reads or writes credentials (.env, keys, credentials.json, ~/.aws, ~/.ssh)',
  deploy_publish: 'publish or deploy (npm publish, vercel --prod, kubectl apply/delete, terraform apply)',
  custom_rule: 'a rule from config.json with no code of its own',

  // ── headless graph-worker rules (worker.mjs) ─────────────────────────────
  graph_push_allowed: 'headless worker pushing its own graph/<key> branch, as the whole command',
  graph_pr_allowed: 'headless worker opening a pull request from its graph/<key> branch',
  graph_land_allowed: 'headless worker landing its graph/<key> pull request with land-pr.sh',
  graph_push_confirm: 'graph/<key> push from a session with a person present: they confirm',
  graph_pr_confirm: 'pull request from a graph/<key> branch in a session with a person present',
  graph_land_confirm: 'land-pr.sh in a session with a person present',
  push_not_alone: 'a push, pull request or land chained with other commands; it must run on its own',
  push_default_branch: 'a push to a default branch (main, master, develop, trunk)',
  push_needs_approval_surface: 'a push or pull request no rule allows, in a session with nobody to ask',
  branch_mismatch: 'pushing a branch other than the one the worktree has checked out',
  outside_worktree: 'the working directory is not a git worktree on a graph/<key> branch',
  governor_settings_edit: 'an edit to plugin or governor settings',

  // ── tenant policy (central.mjs, composed in gate.mjs) ────────────────────
  tenant_policy: "the organisation's Enforcer policy decided",

  // ── spend and behaviour (economics.mjs) ──────────────────────────────────
  agent_stopped: 'the agent was stopped by a person or for looping, and stays stopped until resumed',
  period_limit: 'the daily, weekly or monthly spend limit is reached',
  loop_detected: 'the agent repeated the same action past the loop limit',
  burn_rate: 'spending faster than the per-minute mark',
  fanout_rate: 'starting subagents faster than the fan-out mark',
  retry_storm: 'failing and retrying faster than the retry mark',
  client_limit: "a client's spend limit is reached",
  spend_limit: "the agent's spend limit is reached",
  spend_warning: "the agent passed the warn-me mark of its spend limit",

  // ── no objection ─────────────────────────────────────────────────────────
  no_rule_matched: 'no rule objected and spend is within limits',
  spend_unchecked: 'no rule objected; the governor could not read its state, so spend was not checked',
  checks_off: 'no rule objected; spend and loop checks are switched off',
});

export const DECISIONS = Object.freeze(['allow', 'deny', 'ask']);

// A rule's code, from its policy id. A custom rule may name its own `code`, as
// long as it is in the enum; anything else is `custom_rule`.
const RULE_CODES = Object.freeze({
  'shell.pipe_to_shell': 'pipe_to_shell',
  'git.force_push': 'force_push',
  'fs.delete_tree': 'destructive_delete',
  'git.rewrite_history': 'destructive_git',
  'secrets.access': 'secret_in_command',
  'deploy.publish': 'deploy_publish',
});

export function isCode(c) { return Object.prototype.hasOwnProperty.call(CODES, c); }

export function ruleCode(rule) {
  if (rule && isCode(rule.code)) return rule.code;
  return RULE_CODES[rule?.id] || 'custom_rule';
}

/** The code a verdict carries, falling back by what decided it. */
export function codeOf(v) {
  if (v.code && isCode(v.code)) return v.code;
  if (v.source === 'policy') return 'tenant_policy';
  if (v.action === 'allow') {
    if (!v.checked?.includes('economics')) return 'spend_unchecked';
    return 'no_rule_matched';
  }
  return v.source === 'capability' ? 'custom_rule' : 'spend_limit';
}

/**
 * The decision record: what a parent process parses. The hook's permission
 * vocabulary has three answers, so a rewrite (which the hook puts to the
 * person as an ask, carrying the safer command) is recorded as `ask`.
 * Field order is fixed; `run_id` is present only when the session holds a run.
 */
export function decisionRecord(v, { tool = '', run_id } = {}) {
  const decision = v.action === 'rewrite' ? 'ask' : v.action;
  const rec = { decision, code: codeOf(v), rule: v.ruleId || v.rule || null, tool: String(tool || ''), summary: String(v.reason || '') };
  if (run_id) rec.run_id = String(run_id);
  return rec;
}

/** One line a parent greps for: the prefix, then the record as JSON. */
export const DECISION_PREFIX = 'enforcer-governor:decision ';
export const decisionLine = (rec) => DECISION_PREFIX + JSON.stringify(rec);
