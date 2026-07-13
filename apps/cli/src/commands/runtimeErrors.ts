import { acknowledgeRuntimeErrors, compactRuntimeErrors, runtimeErrorsDiagnostics, runtimeErrorsSnapshot, setRuntimeErrorStatus } from '@caveat/core';
import { CAVEAT_VERSION } from '../version.js';
export function runRuntimeErrors(action: string, value?: string, opts: { afterCursor?: number; limit?: number } = {}) {
  const runtime = { version: CAVEAT_VERSION };
  if (action === 'snapshot') return runtimeErrorsSnapshot(opts.afterCursor ?? 0, opts.limit ?? 256, runtime);
  if (action === 'diagnostics') return runtimeErrorsDiagnostics(runtime);
  if (action === 'ack') return acknowledgeRuntimeErrors(parseCursor(value), runtime);
  if (action === 'resolve') return setRuntimeErrorStatus(value ?? '', 'resolved', runtime);
  if (action === 'reopen') return setRuntimeErrorStatus(value ?? '', 'open', runtime);
  if (action === 'compact') return compactRuntimeErrors(runtime);
  throw new Error('unknown_runtime_errors_action');
}
export function parseCursor(value: string | undefined): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw Error('invalid_cursor');
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw Error('invalid_cursor'); return parsed;
}
