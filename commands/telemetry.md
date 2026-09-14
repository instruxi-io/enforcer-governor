---
description: Send this machine's Claude Code telemetry and governor receipts to your Enforcer control plane
argument-hint: [on | off | status]
allowed-tools: Bash(node:*)
---
Change or show the telemetry setting and print the result verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/telemetry.mjs" $ARGUMENTS`
