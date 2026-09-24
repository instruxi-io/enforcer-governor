// Anonymous usage counts, OFF until the person switches them on in the dashboard or with
// `enforcer-governor telemetry on`. When on, GVNR sends at most one small message a day:
// a random install ID made on this machine, the GVNR version, the operating system, and
// whether it checked any agent actions that day. Never code, commands, file paths, agent
// names, prompts or spend. Automated machines (CI) and DO_NOT_TRACK=1 never send.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
const DIR = process.env.GVNR_DATA_DIR || join(HOME, '.enforcer-governor');
const FILE = join(DIR, 'telemetry.json');
const ENDPOINT = process.env.GVNR_TELEMETRY_URL || 'https://gvnr.io/api/t';
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const WHAT_IS_SENT = 'A random install ID, your GVNR version and operating system, and whether it checked any agent actions that day. Never your code, commands, file paths, agent names, prompts or spend.';
const CI_VARS = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS',
  'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD', 'BITBUCKET_BUILD_NUMBER', 'CODEBUILD_BUILD_ID', 'DRONE', 'VERCEL', 'NETLIFY'];

// Why sending is off regardless of the setting, or '' when it is allowed.
export function blocked(env = process.env) {
  if (env.DO_NOT_TRACK === '1' || env.GVNR_TELEMETRY === '0') return 'switched off by an environment variable';
  if (CI_VARS.some(k => env[k])) return 'this looks like an automated machine';
  return '';
}

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = s => { try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(s, null, 2)); } catch {} };
const newId = () => randomBytes(16).toString('hex');

// The first-run date is kept locally so the survey can wait two weeks. It is never sent.
export function init() { const s = load(); if (!s.firstRun) { s.firstRun = Date.now(); save(s); } }

export function status() {
  const s = load();
  return { on: !!s.on, asked: 'on' in s, blocked: blocked(), firstRun: s.firstRun || Date.now(),
    surveyedAt: s.surveyedAt || 0, sends: WHAT_IS_SENT };
}

export function set(on) {
  const s = load();
  s.on = !!on;
  if (s.on && !s.id) s.id = newId();
  save(s);
  return status();
}

// Exactly these fields, nothing else. The test checks it.
export const pingBody = (id, on) => ({ k: 'p', id, v: VERSION, os: process.platform, on: on ? 1 : 0 });

async function send(body) {
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

let checked = 0;
export const noteDecision = () => { checked++; };

// At most one ping a day, plus one more if the first went out before any action was checked.
export async function tick(now = new Date()) {
  const s = load();
  if (!s.on || !s.id || blocked()) return false;
  const day = now.toISOString().slice(0, 10), on = checked > 0;
  const newDay = s.lastPing !== day;
  if (!newDay && !(on && !s.lastOn)) return false;
  if (!(await send(pingBody(s.id, on)))) return false;
  const t = load();
  t.lastPing = day; t.lastOn = newDay ? on : true;
  save(t); checked = 0;
  return true;
}

// Sent only when the person presses Send in the dashboard, whether or not counts are on.
export async function survey(answer, benefit = '') {
  if (!['very', 'somewhat', 'not'].includes(answer)) return { ok: false, error: 'answer must be very, somewhat or not' };
  const s = load();
  if (!s.id) s.id = newId();
  s.surveyedAt = Date.now();
  save(s);
  if (blocked()) return { ok: true, sent: false };
  const sent = await send({ k: 's', id: s.id, a: answer, b: String(benefit).slice(0, 280) });
  return { ok: true, sent };
}
