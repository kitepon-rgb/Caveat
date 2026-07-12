import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_SYNC_DEBOUNCE_MS, CAVEAT_AUTO_SYNC_ENV } from '@caveat/core';
import type { CliContext } from './context.js';

export function maybeTriggerAutoSync(ctx: CliContext): void {
  if (process.env[CAVEAT_AUTO_SYNC_ENV] === 'off') return;
  const statePath = join(ctx.caveatHome, 'sync', '.last-autosync.json');
  const debounceMs = Number(process.env.CAVEAT_AUTO_SYNC_DEBOUNCE_MS ?? AUTO_SYNC_DEBOUNCE_MS);
  try {
    if (existsSync(statePath) && Date.now() - statSync(statePath).mtimeMs < debounceMs) return;
  } catch {
    // Treat unreadable state as not yet run; the worker owns the real lock.
  }
  const cliScript = process.argv[1];
  if (!cliScript) throw new Error('current Caveat CLI script path is unavailable');
  const child = spawn(
    process.execPath,
    [...process.execArgv, '--disable-warning=ExperimentalWarning', cliScript, 'hook', 'autosync'],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}
