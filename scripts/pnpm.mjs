#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);

for (const candidate of candidateCommands()) {
  const useShell = process.platform === 'win32' && candidate.shell !== false;
  // With `shell: true`, Node passes the command line to cmd.exe unquoted, so a
  // command resolved under a path with spaces (e.g. corepack shims created in
  // "C:\Program Files\nodejs" on CI runners) breaks as `'C:\Program' is not
  // recognized`. Quote each token; single command-string form also avoids the
  // Node 24 "shell + args array" deprecation (same pattern as claudeInstall.ts).
  const result = useShell
    ? spawnSync([candidate.command, ...candidate.args, ...args].map(shellQuote).join(' '), {
        stdio: 'inherit',
        shell: true,
        windowsHide: true,
      })
    : spawnSync(candidate.command, [...candidate.args, ...args], {
        stdio: 'inherit',
        windowsHide: true,
      });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) {
    console.error(`[caveat] failed to run ${candidate.label}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error('[caveat] pnpm is required but was not found.');
console.error('Install it with `npm install -g pnpm@10.0.0`, or install Node with Corepack enabled.');
process.exit(127);

function shellQuote(s) {
  // Cross-platform-safe quoting for shell: true. Inputs are command paths and
  // pnpm script args (no embedded `"` by construction) — only spaces and cmd
  // metacharacters need wrapping. Mirrors apps/cli/src/claudeInstall.ts.
  return /[\s&|<>^()]/.test(s) ? `"${s}"` : s;
}

function* candidateCommands() {
  const explicit = process.env.CAVEAT_PNPM_BIN;
  if (explicit) {
    yield { label: explicit, command: explicit, args: [], shell: true };
  }

  const pnpm = findOnPath(process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']);
  if (pnpm) {
    yield { label: pnpm, command: pnpm, args: [], shell: true };
  }

  const corepack = findOnPath(process.platform === 'win32' ? ['corepack.cmd', 'corepack.exe', 'corepack'] : ['corepack']);
  if (corepack) {
    yield { label: `${corepack} pnpm`, command: corepack, args: ['pnpm'], shell: true };
  }

  const npx = findOnPath(process.platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx']);
  if (npx) {
    yield { label: `${npx} pnpm@10.0.0`, command: npx, args: ['--yes', 'pnpm@10.0.0'], shell: true };
  }
}

function findOnPath(names) {
  for (const name of names) {
    if (isAbsolute(name) && existsSync(name)) return name;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}
