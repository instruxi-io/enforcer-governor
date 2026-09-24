#!/usr/bin/env node
// GVNR (Enforcer Governor) CLI.
//   enforcer-governor start          run the daemon + dashboard
//   enforcer-governor install-hook   wire the Claude Code hook (this project)
//   enforcer-governor install-hook --global   wire it for all projects
//   enforcer-governor hook           (called by Claude Code, not by you)
//   enforcer-governor mcp            MCP server over stdio, for any MCP client
//   enforcer-governor telemetry on|off  anonymous usage counts (off by default)
const cmd = process.argv[2];

if (cmd === 'start' || !cmd) {
  (await import('./governor.mjs')).start();
} else if (cmd === 'uninstall-hook' || cmd === 'uninstall') {
  const { uninstall } = await import('./install.mjs');
  uninstall(process.argv.includes('--global'));
  uninstall(!process.argv.includes('--global')); // clear both scopes, nobody remembers which they used
} else if (cmd === 'hook') {
  await import('./hook.mjs');
} else if (cmd === 'mcp') {
  await import('./mcp.mjs');
} else if (cmd === 'install-hook') {
  const { install } = await import('./install.mjs');
  install(process.argv.includes('--global'));
  // One command should end with something you can look at, not a second command
  // to run. Wire the hook, then bring the dashboard up. --no-start opts out.
  if (!process.argv.includes('--no-start')) {
    console.log('  Starting the governor and opening your dashboard...');
    (await import('./governor.mjs')).start();
  }
} else if (cmd === 'telemetry') {
  const usage = await import('./telemetry.mjs');
  const arg = process.argv[3];
  const st = arg === 'on' ? usage.set(true) : arg === 'off' ? usage.set(false) : usage.status();
  console.log(`  Anonymous usage counts are ${st.on ? 'ON' : 'OFF'}${st.blocked ? ` (not sending: ${st.blocked})` : ''}.`);
  console.log(`  What is sent when on: ${st.sends}`);
  console.log(`  Change it: enforcer-governor telemetry on | off`);
} else {
  console.log(`GVNR (Enforcer Governor)
  start                    run the governor daemon + dashboard (http://localhost:4000)
  install-hook [--global]  wire the Claude Code hook (this project, or all projects)
  uninstall-hook           remove the hook and stop governing (the way out)
  hook                     internal: invoked by Claude Code on each tool call
  mcp                      MCP server over stdio: status, ask permission, receipts, stop
  telemetry [on|off]       anonymous usage counts, off unless you switch them on
`);
}
