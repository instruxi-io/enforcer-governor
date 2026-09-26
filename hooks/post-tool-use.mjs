#!/usr/bin/env node
// The outcome. v1 recorded only intentions -- it knew it had allowed
// `terraform apply` and never learned whether it ran. A failed call is also
// the cheap half of a retry storm: the rate-limited call returns fast, and the
// retry after it is what costs money.
import { input, emit, agentOf } from './lib.mjs';
import { governor } from '../adapters/claude-code/index.mjs';

const ev = input();
const failed = !!(ev.tool_response && (ev.tool_response.is_error || ev.tool_response.error));

// Record the outcome and ship what has been decided, without waiting: the
// shipper is spawned detached at most every 30s. No network on this path.
governor().after({ agent: agentOf(ev) }, { failed });

emit('PostToolUse', {});
