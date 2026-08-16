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

## Where this sits

Spend caps are no longer unique, and it would be dishonest to imply otherwise. Anthropic ships usage-credit limits at organization, group and member level, workspace spend limits on the Console, and a self-hosted gateway with per-user caps that block requests. Third-party tools cap Claude Code spend per session, day, week and month.

What none of them do is decide **whether an action is allowed at all**:

| | Sees spend | Stops spend | Gates the ACTION | Names who it acted for | Tamper-evident |
|---|---|---|---|---|---|
| Provider dashboards | after the fact | no | no | no | no |
| Observability tools (Helicone, Langfuse, ccusage) | yes | no | no | no | logs, editable |
| LLM gateways (LiteLLM, Portkey) | yes | hard cutoff | no | per key | logs, editable |
| Native and third-party spend caps | yes | yes | **no** | no | no |
| **Enforcer Governor** | **live** | **per agent and per fleet** | **yes, before it runs** | **yes** | **hash-chained** |

A spend cap answers "can it afford this?". It has no opinion on `curl | sh`, on `rm -rf`, or on reading your `.env`, all of which are cheap. This asks the question Enforcer asks everywhere else: is this actor permitted to do this, right now, and who authorised it.

---

## What you need

One thing: **Node.js**, a free tool most developers already have. Check by typing `node --version` in a terminal. If that fails, install it from [nodejs.org](https://nodejs.org) (big green button, two clicks).

---

## Three things, not one

**Control.** What the agent may DO, checked before it does it. Piping the internet into a shell is refused outright. Deleting a tree, rewriting git history, reading credentials, publishing or deploying: those stop and ask you. Ordinary work passes untouched. These are capability decisions, not spend ones, so they fire with a full budget.

**Receipts.** Every decision is hash-chained, and each one names the human the agent was acting for, the tool it tried to use, the model answering, and the rule that decided. Edit or delete a single record and the chain visibly breaks. Those are the fields an audit asks for, recorded as fields rather than buried in prose.

**Spend.** A dollar limit per agent, a soft cap that asks you before it keeps going, and total caps across every agent per day, week and month. Loops and repeated work are caught on behaviour, not just cost.

**Speed, not just totals.** The incidents that actually cost people money are rate incidents: a session fanning out to dozens of subagents reaches four figures in one sitting, and a daily cap only notices once the day's money is gone. The governor watches dollars per minute, per agent and across the fleet, and stops to ask you when it runs away. Ordinary work sits around $0.10 to $0.25 a minute, so the defaults of $2 and $10 a minute leave normal sessions alone.

**The right model for the job.** Running the test suite on your most expensive model is the most common way to overspend without noticing. The governor reads the task the agent was actually given and says when the model looks mismatched, in either direction: a top-tier model on mechanical work, or a light one on work that needs reasoning. It moves one step at a time, along named tiers, and says nothing at all when the task is ambiguous, because a bad downgrade costs more in wasted work than it saves in tokens.

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

### Govern any other agent (ChatGPT, Gemini, OpenAI or Anthropic SDKs, custom agents)

Point the agent's API base URL at the governor:

```bash
# OpenAI-based agents
export OPENAI_BASE_URL=http://localhost:4000/v1

# Anthropic SDK agents
export ANTHROPIC_BASE_URL=http://localhost:4000
```

Gemini, Groq, Together and anything else that speaks the OpenAI chat-completions shape works through the same route -- tell the governor where to forward:

```bash
# Gemini
GOVERNOR_OPENAI_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions \
  npx --yes enforcer-governor start
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
  "burnLimit": 2,
  "fleetBurnLimit": 10,
  "port": 4000
}
```

**Set the limit in dollars.** `dollars` is the spend cap per agent per session; `model` is which model's prices convert it into a token budget. The dashboard shows you what that buys before anything runs: how many tokens, and roughly how long an agent can work on it. Change it there at any time; agents already running pick up the new limit immediately, and one that was stopped for hitting the old limit is released.

**Claude, ChatGPT and Gemini are all supported, and the model is detected for you.** Every agent reports which model answered, so the governor prices each one at its own rate and the dashboard's picker follows whatever it sees. `$20` means $20 whether that agent is on Opus 5, GPT-5 mini or Gemini 2.5 Pro. Pick a model by hand and your choice sticks.

Under the hood the cap is **cost-weighted effective tokens**, not raw counts. Cached sessions re-read their whole context every turn, so raw sums explode into the billions while costing very little. The governor weights by price instead, so one effective token is one input-token of cost at that model's price and `dollars` converts with a single multiply.

The weights are per model, because the output multiplier is not a constant: Anthropic prices output at 5x input across its range, OpenAI runs 4x to 8x, and Gemini runs 4x to 8.33x. Cached input differs too. Two Gemini caveats are baked in: the Flash 3.7/3.6 rates are the ones in force through 2026-12-31, and the Pro rates are the sub-200k-prompt tier. `$20` is 4,000,000 effective tokens on Opus 5 and 16,000,000 on GPT-5. Set `budget` directly instead if you would rather think in tokens.

Prices are the providers' published list rates. **On a Claude, ChatGPT or Gemini subscription you are not billed per token**, so read the dollar figures as equivalent API cost rather than an invoice. When an API key is present in the environment the same work may be billing per token instead of against your plan, which is where the nastiest surprise bills come from, so the dashboard flags that agent rather than leaving you to find out on the invoice.

`softAction` is `"escalate"` (ask a human) or `"deny"` (auto-block at the soft cap). Everything is also flippable live from the dashboard switches.

**Matching the model to the task** is on by default as advice (`adviseModel`). Set `enforceModel: true` and the governor will actually rewrite the request to the cheaper model on the proxy path, where it owns the request. It only ever downgrades: spending more of your money without asking is not its call. On Claude Code it stays advice, because a `PreToolUse` hook cannot change the model, so the suggestion is surfaced to you instead and you switch with `/model`.

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
- **Receipts**: appended to `~/.enforcer-governor/receipts.jsonl`, each line carrying its own hash, folded in from the previous line. `GET /verify` walks the **file** and names the first line that does not add up, so an edit or a deletion anywhere in the history is caught, including in a stretch written before the last restart. Receipts written by versions before 0.11 have no stored hash and are reported as `unverifiable` rather than quietly passed.

## Honest limits (v0.1)

- The proxy buffers responses; streaming passthrough is next.
- Token totals come from the transcript, which writes asynchronously, so a decision can lag real spend by one turn. Enforcement at the tool boundary makes this safe in practice.
- On subscription billing, dollar figures are estimates at list prices, labelled `est.`
- Model matching is a heuristic on the wording of the task, so it stays quiet unless the signal is clear. It is advice everywhere except the proxy, where it can downgrade if you turn that on.

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
