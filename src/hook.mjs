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

// Cost-weighted effective tokens from the session transcript (JSONL).
// Raw sums mislead: every turn re-reads the whole cached context, so cache
// reads dominate any long session at ~10% of the price of fresh input.
// Weights are price-proportional (input=1): output 5x, cache-create 1.25x,
// cache-read 0.1x. Think of it as a dollar meter in input-token units.
function tokensFromTranscript(path) {
  if (!path) return 0;
  let total = 0;
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const u = m?.message?.usage;
      if (u) total += (u.input_tokens || 0) + 5 * (u.output_tokens || 0)
                    + 1.25 * (u.cache_creation_input_tokens || 0)
                    + 0.1 * (u.cache_read_input_tokens || 0);
    }
  } catch {}
  return Math.round(total);
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
  const tokens = tokensFromTranscript(ev.transcript_path);
  const action = `${ev.tool_name || 'tool'}:${JSON.stringify(ev.tool_input ?? '').slice(0, 200)}`;

  let r;
  try {
    const resp = await fetch(`http://localhost:${PORT}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, tokens, action, tool: ev.tool_name, model: 'claude-code' }),
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
