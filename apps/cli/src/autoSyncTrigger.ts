import { AUTO_SYNC_DEBOUNCE_MS, triggerAutoSync } from '@caveat/core';
import type { CliContext } from './context.js';

export function maybeTriggerAutoSync(ctx: CliContext, debounceMs: number = AUTO_SYNC_DEBOUNCE_MS): void {
  triggerAutoSync({
    caveatHome: ctx.caveatHome,
    cliScript: process.argv[1] ?? '',
    debounceMs,
  });
}
