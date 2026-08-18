# Enforcer Governor

**A Claude Code plugin that decides whether an agent action is allowed *before* it runs — and keeps a record you can prove.**

Agents get stuck in loops, repeat work, and pipe the internet into a shell. Every other tool reports the damage afterwards. This one answers a question first:

> **May this agent do this, right now?**

- **allow** — in budget and on task, carry on
- **deny** — over budget, looping, or not permitted at all
- **ask** — pause and check with you

Every decision is appended to a hash-chained record. Edit or delete a single line and the chain visibly breaks. Everything stays on your machine.

## Install

```
/plugin marketplace add instruxi-io/enforcer-governor
/plugin install enforcer-governor
```

That is the whole install. Hooks, capability rules, slash commands and the status line arrive with it. `/plugin disable enforcer-governor` removes it just as cleanly.

## What you get

**A number in your status line.** `· $3.40/$20` — live spend against the limit, always visible, no dashboard to open. It changes colour once, when something needs you.

**Capability rules that ship with the plugin.** Piping a URL into a shell is refused outright. Deleting a tree, rewriting git history, reading credentials, publishing or deploying: those stop and ask. These are capability decisions, not spend ones, so they fire on a full budget — and they ship as native permission rules as well as hook checks, so the hard ones hold even if the plugin's own state is unreadable.

**A spend limit that means dollars.** `/governor:limit 40` sets $40 per agent. Claude prices each model at its own rate, so $40 is $40 whether the agent is on Opus 5 or Haiku 4.5. Under the hood the cap is cost-weighted effective tokens, because cached sessions re-read their whole context every turn and raw token counts explode while costing very little.

**Rate limits, not just totals.** The incidents that cost real money are rate incidents. Dollars per minute, new agents per minute, and errors per minute are each watched and each *ask* rather than block — and ask once, so an overnight run waits for you instead of dying or nagging.

**A record an audit can read.** `/governor:verify` walks the file and names the first line that does not add up. Every receipt carries who the agent acted for, what it tried, which model answered, and which rule decided.

## Commands

| | |
|---|---|
| `/governor:status` | spend per agent, limits, current burn, state of the record |
| `/governor:verify` | check the chain, name the first broken line |
| `/governor:limit <dollars>` | set the per-agent limit |

## How it works

```
tool call ─► PreToolUse hook ─► capability rules ─► spend + rate checks
                                       │
                                       ▼
                          allow / deny / ask  ─►  hash-chained receipt
```

No daemon, no port, nothing listening. State lives in `~/.enforcer-governor/` behind a lock, so parallel tool calls land in the record in the order they were decided. If any of that is unreadable the hook allows the action and says so — a governor that blocks real work because its own state file was missing has failed at something more important than enforcing.

The transcript is read forward from where the last call stopped, so the cost of checking does not grow with the length of your session.

## Run the tests

```
npm test
```

## The bigger picture

The Governor is one idea applied to one resource. The idea is **Enforcer**, Instruxi's policy engine, and it asks a single question in front of every system it guards: *may this identity do this, right now?* — answered three ways, with a tamper-evident receipt for every answer. Here that identity is an AI agent and the resource is your money. **[instruxi.io](https://instruxi.io)**

## License

Functional Source License 1.1 (FSL-1.1-ALv2). Free to run on your own agents, in production, including commercially. You may not offer it as a competing commercial product or service. Becomes Apache 2.0 two years after each release. See [LICENSE](LICENSE).
