# Enforcer Governor

[![ci](https://github.com/instruxi-io/enforcer-governor/actions/workflows/ci.yml/badge.svg)](https://github.com/instruxi-io/enforcer-governor/actions/workflows/ci.yml)

**Stop your AI agents from wasting your money. Free, open, runs on your own computer.**

AI agents burn tokens, and tokens are money. They get stuck in loops, repeat work, and blow through budgets, and every existing tool just *reports* the damage afterwards. Enforcer Governor is a guard that stands in front of your agents and answers one question before every action:

> **May this agent do this, right now?**

- **allow** &mdash; in budget and on task, carry on
- **deny** &mdash; over budget or stuck in a loop, blocked
- **escalate** &mdash; wants more budget, so it pauses and asks YOU

Every decision leaves a **tamper-proof receipt**, so you can always prove what your agents did and who approved what. Everything runs on your own computer with your own keys. Nothing is sent to us, ever.

**See it in 10 seconds** (no install, simulated agents): **https://enforcer-governor.vercel.app**

---

## What you need

One thing: **Node.js**, a free tool most developers already have. Check by typing `node --version` in a terminal. If that fails, install it from [nodejs.org](https://nodejs.org) (big green button, two clicks).

---

## What it catches

- **Budget blowouts** &mdash; a hard token cap per agent, per session. Deny once it is hit.
- **Loops and waste** &mdash; the same tool call with the same arguments, over and over. Flagged at 3, blocked at 4.
- **Runaway spend** &mdash; a soft cap (default 75%) that pauses the agent and asks you before it keeps going.

It does **not** claim to detect hallucination &mdash; nobody can do that reliably. It catches the mechanical waste that is actually detectable, and escalates the judgment calls to you.

---

## Start it (one command)

Open a terminal and run:

```bash
npx --yes github:instruxi-io/enforcer-governor start
```

The first run downloads it (a few seconds), then **your dashboard opens in the browser by itself**. Leave this terminal running; it is the guard. The dashboard tells you what to do next. Stop it any time with Ctrl+C, and your agents keep working normally.

### Govern Claude Code

In a **second** terminal, go into the project you want watched and run:

```bash
npx --yes github:instruxi-io/enforcer-governor install-hook
```

Then start a **new** Claude Code session in that project. That is all. From now on, every action Claude Code takes is checked first: over budget and it is stopped, near the limit and it asks you. Add `--global` to the command to watch every project at once.

### Govern any other agent (ChatGPT, OpenAI, Anthropic SDK, custom agents)

Point the agent's API base URL at the governor:

```bash
# OpenAI-based agents
export OPENAI_BASE_URL=http://localhost:4000/v1

# Anthropic SDK agents
export ANTHROPIC_BASE_URL=http://localhost:4000
```

Every request now passes through the governor. It meters real usage from each response and refuses (HTTP 429) once an agent is over budget or grounded. Tag requests per agent with an `x-enforcer-agent: <name>` header so they show up separately on the dashboard.

> The public ChatGPT website is closed and cannot be governed. Anything built on the OpenAI **API** can.

---

## Configure

Drop a `governor.config.json` in the directory you run it from:

```json
{
  "budget": 5000000,
  "soft": 0.75,
  "loopLimit": 4,
  "softAction": "escalate",
  "port": 4000
}
```

**Budgets are cost-weighted effective tokens**, not raw counts. Cached sessions re-read their whole context every turn, so raw sums explode into the billions while costing very little. The governor weights by price instead: input 1x, output 5x, cache-create 1.25x, cache-read 0.1x. Think of the budget as a dollar meter expressed in input-token units. The 5M default is roughly a heavy day of agent work.

`softAction` is `"escalate"` (ask a human) or `"deny"` (auto-block at the soft cap). Everything is also flippable live from the dashboard switches.

---

## How it works

```
Claude Code ──hook──┐
                    ├──► Governor ──► allow / deny / escalate ──► hash-chained receipt
other agents ─proxy─┘        │
                             └──► dashboard (live gauges + decision tape)
```

- **Hook** (`PreToolUse`): reads your session transcript, totals the tokens, asks the governor, and translates the verdict into Claude Code's own allow / deny / ask. If the governor is down it fails **open**, so it never blocks your real work.
- **Proxy**: a passthrough for `/v1/messages` and `/v1/chat/completions` that reads exact usage from responses and refuses when an agent is over its limit. This is the tamper-resistant path, since it runs server-side.
- **Receipts**: appended to `~/.enforcer-governor/receipts.jsonl`, each hash folding in the previous one. `GET /verify` walks the chain; any edit or deletion breaks it.

## Honest limits (v0.1)

- The proxy buffers responses; streaming passthrough is next.
- Token totals come from the transcript, which writes asynchronously, so a decision can lag real spend by one turn. Enforcement at the tool boundary makes this safe in practice.
- On subscription billing, dollar figures are estimates at list prices, labelled `est.`

## Run the tests

```bash
npm test
```

## License

MIT. Built by [Instruxi](https://instruxi.io). Part of the Enforcer family: one question, "may this identity do this right now?", answered with a decision and a receipt.
