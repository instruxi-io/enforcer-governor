// core/ is the harness-neutral governor: what a Codex, Gemini CLI or MCP-proxy
// adapter will build on. It may import only other core/ modules and Node
// built-ins. The moment it reaches into src/, hooks/ or a Claude-specific
// module, every other harness inherits Claude Code's assumptions.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../core/', import.meta.url).pathname;
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const bad = [];
let files = 0;
// core/test/ holds the harness contract (contract.mjs), which ships with the
// core so any adapter can run it; it is held to the same rule, reaching the
// core through '../'.
const scan = (sub, local) => {
  for (const f of readdirSync(join(dir, sub)).filter((n) => n.endsWith('.mjs'))) {
    files++;
    const src = readFileSync(join(dir, sub, f), 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] || m[2] || m[3];
      const ok = spec.startsWith('node:') || local.test(spec);
      if (!ok) bad.push(`${join(sub, f)} imports ${spec}`);
    }
  }
};
scan('', /^\.\/[a-z-]+\.mjs$/);
scan('test', /^\.\.\/[a-z-]+\.mjs$/);
scan('bin', /^\.\.\/[a-z-]+\.mjs$/);
if (!files) { console.error('FAIL: core/ has no modules'); process.exit(1); }
if (bad.length) { console.error('FAIL: core/ must import only core/ and node: built-ins:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`core/ imports only core/ and node: built-ins (${files} modules) ok`);
