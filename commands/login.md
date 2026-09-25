---
description: Sign this machine in to Enforcer, once — the same sign-in as /enforcer:login
argument-hint: [<WORKSPACE-CODE> | api-key <key> | status | logout]
allowed-tools: Bash(node:*)
---
Sign in to Enforcer and print the result verbatim. With no argument this opens a browser sign-in and waits for it to finish. With a workspace code (e.g. `ACME-1234-ABCD`, or `ENFORCER_TENANT_CODE` in settings) the sign-in page skips asking for it.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/login.mjs" $ARGUMENTS`
