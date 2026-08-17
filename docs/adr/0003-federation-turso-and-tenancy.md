# ADR 0003 — Federation transport, Turso, and tenancy

Status: Proposed · 2026-08-17 · Depends on [ADR 0001](./0001-edge-persistence-and-receipt-federation.md), [ADR 0002](./0002-edge-agent-rust-and-policy-runtime.md)

## Context

ADR 0001 establishes per-device chains, a local source of truth, and a
background shipper. This ADR decides how data actually crosses the wire, where
it lands, and how it is isolated per tenant.

The proposed shape was: edge writes a local Turso database, which syncs to a
parent Turso database, which the control plane sits on top of and governs. That
is right in outline. Three things about it need deciding rather than assuming.

## Decisions

### 1. Two paths, not one — and they have different trust models

**Receipts and telemetry are not the same kind of data and must not share a
transport.**

| | Receipts | Telemetry |
|---|---|---|
| Purpose | Evidence — the product | Observability |
| Loss tolerance | None | Lossy by design |
| Forgery tolerance | None | Low stakes |
| Transport | Signed segments over an authenticated ingest endpoint | Same endpoint, batched and drop-tolerant (Turso later if volume justifies it — see 3) |
| Destination | Control-plane Postgres | Control-plane Postgres |

**Receipts require an authenticated append-only ingest path**, because the
server must *validate* each segment before accepting it — continuity
(`prev_hash` matches the head it holds for that device) and device signature.
Those are checks the server performs. It cannot perform them if the client
writes directly into the destination table.

This rules out the direct edge→parent-database write in the original sketch, on
a concrete ground rather than a stylistic one: **it would give every
developer's laptop a write credential to the tenant's database.** A compromised
machine could then write arbitrary rows, including rows attributed to other
devices — destroying exactly the property the per-device chain exists to
provide. An ingest endpoint means a device can only ever append its own chain,
and the server proves it.

### 2. Never call receipts "telemetry"

Naming has teeth here. enforcer-v3's `internal/domain/telemetry` is a **capped
diagnostics ring** — `MaxField 512`, `MaxContextFields 16`, `UserRingLimit 20`,
`TenantFeedLimit 100`, `Retention 30d`. It is engineered to drop data. Anything
routed there inherits those semantics.

Three distinct durability contracts, deliberately kept apart:

- **Agent state** (budgets, windows, flags) — must be durable or limits are
  bypassable. See the bug in Consequences below.
- **Receipts** — must be complete and tamper-evident.
- **Telemetry** — may be sampled, capped, and aged out.

### 3. Turso is optional, and probably redundant

Assessed honestly, because the answer changed once decision 1 was settled.

**Where Turso genuinely helps:** a local-first store with automatic replication
and no sync code to own, and database-per-tenant isolation as a first-class
model rather than a predicate.

**Why it is largely redundant here:** we are building an authenticated ingest
endpoint anyway, for receipts, because they must be validated at the boundary.
Once that exists, the marginal cost of shipping telemetry through the same
endpoint is close to zero — and the local store can be plain SQLite (via
`libsql` or `rusqlite`), which the edge needs regardless.

**Three costs Turso adds:**

1. **An unresolved offline-write question.** Embedded replicas are fundamentally
   read replicas that forward writes to the primary. An enforcement point that
   stops *recording* when the network drops is worse than one that never
   synced. This must be verified before anything depends on it.
2. **A tenancy model that conflicts with the platform's.** See decision 4.
3. **A vendor, in the transport layer, for a capability we are building anyway.**

**Decision: local plain SQLite as the source of truth, one authenticated ingest
endpoint, control-plane Postgres as the destination.** The shipper sits behind
an interface, so Turso can be adopted later as a telemetry transport without
touching the chain design or the ingest contract. Revisit if telemetry volume
makes bulk sync materially cheaper than the endpoint.

### 4. Tenancy: the platform's RLS story does not reach SQLite

Easy to miss and expensive to discover late. enforcer-v3's multi-tenancy
contract is **Postgres-specific**: `tenant_id` on every row, OPA partial
evaluation compiling to a SQL `WHERE` clause, and — per
`enforcer-template/PLATFORM.md` §3 — `FORCE ROW LEVEL SECURITY`, a non-superuser
non-owner role, and `set_config` GUCs. None of that exists in SQLite or libSQL.

Consequences:

- **The control plane stores receipts in Postgres**, where the platform's RLS
  contract applies unchanged and `engine.Filter` does the work it was built for.
  This is the main reason Postgres wins over Turso for the evidentiary path.
- **If Turso is ever adopted for telemetry**, isolation must be
  database-per-tenant (Turso's actual design centre), not a predicate — and that
  divergence from the platform contract gets recorded here so the next service
  does not copy it blindly.

### 5. The unit of observation is the agent, not the developer

A scoping decision, made deliberately, because the data makes the other option
available.

The hook payload already carries the developer's work product. `hook.mjs:95`:

```js
const action = `${ev.tool_name}:${JSON.stringify(ev.tool_input ?? '').slice(0, 200)}`;
```

For `Edit` and `Write`, `tool_input` **is source code**. Add `cwd` and the task
prompt scraped from the transcript, and a naive dashboard becomes continuous
per-person monitoring of engineering work.

**The product observes agents, sessions, and clients. It aggregates by default.
Individual drill-down exists for incident response, not as a live feed.**

Three reasons this is an engineering decision and not a preference:

1. **Procurement.** Continuous individual-level monitoring of employees is
   generally not covered by legitimate interest under GDPR, and in Germany a
   works council holds co-determination rights over any system capable of
   monitoring performance. A "watch your developers" framing invites that
   review; an agent-governance framing largely does not.
2. **Uninstall risk.** `npx enforcer-governor uninstall-hook` is one command.
   A tool experienced as surveillance is removed, and the dataset goes to zero.
3. **It contradicts the free tier's promise.** "Everything runs on your own
   computer. Nothing is sent to us, ever." A fleet product is legitimate, but
   not under that sentence and not to that reader.

Concretely: default every dashboard view to agent/client/fleet aggregates;
require an explicit, audited action to view one person's session detail; and
make **what is captured** configurable per tenant, with command and file
contents redactable at the edge before they ever ship.

## The flow

```
Claude Code session
  └─ hook ─► local agent
               ├─ Layer A: served Rego, evaluated in-process, no state
               ├─ Layer B: local SQLite — agent state + receipts (per-device chain)
               │
               ├─ receipts ──► signed segments ──► POST /receipts (authenticated)
               │                                     └─ verify continuity + signature
               └─ telemetry ─► same endpoint, batched, lossy-tolerant
                                                      │
                                       control plane (Postgres, v3 RLS contract)
                                          ├─ ResolveUser ──► enforcer-v3
                                          ├─ policy bundles ──► v3 policies table
                                          └─ checkpoints: signed Merkle roots over device heads
                                                      │
                                       fleet dashboard: agents · clients · incidents
```

## Completeness is a server-side problem

ADR 0002 secures the *integrity* of what a device reports. It does nothing about
a device that reports nothing at all. Three server-side controls, none of which
a client patch can defeat:

1. **Sequence continuity.** Per-device monotonic `seq` means suppressed reports
   leave a gap the server can see. Strongest control, and already in ADR 0001's
   schema at no extra cost.
2. **Heartbeat.** A registered device that stops shipping is a visible state,
   not an absence.
3. **Provider reconciliation.** If the org's provider usage report shows $4,000
   for the month and governed receipts account for $1,500, $2,500 of agent
   activity bypassed the governor. This is the only control that catches "they
   never ran it," and it is worth building for that reason alone. Note the
   provider usage APIs are org-scoped, admin-key-gated, aggregated and delayed —
   **verify the exact endpoints and whether a read-only admin scope exists
   before designing around them.**

## Consequences

- One transport to build and operate, not two.
- Receipts land in Postgres, so the platform's RLS contract and `engine.Filter`
  apply unchanged — no bespoke tenancy code for the evidentiary path.
- Turso stays available as a later telemetry optimisation without a redesign.
- **Fixes a live bug.** `governor.mjs:63` is `makeState()`, and only
  `state.periods` is restored at boot. Per-agent spend lives in memory alone, so
  restarting the daemon gives every agent a fresh budget — an agent stopped for
  hitting its cap is released by Ctrl+C. Durable local state closes this.

## Open questions

1. Retention per tier for receipts, and what the free tier gets.
2. Redaction defaults: is `tool_input` captured at all by default, or opt-in?
3. Does telemetry volume ever justify reintroducing bulk sync?
4. Where do escalation approvals live — see the service spec; governor-side
   initially, with a proposal to promote a generic `approval` domain to v3.
