#!/usr/bin/env node
// The turn boundary — the one moment the agent can still change its plan.
//
// This is the channel v1 and v2 did not have. Both could only interrupt: when
// an agent crossed the warn mark the HUMAN got a question and the agent got
// nothing, so the only lever was stopping work that was already half done.
// additionalContext puts a sentence into the model's own context, before it
// decides what to do, which turns "you have been stopped" into "land what you
// have". Cheaper for everyone, and it happens before the money is spent.
import { input, emit, agentOf } from './lib.mjs';
import { governor } from '../adapters/claude-code/index.mjs';

const EVENT = 'UserPromptSubmit';
const ev = input();

// Fails open and silent, like everything else on this path: a governor that
// cannot read its own state has nothing useful to tell the agent.
const b = governor().brief(agentOf(ev));
emit(EVENT, b ? { additionalContext: b.text } : {});
