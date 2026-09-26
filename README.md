# Enforcer Governor

**A Claude Code plugin that decides whether an agent action is allowed *before* it runs — and keeps a record you can prove.**

Agents get stuck in loops, repeat work, and pipe the internet into a shell. Every other tool reports the damage afterwards. This one answers a question first:

> **May this agent do this, right now?**

- **allow** — in budget and on task, carry on
- **rewrite** — run it, in a form the policy accepts
- **deny** — over budget, looping, or not permitted at all
- **ask** — pause and check with you

Every decision is appended to a hash-chained record. Edit or delete a single line and the chain visibly breaks. Until you sign in to an Enforcer workspace, everything stays on your machine — see [What leaves your machine](#what-leaves-your-machine).

## Install

```
/plugin marketplace add instruxi-io/claude-plugins
/plugin install enforcer@instruxi
/plugin install enforcer-governor@instruxi
```

Then restart Claude Code and sign in once with `/enforcer:login`. The `enforcer` plugin is the connection to your Enforcer workspace (its MCP server and the sign-in); the governor works without it, deciding and recording locally, but has no tenant policy to ask and nowhere to send receipts.

The governor brings the enforcement: the hooks, the capability rules, and the eight slash commands. `/plugin disable enforcer-governor` removes them just as cleanly. There is no daemon to start. The governor keeps its own state under `~/.enforcer-governor/` and a small shared file under `~/.enforcer/`; it writes to your `~/.claude/settings.json` only when you ask it to, with `/enforcer-governor:telemetry on`.

Two pieces cannot arrive that way, because Claude Code does not let a plugin ship either one: a plugin's `settings.json` honours only the `agent` and `subagentStatusLine` keys, and everything else is ignored without a word. Both are a single paste into your own `~/.claude/settings.json`, and the governor enforces correctly without either.

**The status line**, which is the only always-on surface — the number you glance at instead of opening something:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$(cat \"$HOME/.enforcer/plugin-root\")/statusline/spend.mjs\""
  }
}
```

The plugin's install directory changes with every version, so the status line does not name it: the governor records where it is running from in `~/.enforcer/plugin-root` at every session start, and the command follows that. Until the first session after installing, it prints nothing.

**The permission rules**, which are belt to the hooks' braces. Copy the `permissions` block from this repo's [`settings.json`](settings.json) into yours. The plugin cannot install it, so without this paste the hooks are doing the work alone — see [How it works](#how-it-works) for exactly what that costs you, which is less than it sounds.

## What you get

**A number in your status line, which is also where the money figure comes from.** `· $3.40/$20` — live spend against the limit, always visible, no dashboard to open. It changes colour once, when something needs you.

It has a second job. Claude Code hands its own `total_cost_usd` to the status line and **only** to the status line — the hooks never see it. That figure can be computed at an organisation's contracted rates, so it beats anything a third-party price table can know. The status line records it and the gate reads it back on the next tool call. Without the paste in [Install](#install) the governor still enforces; it just meters from the transcript instead, and every receipt says which of the two answered.

**Capability rules that ship with the plugin.** Piping a URL into a shell is refused outright. Deleting a tree, rewriting git history, reading credentials, publishing or deploying: those stop and ask. These are capability decisions, not spend ones, so they fire on a full budget — and they are checked without reading any state at all, so they hold even when the governor cannot read its own files. Deleting the state directory turns off the spend limit; it does not turn off the rules.

**Your organisation's policy, not just ours.** Sign in once with `/enforcer:login` and the rules above stop being the same six patterns for everyone. When a rule matches, the governor asks your Enforcer tenant policy about it: a resource of type `agent_action` whose id names the rule (`fs.delete_tree`, `deploy.publish`, `git.force_push`, `git.rewrite_history`, `secrets.access`, `shell.pipe_to_shell`). The policy is Rego, versioned, tested before it can go live, and rolled back by activating the previous version, so "agents here never delete a whole tree" or "publishing needs a person" is one change for the whole team.

Its answer composes with the local rule, and the direction matters:

| | local deny | local ask | local rewrite |
|---|---|---|---|
| **policy deny** | deny | deny, in the policy's words | deny |
| **policy `ask:` reason** | deny | ask, in the policy's words | ask |
| **policy allow** | deny | no objection | rewrite |
| **no rule / unreachable** | deny | ask | rewrite |

A policy can make anything stricter and can waive a confirmation. It cannot lift a hard deny (`curl | sh` stays refused), and it cannot skip a rewrite. If Enforcer is slow, down, or you are signed out, the local rule decides alone, so losing the network never allows more. Only a matched command is asked about; ordinary tool calls never wait on the network. Answers are reused for `policyTtlSec` (30s), which is also how quickly a new policy version reaches each machine.

```rego
declared_types := ["agent_action"]

allow if { input.resource_type == "agent_action" }   # declared, so silence would deny

deny contains "agents in this tenant do not delete whole directory trees" if {
	input.resource_type == "agent_action"
	input.resource.id == "fs.delete_tree"
}

deny contains "ask: publishing from an agent needs a person to confirm" if {
	input.resource_type == "agent_action"
	input.resource.id == "deploy.publish"
}
```

**One sign-in for the governor and the Enforcer MCP server.** The MCP server comes with the `enforcer` plugin from the same marketplace (`/plugin install enforcer@instruxi`), not with the governor; until 2.6.0 the governor shipped its own copy. Both read the same credential, `~/.enforcer/credentials.json` (0600), so `/enforcer:login` and `/enforcer-governor:login` are the same sign-in: sign in once and both are signed in, sign out once and both stop sending a credential.

**A spend limit that means dollars.** `/enforcer-governor:limit 40` sets $40 per agent. Claude prices each model at its own rate, so $40 is $40 whether the agent is on Opus 5 or Haiku 4.5. Where the harness figure is unavailable the cap falls back to cost-weighted effective tokens, because cached sessions re-read their whole context every turn and raw token counts explode while costing very little.

**A word to the agent, not just to you.** An agent that learns it is near the limit can land what it has instead of opening a new front. At roughly two thirds of the budget it is told once — one sentence, at the turn boundary, where it can still change its plan — and then the governor goes quiet until the situation changes. Warning at the limit itself is too late: the turn is already committed. Every word costs, because it joins the cached prefix and is billed on every later turn, which is why it is one sentence and why it is said once.

**A safer command instead of a refused one.** Some actions have a form that keeps the intent and drops the footgun. `git push --force` becomes `git push --force-with-lease`, which refuses only when someone else has pushed since your last fetch — the case that loses work. The rewrite is announced and recorded; a governor that edits commands silently would be an invisible actor in your transcript.

**Rate limits, not just totals.** The incidents that cost real money are rate incidents. Dollars per minute, new agents per minute, and errors per minute are each watched and each *ask* rather than block — and ask once, so an overnight run waits for you instead of dying or nagging.

**A record an audit can read.** `/enforcer-governor:verify` walks the file and names the first line that does not add up. Every receipt carries who the agent acted for, what it tried, which model answered, and which rule decided.

## Commands

| | |
|---|---|
| `/enforcer-governor:status` | spend per agent, limits, current burn, state of the record |
| `/enforcer-governor:verify` | check the chain, name the first broken line |
| `/enforcer-governor:limit <dollars>` | set the per-agent limit |
| `/enforcer-governor:resume [agent]` | run a stopped agent again, with room to finish |
| `/enforcer-governor:config [--why]` | every setting, what it does, and which you have changed |
| `/enforcer-governor:set <name> <value>` | change one, with validation |
| `/enforcer-governor:login [<WORKSPACE-CODE> \| api-key <key> \| status \| logout]` | sign in to Enforcer, the same sign-in as `/enforcer:login`; no argument opens a browser, a workspace code skips asking for it |
| `/enforcer-governor:telemetry [on \| off \| status]` | send Claude Code's own OpenTelemetry (cost, tokens, tool use — never prompt text) to your Enforcer workspace; writes the `OTEL_*` exporter settings into `~/.claude/settings.json` |

### Getting out of the way

An agent stopped for **spending** is freed by raising the limit — `/enforcer-governor:limit 40` — and carries on from where it stopped. An agent stopped for **looping**, or one you stopped yourself, needs `/enforcer-governor:resume`, because a raised limit is not consent to carry on doing the same thing.

To switch the governor off without uninstalling it, put any of these in `~/.enforcer-governor/config.json`:

```json
{"budgetOn": false, "loopOn": false, "rulesOn": false}
```

`budgetOn` covers the spend and rate checks, `loopOn` the loop check, `rulesOn` the capability rules. The three are independent: turning spend tracking off leaves `curl | sh` and `rm -rf` still guarded. All three off is fully inert — **unless your organisation publishes a floor**, below. Do not delete `state.json` to unstick something: it holds the head of the receipt chain, so the next receipt hashes against nothing and `verify` correctly reports the record as broken.

### Settings your organisation sets

An Enforcer tenant can publish a set of these settings for every install it signs in (`GET /api/v1/governance/settings`, written by a tenant admin). They are a **floor, not an override**: for each setting the governor applies whichever of the two is stricter, so a managed $150 beats your $400 and your $40 beats both, and a check the organisation turns on cannot be turned off locally. `/enforcer-governor:config` marks them with `!` and shows your own value beside them.

Nothing waits on the network to decide: the settings are fetched at session start, at most hourly, and cached. A machine that is signed out, or has never reached the control plane, runs on its own config alone. Identity settings (`centralUrl`, `ingestUrl`, `operator`) cannot be managed — being able to repoint an install is being able to redirect its receipts.

## What leaves your machine

Nothing, until you sign in. The governor decides and records locally, and a machine that has never signed in (`/enforcer:login`) makes no network calls at all.

Once you sign in to an Enforcer workspace, three things can leave, and each has its own switch:

| what | when | switch |
|---|---|---|
| **Decision receipts** — the verdict, the rule that fired, the tool name, the model, token counts, a project name derived from the working directory, the `operator` you set, and which harness decided (`claude-code`) with its adapter version. Never the command text, never file contents, never prompts. | shipped in the background after each session, to your workspace's governance API | `shipOn` (default on) |
| **Your organisation's policy answers** — for an action a local rule matched, the governor asks your workspace whether to allow, ask or deny. The request names the rule, not the command. | only when a rule matches | `policyOn` (default on) |
| **Claude Code's own telemetry** — cost, tokens and tool-use metrics from Claude Code's built-in OpenTelemetry exporter. Prompt text is not exported. | only if you turn it on | `/enforcer-governor:telemetry on` (default off) |

Everything goes to the workspace you signed in to and nowhere else. `/enforcer:login logout` (or `/enforcer-governor:login logout`, the same command) stops all three on this machine; what has already been sent stays in your workspace's records, which is the point of a record.

Files the governor writes: `~/.enforcer-governor/` (config, state, the receipt chain, per-session scratch that is swept after `sweepDays`), `~/.enforcer/credentials.json` (your sign-in) and `~/.enforcer/plugin-root` (where the installed plugin lives, so telemetry stays signed in across plugin updates).

## How it works

```
prompt  ─► UserPromptSubmit ─► a word to the agent, if the situation changed

                         ┌─ capability rules ─── no state, FAILS CLOSED
                         │     └─ matched? ask your tenant policy (Enforcer)
tool call ─► PreToolUse ─┤         unreachable leaves the local rule in place
                         └─ spend + rate ─────── needs state, FAILS OPEN
                                   │
                                   ▼
             allow / deny / ask / rewrite  ─►  hash-chained receipt

result  ─► PostToolUse ─► what actually happened (errors feed the retry check)
subagent─► SubagentStart ─► fan-out, counted rather than inferred
```

Seven hooks, no daemon, no port, nothing listening. State lives in `~/.enforcer-governor/` behind a lock, so parallel tool calls land in the record in the order they were decided.

That split is the architecture, and the two halves fail in opposite directions on purpose. **Spend fails open**: if the state is unreadable the hook allows the action and says in the reason line that it did not check, because a governor that blocks real work over a missing file of its own has failed at something more important than enforcing. **Capability fails closed**, because it can afford to — the rules are patterns matched against the action text and need no state, so an unreadable state directory does not reach them. A refusal decided that way is still written to the record, deliberately without a hash: there is no readable chain tail to hash against, and `verify` counts an unhashed line as unverifiable rather than as a break. Recording nothing would hide a real refusal, and forging a link would cry tampering on an honest file.

The transcript is read forward from where the last call stopped, so the cost of checking does not grow with the length of your session.

## Run the tests

```
npm test
```

## The bigger picture

The Governor is one idea applied to one resource. The idea is **Enforcer**, Instruxi's policy engine, and it asks a single question in front of every system it guards: *may this identity do this, right now?* — answered three ways, with a tamper-evident receipt for every answer. Here that identity is an AI agent and the resource is your money. **[instruxi.io](https://instruxi.io)**

## License

Functional Source License 1.1 (FSL-1.1-ALv2). Free to run on your own agents, in production, including commercially. You may not offer it as a competing commercial product or service. Becomes Apache 2.0 two years after each release. See [LICENSE](LICENSE).
