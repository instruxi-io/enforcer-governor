# Enforcer Governor

**Real-time spend control for AI agents. Free, open, and self-hosted.**

Every tool that tracks agent token usage today does the same thing: it reports the damage *after* it happens. Enforcer Governor is different. It sits in front of your agents and decides, on every action, one of three things:

- **allow** &mdash; in budget and on task
- **deny** &mdash; over budget, or stuck in a loop
- **escalate** &mdash; needs more fuel, so a human decides

Every decision leaves a **hash-chained receipt**, so you can prove exactly what each agent did and under whose authority. It runs entirely on your machine, against your own keys. We never see your data.

Live demo (simulated fleet): **https://enforcer-governor.vercel.app**

---

## What it catches

- **Budget blowouts** &mdash; a hard token cap per agent, per session. Deny once it is hit.
- **Loops and waste** &mdash; the same tool call with the same arguments, over and over. Flagged at 3, blocked at 4.
- **Runaway spend** &mdash; a soft cap (default 75%) that pauses the agent and asks you before it keeps going.

It does **not** claim to detect hallucination &mdash; nobody can do that reliably. It catches the mechanical waste that is actually detectable, and escalates the judgment calls to you.

---

## Quickstart (60 seconds)

### Govern Claude Code

```bash
# 1. start the governor (this terminal)
npx @instruxi/enforcer-governor start

# 2. wire the hook into your project (another terminal, in your repo)
npx @instruxi/enforcer-governor install-hook
```

That is it. Open **http://localhost:4000** to watch. Every tool call in that project now checks the governor first. Over budget, and Claude Code is told to stop. At the soft cap, it asks you to approve. Add `--global` to the install command to govern every project.

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
  "budget": 200000,
  "soft": 0.75,
  "loopLimit": 4,
  "softAction": "escalate",
  "port": 4000
}
```

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
