#!/usr/bin/env node
// Enforcer Governor CLI.
//   enforcer-governor start          run the daemon + dashboard
//   enforcer-governor install-hook   wire the Claude Code hook (this project)
//   enforcer-governor install-hook --global   wire it for all projects
//   enforcer-governor hook           (called by Claude Code, not by you)
const cmd = process.argv[2];

if (cmd === 'start' || !cmd) {
  (await import('./governor.mjs')).start();
} else if (cmd === 'uninstall-hook' || cmd === 'uninstall') {
  const { uninstall } = await import('./install.mjs');
  uninstall(process.argv.includes('--global'));
  uninstall(!process.argv.includes('--global')); // clear both scopes, nobody remembers which they used
} else if (cmd === 'hook') {
  await import('./hook.mjs');
} else if (cmd === 'install-hook') {
  const { install } = await import('./install.mjs');
  install(process.argv.includes('--global'));
  // One command should end with something you can look at, not a second command
  // to run. Wire the hook, then bring the dashboard up. --no-start opts out.
  if (!process.argv.includes('--no-start')) {
    console.log('  Starting the governor and opening your dashboard...');
    (await import('./governor.mjs')).start();
  }
} else {
  console.log(`Enforcer Governor
  start                    run the governor daemon + dashboard (http://localhost:4000)
  install-hook [--global]  wire the Claude Code hook (this project, or all projects)
  uninstall-hook           remove the hook and stop governing (the way out)
  hook                     internal: invoked by Claude Code on each tool call
`);
}
