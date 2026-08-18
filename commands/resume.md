---
description: Resume an agent the governor stopped, and raise its limit so it can finish
argument-hint: [agent]
allowed-tools: Bash(node:*)
---
Resume the stopped agent and show the result verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/src/report.mjs" resume $ARGUMENTS`
