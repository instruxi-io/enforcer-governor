// Claude Code PreToolUse hook. Claude Code pipes a JSON event on stdin before
// every tool call; this reads it, totals the session's token usage from the
// transcript, asks the governor, and answers allow / deny / ask.
//
// Contract that actually works (learned the hard way): exit 0 and print JSON.
// Never exit 2 with JSON  -  that combination is ignored by Claude Code.
import { readFileSync } from 'node:fs';
import { priceOf } from './policy.mjs';

const PORT = process.env.GOVERNOR_PORT || 4000;

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// One pass over the session transcript for the three things we need.
//
// tokens: cost-weighted effective tokens. Raw sums mislead, because every turn
// re-reads the whole cached context, so cache reads dominate any long session
// at ~10% of the price of fresh input. Weights are price-proportional
// (input=1): output 5x, cache-create 1.25x, cache-read 0.1x.
//
// model + task: Claude Code hands the hook neither the model answering nor the
// prompt the human typed, but it writes both into the transcript -- the model
// on every assistant entry, the prompt as a `last-prompt` entry.
function readTranscript(path) {
  const out = { tokens: 0, model: '', task: '' };
  if (!path) return out;
  let usd = 0;
  const counted = new Set();
  try {
    // ponytail: re-reads the whole transcript on every tool call, so cost is
    // O(session length) -- ~180ms on a 54MB transcript, and growing. The read
    // dominates, not the parsing. Upgrade path when it starts to bite: cache
    // {byteOffset, total, countedIds} under ~/.enforcer-governor and read only
    // the tail appended since last time.
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const hasUsage = line.includes('"usage"');
      if (!hasUsage && !line.includes('"last-prompt"')) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m?.type === 'last-prompt' && m.lastPrompt) out.task = m.lastPrompt;
      if (m?.message?.model) out.model = m.message.model;
      const u = m?.message?.usage;
      if (!u) continue;
      // A single API response shows up on several transcript lines. Summing
      // every line double-counts spend ~2.3x on a long session, which grounds
      // an agent at well under half the budget the human actually set. Count
      // each message id once.
      const id = m?.message?.id || m?.requestId;
      if (id) { if (counted.has(id)) continue; counted.add(id); }
      // Price each message at the model that ANSWERED it. A session that
      // switched models part-way is a mix, and pricing the whole transcript at whatever is
      // current mis-states it by the ratio between the two -- 1.7x between
      // Opus 5 and Sonnet 5.
      const eff = (u.input_tokens || 0) + 5 * (u.output_tokens || 0)
                + 1.25 * (u.cache_creation_input_tokens || 0)
                + 0.1 * (u.cache_read_input_tokens || 0);
      usd += eff * priceOf(m?.message?.model || out.model).in / 1e6;
    }
  } catch {}
  // Back into effective tokens at the model answering NOW, which is the unit
  // the governor's budget is denominated in.
  out.tokens = Math.round(usd * 1e6 / priceOf(out.model).in);
  out.task = out.task.replace(/\s+/g, ' ').trim().slice(0, 140);
  return out;
}

function emit(decision, reason) {
  // decision: 'allow' | 'deny' | 'ask'
  const out = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: reason,
  };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
  process.exit(0);
}

// Which wallet is paying. Claude Code on a plan is flat-rate; an API key in
// the environment moves the same work onto per-token billing, and that is the
// gap the worst surprise bills fall through. We can see the key is set, not
// that it was used, so this is reported as "may be" and never acted on.
function billingMode() {
  return (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) ? 'api' : 'plan';
}

async function main() {
  let ev = {};
  try { ev = JSON.parse(readStdin() || '{}'); } catch {}
  const agent = ev.session_id ? 'claude:' + String(ev.session_id).slice(0, 8) : 'claude-code';
  const { tokens, model, task } = readTranscript(ev.transcript_path);
  // What the rules judge is what will actually run. For anything carrying a
  // shell command (Bash, PowerShell, an MCP terminal tool) that is the raw
  // command, judged as Bash, because the shell rules are scoped to Bash and a
  // different tool name used to skip them all. For other tools it is their
  // identifying fields, without file contents, which are long and are not
  // where a path or a URL hides. Nothing is cut: policy asks about anything
  // too long to judge, rather than judging a prefix.
  const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const shell = typeof input.command === 'string' ? input.command : null;
  const BULK = new Set(['content', 'new_string', 'old_string', 'edits', 'new_source']);
  const fields = Object.entries(input).filter(([k, v]) => !BULK.has(k) && typeof v === 'string').map(([, v]) => v);
  const tool = shell !== null ? 'Bash' : (ev.tool_name || 'tool');
  const action = shell !== null ? `Bash:${shell}` : `${tool}:${fields.join(' ')}`;

  let r;
  try {
    const resp = await fetch(`http://localhost:${PORT}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, tokens, action, task, tool, model: model || 'claude-code',
        billing: billingMode(), cwd: ev.cwd }),
      signal: AbortSignal.timeout(2500),
    });
    r = await resp.json();
  } catch {
    // Fail OPEN: if the governor is down, never block the user's real work.
    return emit('allow', 'GVNR is not running, so this was not checked. Nothing is blocked.');
  }

  // This is the one message a person actually reads, in the middle of their
  // work, at the moment they get stopped. It has to be in money and it has to
  // say what to do next -- a raw token count answers neither question.
  const perM = priceOf(model).in;
  const usd = t => '$' + ((t / 1e6) * perM).toFixed(2);
  const spent = usd(r.agent.tokens);
  const limit = r.agent.budget ? usd(r.agent.budget) : null;
  const of = limit ? `${spent} of its ${limit} limit` : `${spent} so far`;
  const dash = `http://localhost:${PORT}`;

  // A refusal and a stop are different events and must not read the same. A
  // capability refusal blocks THIS action and the agent carries on; offering
  // to "raise the limit" there sends someone to a control that will not help.
  const capability = !!(r.entry && r.entry.rule);
  if (r.verdict === 'deny') {
    if (capability) {
      return emit('deny', `GVNR refused this action: it is ${r.reason}. `
        + `The agent is not stopped and can carry on with something else. `
        + `To allow this kind of action, change the rule at ${dash}`);
    }
    return emit('deny', `GVNR stopped this agent: ${r.reason}. It has spent ${of}. `
      + `Raise the limit or resume it at ${dash}`);
  }
  if (r.verdict === 'escalate') {
    if (capability) {
      return emit('ask', `GVNR wants you to confirm: this action would ${r.reason.replace(/^wants to /, '')}. `
        + `Allow it this once?`);
    }
    return emit('ask', `GVNR is checking with you: ${r.reason}. It has spent ${of}. `
      + `Allow it to keep going?`);
  }
  return emit('allow', `GVNR: ${of}`);
}

main();
