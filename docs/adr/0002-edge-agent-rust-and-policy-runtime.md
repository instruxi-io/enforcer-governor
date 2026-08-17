# ADR 0002 — The edge agent: Rust, signed, and what it owns

Status: Proposed · 2026-08-17 · Depends on [ADR 0001](./0001-edge-persistence-and-receipt-federation.md)

## Context

ADR 0001 makes the local record durable and federated. This ADR decides what
the local process *is*.

Today it is seven `.mjs` files shipped as source (`package.json` `files:
["src", ...]`), with no build step. Three properties follow from that, and two
of them are problems:

1. **No signing-key custody.** ADR 0001's federation rests on a per-device
   signature the server verifies. In Node the key can live in a file or an OS
   keychain, but the keychain's registered application is `node` — a generic
   interpreter. The OS cannot distinguish our code from any other script the
   user runs, so it cannot protect the key from a modified client.
2. **Policy is hardcoded.** `DEFAULT_RULES` (`policy.mjs:124`) is a JS array. A
   tenant cannot author rules and the platform cannot distribute them.
3. **Zero-friction install.** `npx enforcer-governor start` and nothing else.
   This one is worth preserving.

## Decisions

### 1. Split `decide()` into a stateless layer and a stateful layer

This is the prerequisite for everything else, and it is worth doing even if
nothing below ships.

| Layer | Contents | Shape |
|---|---|---|
| **A — capability** | `curl \| sh`, `rm -rf`, git history rewrite, credential reads, deploys | Pure function of (accessor, action). No state. |
| **B — economics** | budget, burn rate, fan-out, retry storms, loop detection, period caps, reroute-once | Requires accumulation: running totals, sliding windows, flags. |

Layer A is the security-critical half and needs no storage. Layer B is
irreducibly stateful — Rego is a pure function of `(input, data)` and can
*decide* on scalars, but cannot *accumulate* them. The host meters; the policy
decides.

Today the two are fused, so the half that must never fail open inherits the
fragility of the half that must persist state.

### 2. Layer A becomes a served policy, evaluated locally

The tenant's Rego is fetched once per session from the control plane and
evaluated in-process. No network call per decision, no persistence, works
offline for the life of the cached bundle.

This is exactly the ADR 0001 federation model applied to the edge: **distribute
the policy, never centralise the decision.** A per-decision call to an authz
endpoint is rejected for the same reasons enforcer-v3's own ADR 0001 rejects it
— it recouples the platform, and it puts a network round trip in front of every
tool call on a path that fails open.

Input contract:

```
input = {
  accessor: { account, person, tenant, role, groups },   // from ResolveUser
  event:    { tool, command, cwd, client },
  spend:    { effective_tokens, budget, fraction },      // host accumulates
  rates:    { burn, fleet_burn, spawns, errors },        // host's ring buffers
  repeat:   3,
}
→ { verdict: "allow" | "deny" | "escalate", rule, reason }
```

Everything on the left the host already holds in `state`.

### 3. The paid edge agent is a code-signed native binary

Not for obfuscation — obfuscation buys hours. For **signing-key custody**, which
is a property only a signed binary can have:

- **macOS Keychain ACLs** bind an item to a specific signed application
  identity. Patch the binary, the signature breaks, the OS denies the key.
- **Windows DPAPI** plus signed-binary checks gives a comparable story.

The chain is: tamper → signature invalid → OS refuses the signing key → the
client cannot produce verifiable segments → the server rejects its data. **No
step in that chain is our code checking itself**, which is what separates it
from DRM.

Known limits, to be stated in the product rather than discovered:

- **Linux has no equivalent binding.** The Linux edge falls back to file
  permissions — i.e. the Node situation. Do not claim otherwise.
- **Root defeats it.** Admin on your own machine routes around most of this.
- **It protects integrity, not completeness.** A tampered client cannot forge;
  a client that is simply never run reports nothing. Completeness is a
  server-side problem (ADR 0003, sequence continuity).

### 4. Rust, with Regorus for policy

**Rust** for the native agent. The deciding factor is not performance:

- Signing-key custody per decision 3 requires a signed native binary.
- **libSQL, SQLite, and Regorus are all first-party Rust with no FFI.** The
  CGO/musl trap documented in `enforcer-template/NOTES.md:113` — `go-libsql` is
  `//go:build cgo`, links a native lib, fails on alpine with CGO off, cost a CI
  run — simply does not exist here. The three things the edge needs are the
  three things Rust does cleanly.

**Regorus** (Rego interpreter in Rust) rather than compiling the policy with
`opa build -t wasm` and embedding a WASM runtime. It evaluates Rego natively,
removes a build step and a runtime layer, and itself targets WASM if a JS edge
is ever needed.

**Verify builtin coverage before authoring the policy.** Neither Regorus nor
OPA's WASM target implements every Rego builtin, and our capability rules are
regex-based — precisely where coverage gaps have historically been. Write to
the supported subset from day one; discovering the gap at port time is
expensive.

### 5. The Node package stays as the free tier

`npx enforcer-governor start` continues to work, unchanged, forever. It keeps
the OSS on-ramp, and the free tier does not need signing-key custody because it
does not federate: its receipts are local evidence for the owner's own use,
never a signed artifact the server vouches for.

Optional intermediate shape if the native binary's distribution cost bites
first: **Rust core compiled to WASM, Node host.** Keeps `npx`, moves `decide()`
and its state machine into an opaque module, embeds Regorus inside it. This
raises the cost of patching (bytecode, not source) but does **not** give
signing-key custody — the host still controls the imports and can decline to
call the module. Treat it as friction, not a boundary.

### 6. The hook contract is language-agnostic — this constrains nothing

Worth recording because it is easy to assume otherwise. A Claude Code hook is a
command that reads JSON on stdin and writes JSON on stdout. `install.mjs:23`
happens to emit `node "${HOOK}"`; it can equally emit a path to a binary. The
whole contract — read stdin, emit `hookSpecificOutput`, exit 0 — is about
thirty lines in any language.

## The parity test this forces

The control plane is Go with the embedded `authz` package (OPA). The edge is
Regorus. **Two Rego implementations, one policy — they can disagree.**

enforcer-v3 already knows this failure mode: `TestFilterDecisionParity` exists
because two evaluation paths must never diverge. We need the analogue — a
corpus of `(policy, input) → expected verdict` cases run through **every engine
in use** in CI (during the transition that is three: Go OPA on the server,
`opa-wasm` on the Node edge, Regorus on the Rust edge). Without it, a tenant tightens a rule, the server says deny, the edge says
allow, and nobody learns until an audit.

Author the Rego to the **intersection** of what both engines support. That
constraint is cheap now and expensive later.

## Sequencing

1. Split `decide()` along the A/B seam, in the existing Node code. Self-contained,
   no new dependencies, and it is the prerequisite for the rest.
2. Move Layer A's rules into Rego; evaluate via `@open-policy-agent/opa-wasm` in
   Node. Proves the policy path end to end at low cost.
3. Stand up the engine-parity corpus in CI.
4. Build the Rust agent for the paid tier: Regorus, libSQL, code signing,
   keychain-bound device key.

Steps 1–3 ship value on the free tier and de-risk step 4.

## Consequences

- Two edge implementations to keep in step. The parity corpus is what makes
  that tractable; without it, do not build the second one.
- Native distribution: per-platform builds, code-signing certificates
  (Apple Developer ID, Windows Authenticode), notarisation on macOS, and an
  update mechanism. This is real recurring work, not a one-off.
- The free and paid tiers diverge in language. Keep the *policy* identical
  between them — that is the whole point of serving it.
