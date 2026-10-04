// The context the graph-worker rules (core/worker.mjs) need and must not fetch
// themselves: is anyone there to answer a prompt, and which branch does the
// directory the command runs in have checked out. Read from the environment
// and the .git files directly — no git process on every tool call.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { headlessFrom, gitDir } from '../../core/worker.mjs';

/** The checked-out branch of `dir`, or null (not a worktree, detached HEAD). */
export function branchOf(dir) {
  if (!dir) return null;
  let d = resolve(dir);
  for (let i = 0; i < 64; i++) {
    const dotgit = join(d, '.git');
    try {
      const st = statSync(dotgit);
      let gd = dotgit;
      if (st.isFile()) {   // a linked worktree: ".git" names its gitdir
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
        if (!m) return null;
        gd = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(d, m[1].trim());
      }
      const head = readFileSync(join(gd, 'HEAD'), 'utf8').trim();
      const r = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return r ? r[1] : null;
    } catch {}
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** ev.worker for the core: headless, and the branch the command acts on. */
export function workerContext(ev, env = process.env) {
  const cmd = typeof ev?.tool_input?.command === 'string' ? ev.tool_input.command : '';
  const at = gitDir(cmd);
  const dir = at ? resolve(ev.cwd || '.', at) : ev.cwd;
  return { headless: headlessFrom(env), branch: branchOf(dir) };
}

/**
 * The enforcer-graph run this session holds, when it holds one: the env var a
 * dispatcher may set, else the run file enforcer-graph's hooks keep per actor.
 */
export function runIdOf(ev, env = process.env) {
  if (env.ENFORCER_GRAPH_RUN_ID) return env.ENFORCER_GRAPH_RUN_ID;
  const key = ev?.agent_id ? null : ev?.session_id;   // subagents key by a hash; not resolved here
  if (!key) return undefined;
  const dirs = [join(homedir(), '.claude', 'enforcer-graph', 'runs')];
  try {
    const data = join(homedir(), '.claude', 'plugins', 'data');
    for (const n of readdirSync(data)) if (n.startsWith('enforcer-graph')) dirs.push(join(data, n, 'runs'));
  } catch {}
  for (const d of dirs) {
    try { const r = JSON.parse(readFileSync(join(d, `${key}.json`), 'utf8')); if (r?.run_id) return String(r.run_id); } catch {}
  }
  return undefined;
}
