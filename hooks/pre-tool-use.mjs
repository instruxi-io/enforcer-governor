// Claude Code shim: hook JSON -> common event -> core decision -> Claude's
// permission vocabulary. The decision and its wording live in lib/decide.mjs.
import { input, emit, pass } from './lib.mjs';
import { decide } from '../lib/decide.mjs';

const EVENT = 'PreToolUse';
const r = await decide(input());
try { process.stderr.write(r.line + '\n'); } catch {}
const top = r.notice ? { systemMessage: r.notice } : {};
if (r.decision) {
  emit(EVENT, {
    permissionDecision: r.decision,
    permissionDecisionReason: r.reason,
    ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}),
  }, top);
}
pass(EVENT, top);
