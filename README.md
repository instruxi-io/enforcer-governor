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

## Why nothing else does this

We checked the whole landscape before building. Here is where it stands:

| | Sees the spend | Stops the spend | Asks a human | Proves it afterwards |
|---|---|---|---|---|
| Provider dashboards (Anthropic, OpenAI) | after the fact | no | no | no |
| Observability tools (Helicone, Langfuse, ccusage) | yes | no | no | logs, editable |
| LLM gateways (LiteLLM, Portkey) | yes | hard cutoff, bare error | no | logs, editable |
| **Enforcer Governor** | **live** | **per agent, with a reason** | **pauses and waits for you** | **hash-chained receipts** |

Three things you will not find together anywhere else:

1. **A third verb.** Everything else is allow or block. The Governor can **escalate**: the agent freezes mid-task, you get the spend context and a yes/no, and your decision is recorded with the receipt. That is the difference between a fuse and a cockpit.
2. **Receipts, not logs.** Every decision is chained by SHA-256, each hash folding in the last. Edit or delete one entry and the whole chain visibly breaks. A log says trust me; a receipt chain says check for yourself (there is a Verify button on the dashboard that does exactly that).
3. **Enforcement where it can act.** The Claude Code hook blocks the action *before it runs*, and the gateway refuses the request *before it is billed*. Anthropic has declined to build spend caps or a kill switch into Claude Code itself, and the community's answer so far has been meters with tens of thousands of stars that can only watch. This one acts.

---

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
npx --yes enforcer-governor start
```

The first run downloads it (a few seconds), then **your dashboard opens in the browser by itself**. Leave this terminal running; it is the guard. The dashboard tells you what to do next. Stop it any time with Ctrl+C, and your agents keep working normally.

### Govern Claude Code

In a **second** terminal, go into the project you want watched and run:

```bash
npx --yes enforcer-governor install-hook
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
  "dollars": 20,
  "model": "claude-opus-5",
  "soft": 0.75,
  "loopLimit": 4,
  "softAction": "escalate",
  "port": 4000
}
```

**Set the limit in dollars.** `dollars` is the spend cap per agent per session; `model` is which model's prices convert it into a token budget. The dashboard shows you what that buys before anything runs: how many tokens, and roughly how long an agent can work on it. Change it there at any time; agents already running pick up the new limit immediately, and one that was stopped for hitting the old limit is released.

**Claude and ChatGPT are both supported, and the model is detected for you.** Every agent reports which model answered, so the governor prices each one at its own rate and the dashboard's picker follows whatever it sees. `$20` means $20 whether that agent is on Opus 5 or GPT-5 mini. Pick a model by hand and your choice sticks.

Under the hood the cap is **cost-weighted effective tokens**, not raw counts. Cached sessions re-read their whole context every turn, so raw sums explode into the billions while costing very little. The governor weights by price instead, so one effective token is one input-token of cost at that model's price and `dollars` converts with a single multiply.

The weights are per model, because the output multiplier is not a constant: Anthropic prices output at 5x input across its range, while OpenAI is 6x on the GPT-5.6 family, 8x on GPT-5, and 4x on GPT-4o. Cached input differs too. `$20` is 4,000,000 effective tokens on Opus 5 and 16,000,000 on GPT-5. Set `budget` directly instead if you would rather think in tokens.

Prices are the providers' published list rates. **On a Claude or ChatGPT subscription you are not billed per token**, so read the dollar figures as equivalent API cost rather than an invoice.

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

## The bigger picture: Enforcer

The Governor is one idea applied to one resource. The idea is **Enforcer**, Instruxi's policy engine, and it asks a single question in front of every system it guards:

> **May this identity do this, right now?**

Answered three ways (allow, deny, escalate to a human), with a tamper-evident receipt for every answer. Here that identity is an AI agent and the resource is your money. In the full Enforcer platform the same verbs govern who reads a record, who moves funds, who issues a credential, and who approved the exception, across people, services, and agents, for teams that have to prove it to an auditor afterwards.

So this repo is also a working argument: if three verbs and a receipt chain can tame runaway agents on your laptop, the same primitive scales to the systems behind them. That is what we build. **[instruxi.io](https://instruxi.io)**

## License

Functional Source License 1.1 (FSL-1.1-ALv2). Free to run on your own agents, in production, including commercially. You may not offer it as a competing commercial product or service. Becomes Apache 2.0 two years after each release. See [LICENSE](LICENSE). Built by [Instruxi](https://instruxi.io).
