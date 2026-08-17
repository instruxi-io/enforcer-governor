# ADR 0001 — Edge persistence and receipt federation

Status: Proposed · 2026-08-17

## Context

Receipts are the product. Spend caps are commodity (the README's own comparison
table concedes this); what nothing else ships is a decision record that an
auditor can trust. Today that record has three structural weaknesses.

**It cannot survive the machine.** `receipts.jsonl` lives under
`~/.enforcer-governor/`. The hash chain detects an *edit* — change a line and
`/verify` names it. It cannot detect `rm receipts.jsonl`, which destroys the
evidence outright and leaves a perfectly valid empty chain. The strongest claim
we make is defeated by one command.

**The chain has exactly one writer, by force.** `governor.mjs:107-110` records
why: *"twelve agents deciding at once was enough to interleave the file and
break verification of a chain that was perfectly correct in memory."* Every
append therefore goes through one global promise queue. That is correct on one
machine and impossible across many — independent laptops share no previous
hash, so a naively-synced tenant-wide chain is not a chain at all.

**Everything is an O(n) file scan.** `walkReceipts` reads the whole file on
`/verify`; `/receipts.csv` reads it again; the hook re-reads the entire session
transcript on *every tool call* (~180ms on a 54MB session, per `hook.mjs:33`).
Live agent state is memory-only (`governor.mjs:63`), so a restart loses it.

What we want: receipts that outlive the laptop, a fleet view across machines,
per-client attribution good enough to bill from — and none of it on the hot
path, because the hook runs before every action and must keep working offline.

## Decisions

### 1. Local SQLite is the source of truth, not JSONL

The daemon writes receipts to a local SQLite database. Reads become indexed,
`/verify` stops scanning, agent state survives restart, and the existing
single-writer queue remains correct (it now guards a transaction rather than an
append).

```sql
CREATE TABLE receipts (
  seq         INTEGER PRIMARY KEY,     -- monotonic, per device
  ts          INTEGER NOT NULL,
  device_id   TEXT    NOT NULL,
  agent       TEXT    NOT NULL,
  operator    TEXT,                    -- v3 account id once authenticated
  client      TEXT,                    -- derived from cwd, may be guessed
  verdict     TEXT    NOT NULL,        -- allow | deny | escalate | reroute
  reason      TEXT    NOT NULL,
  rule        TEXT,                    -- capability rule name, if any
  tool        TEXT,
  model       TEXT,
  tokens      INTEGER NOT NULL DEFAULT 0,
  prev_hash   TEXT    NOT NULL,
  hash        TEXT    NOT NULL,
  shipped_at  INTEGER                  -- NULL = not yet federated
);
CREATE INDEX receipts_unshipped  ON receipts(shipped_at) WHERE shipped_at IS NULL;
CREATE INDEX receipts_ts         ON receipts(ts);
CREATE INDEX receipts_client_ts  ON receipts(client, ts);
```

`hash = sha256(prev_hash || canonical_json(entry))`, unchanged from today.
Canonicalisation must be pinned now (sorted keys, no whitespace) because the
server will recompute it.

### 2. Chains are per-device, never tenant-wide

Each install owns its own chain, keyed by a `device_id` registered against v3's
existing `device` domain. There is no cross-device chain and no distributed
lock. Cross-device *total ordering* is explicitly given up; checkpoints (below)
provide the join instead.

This is the only design that keeps the hot path free of coordination and keeps
the daemon fully functional offline.

### 3. A background shipper federates sealed segments

A **segment** is a contiguous run `[from_seq, to_seq]` plus its head hash,
signed by a device keypair minted at `login` and held in the OS keychain (or a
0600 file where no keychain exists). ADR 0002 refines key custody: keychain
binding is only tamper-meaningful when the holder is a code-signed native
binary, which is the paid tier — the free Node tier does not federate and
therefore does not sign.

The shipper runs off the hot path. `/decide` never awaits it. On ingest the
server:

1. checks `prev_hash` of `from_seq` equals the last head it holds for that
   device (continuity — a gap is a deletion),
2. verifies the device signature (authenticity of origin),
3. recomputes every hash in the segment (integrity),
4. appends and advances that device's head.

### 4. The platform signs checkpoints over device heads

Every N minutes the control plane takes all device heads for a tenant, builds a
Merkle root, signs it with the platform key, and stores it. Clients cache the
latest checkpoint covering their own head.

Verification becomes two claims instead of one: *my chain is internally
intact*, **and** *my head at time T is covered by a signature I cannot forge*.

This is how Certificate Transparency works, and it closes the hole in the
current design:

| Attack | Today | After |
|---|---|---|
| Edit a receipt | detected | detected |
| Delete a receipt | detected | detected (seq gap) |
| **Delete the whole file** | **undetectable** | **detected — server holds the head** |
| Roll back to an earlier state | undetectable | detected — checkpoint covers a later head |
| Fabricate history | undetectable | detected — no device signature, no coverage |

The checkpoint signature is also the one commercial control that cannot be
patched out of a client, since it requires a private key we hold. That is a
consequence of the design, not its motivation, but it is load-bearing for the
business model and should not be given away casually.

### 5. Turso is a candidate transport, not the source of truth

An embedded libSQL replica is an attractive shipper — local reads, background
sync, no bespoke transport. It is **not** adopted as the source of truth,
because embedded replicas are fundamentally read replicas that forward writes to
the primary, and offline write support must be verified before an enforcement
point depends on it. An agent governor that stops *recording* when the network
drops is worse than one that never synced.

The shipper interface is therefore designed so Turso can replace the custom
transport later without touching the chain design.

Note for reviewers: `enforcer-template/NOTES.md:92` ("why to avoid turso")
argues against Turso as a **Go leaf service's server-side primary**, and its
concrete trap is a CGO/musl build failure. That guidance does not reach this
case — an embedded replica on a developer's laptop, in Node, where
`@libsql/client` ships prebuilt bindings. Different problem, different verdict.

> **Resolved by ADR 0003.** Once receipts required an authenticated ingest
> endpoint (the server must verify continuity and signature *before*
> accepting), Turso became redundant as the receipt transport: local plain
> SQLite is the source of truth and one ingest endpoint carries both paths.
> Turso remains a possible later telemetry-only transport. Open question 1
> below is therefore moot unless that option is exercised.

## Invariants

- **Enforcement never depends on the network.** Offline, writes continue
  locally and the shipper queues. Unchanged from today's fail-open contract.
- **The shipper is never awaited by a decision.** No network call is added to
  the hook's critical path — it already costs ~180ms on a large transcript.
- **Server time is authoritative for checkpoint ordering**; the device `ts` is
  kept for display. Clock skew on a laptop must not reorder a tenant's history.
- **Unshipped backlog is alertable.** Rows sitting unshipped past a threshold
  mean the record is not durable, and the owner should be told.

## Migration

The existing `receipts.jsonl` imports as `seq 0..n` of that device's chain.
Receipts written before 0.11 carry no stored hash and continue to report
`unverifiable` rather than being silently upgraded — the current behaviour, kept
deliberately.

## Consequences

- Three O(n) scans disappear; `/verify` and the CSV export become indexed reads.
- Agent state can rehydrate on restart instead of resetting.
- Deleting the local database stops destroying evidence.
- A new storage dependency appears. `node:sqlite` is a builtin from Node 22 and
  matches the project's zero-dependency posture, but `package.json` currently
  declares `"node": ">=18"`; adopting it means raising the floor. The
  alternative, `better-sqlite3`, is a native module and ends the zero-dep
  property. **This is an open decision.**

## Alternatives rejected

- **Keep JSONL and ship lines.** Leaves every scan O(n) and does nothing about
  the multi-writer chain problem, which is the actual blocker.
- **One tenant-wide chain.** Needs coordination on every write and breaks
  offline operation outright.
- **Decide server-side and store centrally.** Adds a network round trip to
  every tool call and forfeits the "nothing leaves your machine" property that
  distinguishes this from every SaaS tool in the README's comparison table.

## Open questions

1. Does libSQL offline-write support meet the bar? Blocks decision 5 only.
2. `node:sqlite` (raise floor to Node 22) vs `better-sqlite3` (native dep)?
3. Checkpoint cadence — minutes buys tighter rollback detection, costs writes.
4. Retention: how long does the control plane hold receipts, per tier?
5. What does the dashboard show when the backlog is stale? Silence would imply
   durability that does not exist.
