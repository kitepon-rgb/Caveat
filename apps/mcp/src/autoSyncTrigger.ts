import { AUTO_SYNC_RECORD_DEBOUNCE_MS, triggerAutoSync, type Logger } from '@caveat/core';

/**
 * A recorded entry only helps the other terminals once it reaches the private
 * remote, so a write pushes on its own instead of waiting for the next Stop
 * hook. The entry is already written and indexed by this point: a trigger
 * failure is reported and dropped, never surfaced as a failed tool call, and
 * the periodic cycle still carries the entry out.
 */
export function triggerAutoSyncAfterWrite(caveatHome: string, logger: Logger): void {
  try {
    triggerAutoSync({
      caveatHome,
      cliScript: process.argv[1] ?? '',
      debounceMs: AUTO_SYNC_RECORD_DEBOUNCE_MS,
    });
  } catch (err: unknown) {
    logger.warn(`auto sync trigger failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
