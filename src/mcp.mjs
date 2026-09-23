// GVNR as an MCP server over stdio:  npx -y enforcer-governor mcp
//
// A thin bridge to the local governor (npx enforcer-governor start), plus a
// direct read of the receipt file. No SDK: the protocol is newline-delimited
// JSON-RPC and five tools do not need one.
//
// The rule that shapes the tool list: the agent calling these tools is the one
// being governed, so nothing here can loosen anything. No approve, no resume,
// no config, no switching checks off. An agent can look, ask permission,
// verify the record, and stop an agent. Resuming is a human's job, in the
// dashboard.
//
// Asking permission is cooperative: an agent that calls gvnr_request_permission
// gets a verdict, but nothing forces an agent to call it. The Claude Code hook
// is the enforced route. This one reaches every MCP client.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { priceOf } from './policy.mjs';

const PORT = process.env.GOVERNOR_PORT || 4000;
const DASH = `http://localhost:${PORT}`;
const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const RECEIPTS = join(HOME, '.enforcer-governor', 'receipts.jsonl');
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const DOWN = `GVNR is not running on ${DASH}. Start it with: npx --yes enforcer-governor start`;
// One agent id per server process, always under mcp:, and never taken from
// the caller. A caller that picks its own id can pose as another agent, fill
// the new-agent alarm with fakes to disarm it, or push actions into someone
// else's loop window. Name it in the client config with GVNR_AGENT if you like.
const AGENT = 'mcp:' + (/^[\w.-]{1,48}$/.test(process.env.GVNR_AGENT || '') ? process.env.GVNR_AGENT : randomBytes(3).toString('hex'));

async function api(path, body) {
  const init = body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  };
  const r = await fetch(DASH + path, { ...init, signal: AbortSignal.timeout(2500) });
  return r.json();
}

const text = (t, structured, isError = false) =>
  ({ content: [{ type: 'text', text: t }], ...(structured && { structuredContent: structured }), ...(isError && { isError }) });
const usd = (tokens, model) => '$' + ((tokens / 1e6) * priceOf(model).in).toFixed(2);

const TOOLS = [
  {
    name: 'gvnr_request_permission',
    title: 'Ask GVNR before acting',
    description: 'Ask GVNR whether an action is allowed BEFORE you run it. Call this before any shell command, file deletion, git push, deploy or publish, and before reading or writing credentials. Returns allow, deny, or ask_human. On deny, do not run the action. On ask_human, stop and get approval from the person you are working for before running it. Every call is recorded in a hash-chained receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Exactly what you are about to do: the full shell command, or for a file operation the verb and path, e.g. "write /app/.env".' },
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run({ action }) {
      if (typeof action !== 'string' || !action.trim()) return text('action must be a non-empty string.', null, true);
      // Always judged as a shell command, whatever the caller calls its tool:
      // most rules are scoped to Bash, and a free-text tool name skipped them.
      // No model either, so a call can never change how an agent is priced.
      // The raw command, never cut: policy asks about anything too long to judge.
      const ev = { agent: AGENT, tool: 'Bash', action: `Bash:${action}` };
      let r;
      try { r = await api('/decide', ev); }
      catch { return text(`Not checked. ${DOWN}. Nothing was blocked.`, { verdict: 'unchecked' }); }
      const receipt = r.receipt || '';
      const why = r.reason || '';
      // A paused agent is paused until a human says otherwise. The governor
      // asks once and then answers allow, which is right for the hook, where
      // the person answers inside Claude Code, but here a retry must not read
      // as permission.
      if (r.verdict !== 'deny' && r.agent && r.agent.status === 'paused')
        return text(`ASK THE HUMAN. ${r.verdict === 'escalate' ? why : 'This agent is paused and waiting for a person'}. Do not run this until the person you are working for approves it in the GVNR dashboard at ${DASH}. Receipt ${receipt}.`,
          { verdict: 'ask_human', reason: why || 'paused', receipt });
      if (r.verdict === 'allow') return text(`ALLOW. Go ahead. Receipt ${receipt}.`, { verdict: 'allow', reason: why, receipt });
      if (r.verdict === 'deny') {
        const rule = !!(r.entry && r.entry.rule);
        return text(rule
          ? `DENY. Do not run this: it is ${why}. You are not stopped; choose a different approach. Receipt ${receipt}.`
          : `DENY. This agent is stopped: ${why}. A human has to resume it at ${DASH}. Receipt ${receipt}.`,
          { verdict: 'deny', reason: why, receipt });
      }
      return text(`ASK THE HUMAN. ${why}. Do not run this until the person you are working for approves. Receipt ${receipt}.`,
        { verdict: 'ask_human', reason: why, receipt });
    },
  },
  {
    name: 'gvnr_status',
    title: 'GVNR status',
    description: 'Show every governed agent with its status, spend and spend rate, plus the limits in force and what has been spent today, this week and this month.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run() {
      let s;
      try { s = await api('/state'); } catch { return text(DOWN, null, true); }
      const c = s.config;
      // Other agents' tasks are the first words of someone's prompt in another
      // session, so only this server's own agent shows one.
      const agents = s.agents.map(a => ({ id: a.id, status: a.status,
        spent: usd(a.tokens, a.model || c.model), limit: usd(a.budget, a.model || c.model),
        perMinute: '$' + (a.burn || 0).toFixed(2), ...(a.id === AGENT && a.task ? { task: a.task } : {}) }));
      const lines = [
        `GVNR is running at ${DASH}. You are ${AGENT}.`,
        `Across all agents: $${(c.fleetBurn || 0).toFixed(2)} a minute. Spent today $${(c.spent.day || 0).toFixed(2)}, this week $${(c.spent.week || 0).toFixed(2)}, this month $${(c.spent.month || 0).toFixed(2)}.`,
        `Limits: $${c.burnLimit} a minute per agent, $${c.fleetBurnLimit} a minute across all, ${c.fanoutLimit} new agents a minute, ${c.retryLimit} errors a minute, $${c.dollars} per agent session.`,
        agents.length ? `Agents (${agents.length}):` : 'No agents yet.',
        ...agents.map(a => `- ${a.id}: ${a.status}, ${a.spent} of ${a.limit}, ${a.perMinute} a minute${a.task ? `, "${a.task.slice(0, 80)}"` : ''}`),
      ];
      return text(lines.join('\n'), { agents, limits: { burnLimit: c.burnLimit, fleetBurnLimit: c.fleetBurnLimit,
        fanoutLimit: c.fanoutLimit, retryLimit: c.retryLimit, dollars: c.dollars }, spent: c.spent });
    },
  },
  {
    name: 'gvnr_recent_decisions',
    title: 'Recent GVNR decisions',
    description: 'List the most recent allow, deny and ask decisions from the receipt file, newest last.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many to return. Defaults to 20.' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ limit = 20 }) {
      if (!existsSync(RECEIPTS)) return text('No decisions recorded yet.', { decisions: [] });
      const n = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 20));
      let raw;
      try { raw = readFileSync(RECEIPTS, 'utf8'); } catch (e) { return text(`Could not read the receipt file: ${e.message}`, null, true); }
      // ponytail: reads the whole file to take the tail. Fine at thousands of
      // lines; if it ever reaches millions, read backwards from the end instead.
      const rows = raw.split('\n').filter(Boolean).slice(-n).flatMap(l => {
        try { const e = JSON.parse(l); return [{ time: new Date(e.ts).toISOString(), agent: e.agent, verdict: e.verdict,
          reason: e.reason, tool: e.tool || '' }]; } catch { return []; }
      });
      return text(rows.map(r => `${r.time}  ${r.verdict.padEnd(8)} ${r.agent}  ${r.tool ? r.tool + '  ' : ''}${r.reason}`).join('\n')
        || 'No decisions recorded yet.', { decisions: rows });
    },
  },
  {
    name: 'gvnr_verify_receipts',
    title: 'Verify the receipt chain',
    description: 'Check the hash chain over every recorded decision. Reports whether it is intact, or the line where a record was edited or removed.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run() {
      let v;
      try { v = await api('/verify'); } catch { return text(DOWN, null, true); }
      return text(v.ok
        ? `Chain intact: ${v.receipts} receipts verified.`
        : `Chain BROKEN at line ${v.brokeAt}. A record was edited or removed there.`, v);
    },
  },
  {
    name: 'gvnr_stop_agent',
    title: 'Stop an agent',
    description: 'Stop a governed agent immediately. Only a human can resume it, from the GVNR dashboard. Use gvnr_status for agent ids.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'The agent id, as shown by gvnr_status.' },
    }, required: ['agent'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run({ agent }) {
      if (typeof agent !== 'string' || !agent.trim() || agent.length > 200) return text('agent must be an agent id from gvnr_status.', null, true);
      let r;
      try { r = await api('/kill', { agent }); } catch { return text(DOWN, null, true); }
      if (!r || r.error) return text(`No agent called "${agent}". Use gvnr_status to see agent ids.`, null, true);
      return text(`Stopped ${agent}. Only a human can resume it, at ${DASH}.`, { stopped: String(agent) });
    },
  },
];

const INSTRUCTIONS = 'GVNR is a local guard for AI agents. Before running any shell command, deleting files, pushing git history, deploying, publishing, or touching credentials, call gvnr_request_permission with the exact action, and follow the verdict: allow means go ahead, deny means do not run it, ask_human means stop and get approval first.';

async function handle(msg) {
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[PROTOCOLS.length - 1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gvnr', title: 'GVNR (Enforcer Governor)', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map(({ run, ...t }) => t) };
    case 'tools/call': {
      const t = TOOLS.find(x => x.name === p.name);
      if (!t) throw Object.assign(new Error(`Unknown tool: ${p.name}`), { code: -32602 });
      // A tool that fails is a tool result with isError, not a protocol error.
      try { return await t.run(p.arguments && typeof p.arguments === 'object' ? p.arguments : {}); }
      catch (e) { return text(`GVNR error: ${e.message}`, null, true); }
    }
    default: throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const invalid = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };

async function one(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return invalid;
  if (typeof msg.method !== 'string') return null;             // a response, or junk: never answered
  if (msg.id === undefined || msg.id === null) return null;    // a notification: nothing to answer
  try { return { jsonrpc: '2.0', id: msg.id, result: await handle(msg) }; }
  catch (e) { return { jsonrpc: '2.0', id: msg.id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: String(e.message) } }; }
}

createInterface({ input: process.stdin }).on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (Array.isArray(msg)) {                                      // a batch, from a 2025-03-26 client
    if (!msg.length) return send(invalid);
    const out = (await Promise.all(msg.map(one))).filter(Boolean);
    return out.length && send(out);
  }
  const r = await one(msg);
  if (r) send(r);
});
