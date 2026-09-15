// Point Claude Code's own OpenTelemetry exporter at the Enforcer control plane.
//
// Claude Code exports its metrics (claude_code.cost.usage, token.usage, ...) and
// events (tool_result, api_request, ...) over OTLP when told to. This writes the
// settings that tell it to, into ~/.claude/settings.json:
//
//   env.CLAUDE_CODE_ENABLE_TELEMETRY   1
//   env.OTEL_METRICS_EXPORTER          otlp
//   env.OTEL_LOGS_EXPORTER             otlp
//   env.OTEL_EXPORTER_OTLP_PROTOCOL    http/protobuf
//   env.OTEL_EXPORTER_OTLP_ENDPOINT    <origin>/api/v1/governance/otlp
//   otelHeadersHelper                  node ~/.enforcer/otel-headers.mjs
//
// AUTH WITHOUT A STATIC SECRET. OTEL_EXPORTER_OTLP_HEADERS would put a credential
// in a settings file in plain text, and an OAuth access token lasts 15 minutes.
// Claude Code's otelHeadersHelper runs a command for the headers instead, and
// re-runs it; ours prints the same Enforcer headers the MCP helper does, from
// the shared sign-in, refreshing the token when it is close to expiry.
//
// A STABLE PATH. The plugin lives in a versioned directory that moves on every
// update, so settings never name it. They name ~/.enforcer/otel-headers.mjs, a
// three-line shim that follows ~/.enforcer/plugin-root, which the SessionStart
// hook rewrites every session.
//
// Prompts are NOT exported: Claude Code redacts them unless OTEL_LOG_USER_PROMPTS
// is set, and this never sets it.

import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SHARED_DIR, baseUrl } from './credentials.mjs';

const home = () => process.env.HOME || process.env.USERPROFILE || homedir();
export const CLAUDE_SETTINGS = () => process.env.CLAUDE_SETTINGS_PATH || join(home(), '.claude', 'settings.json');
const SHIM = () => join(SHARED_DIR(), 'otel-headers.mjs');
const ROOT = () => join(SHARED_DIR(), 'plugin-root');
export const OTLP_PATH = '/api/v1/governance/otlp';

const ENV_KEYS = ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_ENDPOINT'];

const pluginRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..');

/** Record where this plugin version lives, for the headers shim. Never throws. */
export function recordPluginRoot() {
  try {
    mkdirSync(SHARED_DIR(), { recursive: true, mode: 0o700 });
    const root = pluginRoot();
    let current = '';
    try { current = readFileSync(ROOT(), 'utf8').trim(); } catch {}
    if (current !== root) writeFileSync(ROOT(), root + '\n');
  } catch { /* telemetry headers will be empty until the next session */ }
}

function writeShim() {
  mkdirSync(SHARED_DIR(), { recursive: true, mode: 0o700 });
  writeFileSync(SHIM(), [
    '#!/usr/bin/env node',
    '// Written by /enforcer-governor:telemetry. Prints Enforcer auth headers for',
    "// Claude Code's otelHeadersHelper from the plugin version recorded in plugin-root.",
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { homedir } from 'node:os';",
    "import { pathToFileURL } from 'node:url';",
    "const dir = process.env.ENFORCER_HOME || join(process.env.HOME || homedir(), '.enforcer');",
    "try { await import(pathToFileURL(join(readFileSync(join(dir, 'plugin-root'), 'utf8').trim(), 'bin', 'enforcer-headers.mjs')).href); }",
    "catch { process.stdout.write('{}'); }",
    '',
  ].join('\n'), { mode: 0o700 });
}

const readSettings = () => {
  const p = CLAUDE_SETTINGS();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf8'));   // a malformed file throws: never overwrite what we cannot read
};

function writeSettings(s) {
  const p = CLAUDE_SETTINGS();
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) copyFileSync(p, p + '.enforcer-backup');
  const tmp = p + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, p);
}

/** Turn telemetry on. Returns what was written, for the command to print. */
export function enable(cfg = {}) {
  const endpoint = (cfg.ingestUrl || baseUrl(cfg)).replace(/\/+$/, '') + OTLP_PATH;
  recordPluginRoot();
  writeShim();
  const s = readSettings();
  s.env = { ...(s.env || {}),
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  };
  s.otelHeadersHelper = `node "${SHIM()}"`;
  writeSettings(s);
  return { endpoint, settings: CLAUDE_SETTINGS(), helper: s.otelHeadersHelper };
}

/** Turn it off: remove exactly the keys enable() wrote, nothing else. */
export function disable() {
  const s = readSettings();
  if (s.env) {
    for (const k of ENV_KEYS) delete s.env[k];
    if (!Object.keys(s.env).length) delete s.env;
  }
  if (typeof s.otelHeadersHelper === 'string' && s.otelHeadersHelper.includes('otel-headers.mjs')) delete s.otelHeadersHelper;
  writeSettings(s);
  return { settings: CLAUDE_SETTINGS() };
}

export function status() {
  let s = {};
  try { s = readSettings(); } catch { return { on: false, error: 'settings.json is not valid JSON' }; }
  const env = s.env || {};
  return {
    on: env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' && !!env.OTEL_EXPORTER_OTLP_ENDPOINT,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    ours: typeof s.otelHeadersHelper === 'string' && s.otelHeadersHelper.includes('otel-headers.mjs'),
  };
}
