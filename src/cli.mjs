#!/usr/bin/env node
// Enforcer Governor CLI.
//   enforcer-governor start          run the daemon + dashboard
//   enforcer-governor install-hook   wire the Claude Code hook (this project)
//   enforcer-governor install-hook --global   wire it for all projects
//   enforcer-governor hook           (called by Claude Code, not by you)
const cmd = process.argv[2];

if (cmd === 'start' || !cmd) {
  await import('./governor.mjs');
} else if (cmd === 'hook') {
  await import('./hook.mjs');
} else if (cmd === 'install-hook') {
  const { install } = await import('./install.mjs');
  install(process.argv.includes('--global'));
} else {
  console.log(`Enforcer Governor
  start                    run the governor daemon + dashboard (http://localhost:4000)
  install-hook [--global]  wire the Claude Code hook (this project, or all projects)
  hook                     internal: invoked by Claude Code on each tool call
`);
}
