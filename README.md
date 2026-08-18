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
/plugin install enforcer-governor@instruxi
```

That brings the enforcement: the hooks, the capability rules, and the three slash commands. `/plugin disable enforcer-governor` removes them just as cleanly. Nothing is written to your settings and there is no daemon to start.

Two pieces cannot arrive that way, because Claude Code does not let a plugin ship either one: a plugin's `settings.json` honours only the `agent` and `subagentStatusLine` keys, and everything else is ignored without a word. Both are a single paste into your own `~/.claude/settings.json`, and the governor enforces correctly without either.

**The status line**, which is the only always-on surface — the number you glance at instead of opening something:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node $HOME/.claude/plugins/marketplaces/instruxi/statusline/spend.mjs"
  }
}
```

That path is where a marketplace added from GitHub lands. If you installed from a local checkout it is your own directory instead; `claude plugin marketplace list --json` prints the exact `installLocation`.

**The permission rules**, which are belt to the hooks' braces. Copy the `permissions` block from this repo's [`settings.json`](settings.json) into yours. The plugin cannot install it, so without this paste the hooks are doing the work alone — see [How it works](#how-it-works) for exactly what that costs you, which is less than it sounds.

## What you get

**A number in your status line.** `· $3.40/$20` — live spend against the limit, always visible, no dashboard to open. It changes colour once, when something needs you. This is the one piece that needs the paste in [Install](#install).

**Capability rules that ship with the plugin.** Piping a URL into a shell is refused outright. Deleting a tree, rewriting git history, reading credentials, publishing or deploying: those stop and ask. These are capability decisions, not spend ones, so they fire on a full budget — and they are checked without reading any state at all, so they hold even when the governor cannot read its own files. Deleting the state directory turns off the spend limit; it does not turn off the rules.

**A spend limit that means dollars.** `/enforcer-governor:limit 40` sets $40 per agent. Claude prices each model at its own rate, so $40 is $40 whether the agent is on Opus 5 or Haiku 4.5. Under the hood the cap is cost-weighted effective tokens, because cached sessions re-read their whole context every turn and raw token counts explode while costing very little.

**Rate limits, not just totals.** The incidents that cost real money are rate incidents. Dollars per minute, new agents per minute, and errors per minute are each watched and each *ask* rather than block — and ask once, so an overnight run waits for you instead of dying or nagging.

**A record an audit can read.** `/enforcer-governor:verify` walks the file and names the first line that does not add up. Every receipt carries who the agent acted for, what it tried, which model answered, and which rule decided.

## Commands

| | |
|---|---|
| `/enforcer-governor:status` | spend per agent, limits, current burn, state of the record |
| `/enforcer-governor:verify` | check the chain, name the first broken line |
| `/enforcer-governor:limit <dollars>` | set the per-agent limit |
| `/enforcer-governor:resume [agent]` | run a stopped agent again, with room to finish |

### Getting out of the way

An agent stopped for **spending** is freed by raising the limit — `/enforcer-governor:limit 40` — and carries on from where it stopped. An agent stopped for **looping**, or one you stopped yourself, needs `/enforcer-governor:resume`, because a raised limit is not consent to carry on doing the same thing.

To switch the governor off without uninstalling it, put any of these in `~/.enforcer-governor/config.json`:

```json
{"budgetOn": false, "loopOn": false, "rulesOn": false}
```

`budgetOn` covers the spend and rate checks, `loopOn` the loop check, `rulesOn` the capability rules. All three off is fully inert. Do not delete `state.json` to unstick something: it holds the head of the receipt chain, so the next receipt hashes against nothing and `verify` correctly reports the record as broken.

## How it works

```
tool call ─► PreToolUse hook ─► capability rules ─► spend + rate checks
                                       │
                                       ▼
                          allow / deny / ask  ─►  hash-chained receipt
```

No daemon, no port, nothing listening. State lives in `~/.enforcer-governor/` behind a lock, so parallel tool calls land in the record in the order they were decided.

The two kinds of check fail in opposite directions, deliberately. **Spend fails open**: if the state is unreadable the hook allows the action and says in the reason line that it did not check, because a governor that blocks real work over a missing file of its own has failed at something more important than enforcing. **Capability fails closed**, because it can afford to — the rules are patterns matched against the action text and need no state, so an unreadable state directory does not reach them. A refusal decided that way is still written to the record, deliberately without a hash: there is no readable chain tail to hash against, and `verify` counts an unhashed line as unverifiable rather than as a break. Recording nothing would hide a real refusal, and forging a link would cry tampering on an honest file.

The transcript is read forward from where the last call stopped, so the cost of checking does not grow with the length of your session.

## Run the tests

```
npm test
```

## The bigger picture

The Governor is one idea applied to one resource. The idea is **Enforcer**, Instruxi's policy engine, and it asks a single question in front of every system it guards: *may this identity do this, right now?* — answered three ways, with a tamper-evident receipt for every answer. Here that identity is an AI agent and the resource is your money. **[instruxi.io](https://instruxi.io)**

## License

Functional Source License 1.1 (FSL-1.1-ALv2). Free to run on your own agents, in production, including commercially. You may not offer it as a competing commercial product or service. Becomes Apache 2.0 two years after each release. See [LICENSE](LICENSE).
