// Handing a task to a different model.
//
// The naive move is to repoint the base URL and resend the conversation. That
// does not work: Anthropic's own issue #46423 records that switching provider
// mid-session leaves the new one with zero context, and it was closed as not
// planned. Resending a long transcript is also the expensive move, because the
// prompt cache is per provider and the new side re-reads everything at full
// price.
//
// What the coding agents converged on instead is a HANDOFF: the outgoing model
// writes a short structured brief, and the incoming model starts from that.
// Small, so it fits any window including a local one, and there is no large
// context to re-read. Two rules come with it:
//
//   1. Compact on the OLD model. It is the one that did the reasoning.
//   2. Cut on a user turn, so an assistant tool call is never separated from
//      its tool result.
//
// Codex found that repeated compaction degrades a session as recursive
// summaries distort earlier reasoning, so this is meant for one switch, not as
// a habit. `handoffs` on the agent counts them and the caller can refuse a
// second one.

// A reasoning model counts its thinking against max_tokens, so a brief asked
// for with a modest budget can come back completely empty: measured on a local
// Qwen 3.8 27B, 1599 of 1599 completion tokens went to reasoning and the
// content was an empty string. The brief is a summarisation job and does not
// need extended thinking, so ask for it off and leave real headroom. These are
// passed to whatever provider is answering; ones it does not know are ignored.
export const HANDOFF_OPTS = {
  max_tokens: 3000,
  temperature: 0.2,
  chat_template_kwargs: { enable_thinking: false },  // Qwen and most local runtimes
  reasoning_effort: 'low',                            // OpenAI-shaped reasoning models
};

export const HANDOFF_PROMPT = `You are handing this task to a different model that has NONE of this conversation.
Write the brief it needs. No preamble, no sign-off, no markdown headings beyond the five labels.

GOAL: what the human actually asked for, in one or two sentences.
DECISIONS: choices already made and why, so they are not re-litigated.
DONE: what is finished, with the concrete details (file paths, names, values) needed to trust it.
REMAINING: what is left, in the order it should be done.
CRITICAL: anything that would be lost otherwise: exact identifiers, error text, versions, gotchas already hit.

Be specific. A name or a path is worth more than a sentence describing it. If something is unknown, say so rather than guessing.`;

// Find the last user turn at or before `from`. Cutting anywhere else can strand
// an assistant tool call away from its tool result, which breaks the request.
export function safeCut(messages, from = messages.length) {
  for (let i = Math.min(from, messages.length) - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return i;
  }
  return -1;
}

// The messages to send the outgoing model when asking it for the brief.
export function handoffRequest(messages) {
  const cut = safeCut(messages);
  const upto = cut === -1 ? messages : messages.slice(0, cut + 1);
  return [...upto, { role: 'user', content: HANDOFF_PROMPT }];
}

// The messages to send the incoming model: the brief, then the work to do.
// The brief goes in as a user turn rather than a system prompt, because a
// local runtime may drop or reweight system content it did not expect.
export function resumeWith(brief, messages) {
  const cut = safeCut(messages);
  const last = cut === -1 ? null : messages[cut];
  const out = [{
    role: 'user',
    content: `You are taking over a task in progress from another model. Here is the brief it wrote for you.\n\n`
      + `--- BRIEF ---\n${brief}\n--- END BRIEF ---\n\n`
      + `Continue the work. Do not restart it and do not summarise the brief back.`,
  }];
  if (last) out.push(last);
  return out;
}
