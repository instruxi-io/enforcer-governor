---
description: Set the spend limit per agent, in dollars
argument-hint: <dollars>
allowed-tools: Bash(node:*)
---
Set the per-agent spend limit to $ARGUMENTS and confirm:

!`node "${CLAUDE_PLUGIN_ROOT}/src/report.mjs" limit $ARGUMENTS`
