// Claude Code PreToolUse hook. Claude Code pipes a JSON event on stdin before
// every tool call; this reads it, totals the session's token usage from the
// transcript, asks the governor, and answers allow / deny / ask.
//
// Contract that actually works (learned the hard way): exit 0 and print JSON.
// Never exit 2 with JSON  -  that combination is ignored by Claude Code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { priceOf } from './policy.mjs';

const PORT = process.env.GOVERNOR_PORT || 4000;
const HOME = process.env.HOME || process.env.USERPROFILE || '.';

// The daemon writes this on first run (0600). Missing token just means the
// governor has never run here, which the fail-open path below already covers.
function token() {
  if (process.env.GOVERNOR_TOKEN) return process.env.GOVERNOR_TOKEN;
  try { return readFileSync(join(HOME, '.enforcer-governor', 'token'), 'utf8').trim(); } catch { return ''; }
}

// ── What the capability rules actually get to see ───────────────────────────
//
// Rules match against this string, so whatever it leaves out is unenforced.
// It used to be JSON.stringify(tool_input).slice(0, 200), which put a
// 200-character ceiling on the guard: `rm -rf /` on the far side of a long
// command was simply invisible, and padding the front of a command was enough
// to walk past every rule.
//
// So: pull the fields the rules care about to the FRONT, where a cap cannot
// displace them, then let the rest of the payload follow. Bulk content fields
// (a file body being written) are deliberately not promoted -- no default rule
// matches file contents, and hoisting them would cost size and sweep source
// code into the match text for nothing.
//
// This is a mitigation, not a proof. A regex over a shell command can always be
// dodged by an adversary with obfuscation or indirection; these rules are a
// safety net for accidents and for a model that has lost the plot, not an
// adversarial control.
const MATCH_FIELDS = ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern'];
const MATCH_CAP = 8192;
function matchText(tool, input) {
  const name = tool || 'tool';
  if (input == null) return `${name}:`;
  if (typeof input !== 'object') return `${name}:${String(input).slice(0, MATCH_CAP)}`;
  const front = [];
  for (const k of MATCH_FIELDS) if (typeof input[k] === 'string' && input[k]) front.push(input[k]);
  let rest = ''; try { rest = JSON.stringify(input); } catch {}
  return `${name}:${[...front, rest].join('\n').slice(0, MATCH_CAP)}`;
}

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
      // switched models part-way (which is exactly what this tool now suggests
      // you do) is a mix, and pricing the whole transcript at whatever is
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

function emit(decision, reason, systemMessage) {
  // decision: 'allow' | 'deny' | 'ask'
  const out = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: reason,
  };
  if (systemMessage) out.systemMessage = systemMessage;
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
  const action = matchText(ev.tool_name, ev.tool_input);

  let r;
  try {
    const resp = await fetch(`http://localhost:${PORT}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() },
      body: JSON.stringify({ agent, tokens, action, task, tool: ev.tool_name, model: model || 'claude-code',
        billing: billingMode(), cwd: ev.cwd }),
      signal: AbortSignal.timeout(2500),
    });
    // A 401 is a perfectly successful HTTP response, so it would sail past the
    // catch below and then blow up on r.agent a few lines down -- crashing the
    // hook, which prints nothing and leaves the agent's action in limbo. Treat
    // any non-2xx exactly like an unreachable governor.
    if (!resp.ok) throw new Error('governor returned ' + resp.status);
    r = await resp.json();
    if (!r || !r.verdict || !r.agent) throw new Error('governor returned an unexpected shape');
  } catch {
    // Fail OPEN: if the governor is down, never block the user's real work.
    return emit('allow', 'Enforcer is not running, so this was not checked. Nothing is blocked.');
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
      return emit('deny', `Enforcer refused this action: it is ${r.reason}. `
        + `The agent is not stopped and can carry on with something else. `
        + `To allow this kind of action, change the rule at ${dash}`);
    }
    return emit('deny', `Enforcer stopped this agent: ${r.reason}. It has spent ${of}. `
      + `Raise the limit or resume it at ${dash}`);
  }
  if (r.verdict === 'escalate') {
    if (capability) {
      return emit('ask', `Enforcer wants you to confirm: this action would ${r.reason.replace(/^wants to /, '')}. `
        + `Allow it this once?`);
    }
    return emit('ask', `Enforcer is checking with you: ${r.reason}. It has spent ${of}. `
      + `Allow it to keep going?`);
  }
  // A PreToolUse hook cannot change the model -- verified against the hooks
  // docs -- so the honest move is to tell the human, who can switch with
  // /model. systemMessage surfaces it without interrupting the work.
  if (r.advice) {
    return emit('allow', `Enforcer: ${of}`,
      `Enforcer: ${r.advice.why}. Consider /model ${r.advice.suggest}.`);
  }
  return emit('allow', `Enforcer: ${of}`);
}

main();
