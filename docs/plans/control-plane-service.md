# Plan — `enforcer-governor` control-plane service

Status: Proposed · 2026-08-17

The new Go leaf service. Scaffolded from `enforcer-template`; read its
`PLATFORM.md` first (identity is enforcer-v3's, the three composed
authorization gates, the RLS rules that make the shared DB safe — several are
the opposite of the obvious choice).

Design context: `docs/adr/0001` (per-device chains, checkpoints), `0002` (the
edge agent), `0003` (transport and tenancy). What v3 must add:
`enforcer-v3/docs/plans/governor-integration.md`.

## Position in the platform

A platform leaf service. **`enforcer-checkin` is the reference implementation to
copy** — it is the closest existing sibling: Ed25519 device signatures verified
against v3's device registry, its own Postgres, and the same federation set. Its
`internal/platform/authz` is copied verbatim between services; do the same
rather than re-deriving.

- `ResolveUser` from v3 (authn + accessor) — the one call per request
- **Embedded OPA over its own tables** for row scoping (`engine.Filter`)
- Its own Postgres (`enforcer_governor`) — **no FKs into v3's tables**; identity
  is plain UUID columns resolved via `DirectoryService` at read time
- Its own gRPC/HTTP surface for the edge agent and the dashboard

It does **not** call v3 `Authorize` for its own resources, and v3 learns nothing
of its schema.

Follow checkin's operational conventions: `GOVERNOR_*` env prefix, and
**nil-safe service-key clients** — an unset key or address disables that feature
and the boot log says so, rather than failing to start.

## Schema

Every table carries `tenant_id UUID NOT NULL` as a **plain column, not a foreign
key** (there is no `tenants` table in this database — that contract is for
tables inside v3), partial unique indexes `WHERE deleted_at IS NULL`, and
registers with the authz engine per the template's table-mapping step.

Use the template's migration runner with checksum drift detection. Do **not**
AutoMigrate — `enforcer-checkin` predates the template shipping a db layer and
AutoMigrates on boot; `enforcer-template/NOTES.md` §3 is the current guidance and
says nothing may generate or sync the schema.

| Table | Class | Notes |
|---|---|---|
| `agents` | owner-scoped | one row per governed agent session; `account_id` is the operator |
| `devices` | owner-scoped | mirrors a v3 `signing` device by id; holds the chain head and last-seen |
| `receipts` | owner-scoped | per-device chain: `(device_id, seq)` PK, `prev_hash`, `hash`, verdict, rule, tool, model, tokens, client |
| `checkpoints` | admin-managed | signed Merkle root over all device heads for a tenant, plus signature and covered heads |
| `clients` | owner-scoped | directory-prefix → client name, and per-client monthly caps |
| `approvals` | owner-scoped | escalations: `pending → approved \| denied \| expired`, with decider and decided_at |
| `subscriptions` | admin-managed | plan, seat count, status; fed by enforcer-stripe events |
| `policy_bundles` | admin-managed | compiled Rego cached by `source_sha` from v3 |

`receipts` is append-only at the application layer — no update path, ever.
Ingest writes and nothing else does.

## Endpoints

Prefix `/api/v1/governor`. Three audiences, three auth modes.

### Edge agent — device credential

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/devices/register` | Register this install; body carries the v3 `signing` device id and public key. **Authenticated with the user's v3 credential** (the pasted API key from `login`) — this is the one call made as the user; it mints the device credential every later edge call presents. Returns `device_id`, seat status. |
| `POST` | `/session/bootstrap` | **The important one.** Given the device credential, returns: the accessor (from `ResolveUser`), a short-lived entitlement JWT, the compiled policy bundle + its `source_sha`, the tenant's client mappings and limits, and the server's current head for this device. One call, everything the edge needs for a session. |
| `POST` | `/receipts` | Signed segment ingest. Verifies continuity (`prev_hash` == held head), device signature, and recomputes every hash before appending. Returns the new head. |
| `POST` | `/telemetry` | Batched, lossy-tolerant. Separate endpoint so it can be rate-limited and dropped independently of receipts. |
| `GET` | `/checkpoints/latest` | The signed Merkle root covering this device's head. |
| `GET` | `/policy?sha=<current>` | 304 when unchanged; new bundle when the tenant edits policy mid-session. |

`/session/bootstrap` is what makes ADR 0002's "serve the policy, don't
centralise the decision" concrete — one round trip at session start, then the
edge is autonomous and offline-capable.

### Dashboard — end-user JWT

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/fleet` | Aggregates: spend, burn, active agents, open incidents. **Default view.** |
| `GET` | `/agents` | List, `engine.Filter`-scoped |
| `GET` | `/clients` | Per-client spend and cap status |
| `GET` | `/incidents` | Denials, escalations, rate breaches |
| `GET` | `/agents/{id}/receipts` | Session detail. Per ADR 0003 §5 this is drill-down, not a live feed — writes an audit event when read. |
| `GET` | `/verify` | Walk a tenant's chains; name the first break |
| `GET` | `/export.csv` | Billing-grade export, client as the first column |
| `POST` | `/approvals/{id}/resolve` | Approve or deny an escalation — the third verb, resolved by someone other than the developer being stopped |
| `GET`/`PATCH` | `/config` | Owner console: limits and switches, per tenant |

### Internal — service key

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/internal/subscriptions` | enforcer-stripe posts subscription state changes |

## Dependencies

| On | Surface | For |
|---|---|---|
| enforcer-v3 | `AuthzService.ResolveUser` (gRPC) | Federated identity on every authed request |
| enforcer-v3 | `DirectoryService` (gRPC, service key) | Account/person display data for the dashboard — no FKs, resolved at read time |
| enforcer-v3 | `DeviceService` (gRPC, service key) | Register the agent's `governor_signing` device; fetch public keys to verify segments. **Same call checkin makes.** |
| enforcer-v3 | policy fetch (`kind=governor`) | Bundles for session bootstrap — the one genuinely new v3 endpoint |
| enforcer-v3 | group-membership write | `governor_pro` entitlement flag |
| **enforcer-kv** | `SetNX` fail-closed; `IncrementEx` fail-open | **Fleet-wide rate windows** (see below) and bootstrap-nonce replay guard |
| **enforcer-mb** | `MessageBusService.Publish` | `email.send` / `sms.send` — **escalation notifications** (see below) |
| enforcer-stripe | webhook → `/internal/subscriptions` | Subscription lifecycle → entitlement (greenfield — still an unmodified `enforcer-template` copy) |
| enforcer-hooks | Orval from swagger | `@instruxi-io/governor-hooks` for the dashboard |

### enforcer-kv closes a real gap: fleet-wide rate limits

`fleetBurnLimit` ($10/min across every agent) works today only because one
daemon sees every agent **on one machine**. Across a fleet of laptops no edge
can compute the tenant total — the limit silently stops meaning what it says the
moment there is a second machine.

`IncrementEx` windows are the mechanism, and checkin already uses them exactly
this way (fail-open, so a kv outage never blocks work). Per-agent burn stays
local and instant; fleet burn becomes a kv counter the edge increments and
reads. Note the consequence honestly: fleet limits acquire kv's latency and
fail-open semantics, so they are a *fleet-scale backstop*, not a hard per-action
gate. Per-device limits remain the tight control.

### enforcer-mb closes another: nobody is told an agent is waiting

ADR 0003 and the free/paid split both promise escalation routed to an admin
rather than self-approval. An escalation that reaches no one is worse than no
escalation — the agent stalls and the developer's only route out is to disable
the governor. `MessageBusService.Publish` with `email.send` / `sms.send`, via the
tenant's own SendGrid/Twilio, is the existing path. Notification is part of the
approvals feature, not a follow-up to it.

**Replay protection for `/receipts` needs no nonce** — chain continuity already
provides it. A replayed segment's `from_seq` is behind the head the server
holds, so it is rejected by the same check that catches deletions. Use kv's
`SetNX` guard on `/session/bootstrap` instead, where there is no chain to lean
on.

## Things to get right

**Ingest is the trust boundary.** The edge is a client the customer controls.
Verify continuity, signature, and every hash at ingest — never trust a supplied
head. A rejected segment is an incident, not a 500.

**Checkpoint signing key is the crown jewel.** It is the one thing a patched
client cannot forge, and therefore the thing the paid tier actually rests on.
KMS or equivalent; never in config.

**Seats are `(tenant, device)`, not devices.** v3 devices are person-scoped and
survive tenant switches — one laptop working for two tenants is one device and
two seats. Decide this in the pricing copy, not in an incident.

**Aggregate by default.** ADR 0003 §5 — the dashboard observes agents, clients,
and fleets. Individual session detail is an audited action, not a live feed.

**Estimates stay labelled.** Governor figures are list-price estimates
(`policy.mjs:34-38` records the episode where Sonnet 5 was priced 1.5× reality).
Fine for enforcement, not for invoicing. Carry the `est.` label through every
API response and the CSV export, or a customer will bill from it.

## Build order

1. Scaffold from `enforcer-template`; register `agents`, `receipts`, `devices`
   in `di/injector.go`; `ResolveUser` wired.
2. `/devices/register` + `/receipts` + chain verification. The evidentiary core.
3. `/session/bootstrap` + `/policy`, once v3 ships `policies.kind` (§1 of the v3
   plan).
4. Checkpoint signing + `/verify`.
5. Dashboard reads.
6. Subscriptions, seats, entitlement JWT.
7. Approvals **plus mb notification** — one feature, not two.
8. Fleet rate windows via kv, once more than one device per tenant is real.

Steps 1–4 are the product. Everything after is commercial surface.
