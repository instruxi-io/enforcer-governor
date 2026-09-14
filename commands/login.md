---
description: Sign this machine in to Enforcer, once, for the governor and the Enforcer MCP server
argument-hint: [browser | api-key <key> | status | logout]
allowed-tools: Bash(node:*)
---
Sign in to Enforcer and print the result verbatim. With no argument this opens a browser sign-in and waits for it to finish.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/login.mjs" $ARGUMENTS`
