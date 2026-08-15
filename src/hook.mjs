// Claude Code PreToolUse hook. Claude Code pipes a JSON event on stdin before
// every tool call; this reads it, totals the session's token usage from the
// transcript, asks the governor, and answers allow / deny / ask.
//
// Contract that actually works (learned the hard way): exit 0 and print JSON.
// Never exit 2 with JSON  -  that combination is ignored by Claude Code.
import { readFileSync } from 'node:fs';

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
  let total = 0;
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
      total += (u.input_tokens || 0) + 5 * (u.output_tokens || 0)
             + 1.25 * (u.cache_creation_input_tokens || 0)
             + 0.1 * (u.cache_read_input_tokens || 0);
    }
  } catch {}
  out.tokens = Math.round(total);
  out.task = out.task.replace(/\s+/g, ' ').trim().slice(0, 140);
  return out;
}

function emit(decision, reason) {
  // decision: 'allow' | 'deny' | 'ask'
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

async function main() {
  let ev = {};
  try { ev = JSON.parse(readStdin() || '{}'); } catch {}
  const agent = ev.session_id ? 'claude:' + String(ev.session_id).slice(0, 8) : 'claude-code';
  const { tokens, model, task } = readTranscript(ev.transcript_path);
  const action = `${ev.tool_name || 'tool'}:${JSON.stringify(ev.tool_input ?? '').slice(0, 200)}`;

  let r;
  try {
    const resp = await fetch(`http://localhost:${PORT}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, tokens, action, task, tool: ev.tool_name, model: model || 'claude-code' }),
      signal: AbortSignal.timeout(2500),
    });
    r = await resp.json();
  } catch {
    // Fail OPEN: if the governor is down, never block the user's real work.
    return emit('allow', 'governor offline, allowed');
  }

  if (r.verdict === 'deny') return emit('deny', `Enforcer blocked this: ${r.reason} (${r.agent.tokens.toLocaleString()} tokens, receipt ${r.receipt})`);
  if (r.verdict === 'escalate') return emit('ask', `Enforcer: ${r.reason}. Approve to let this agent keep spending? (${r.agent.tokens.toLocaleString()} tokens so far)`);
  return emit('allow', `within budget (${r.agent.tokens.toLocaleString()} tokens)`);
}

main();
