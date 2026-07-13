import { describe, expect, it } from 'vitest';
import {
  MAX_HOOK_SIDECAR_TIMEOUT_MS,
  resolveHookSidecarTimeoutMs,
} from '../src/commands/codexSidecarAdvisory.js';

describe('hook sidecar timeout', () => {
  it('keeps the default and maximum below the five-minute claim TTL', () => {
    expect(resolveHookSidecarTimeoutMs(undefined)).toBe(120_000);
    expect(resolveHookSidecarTimeoutMs(String(MAX_HOOK_SIDECAR_TIMEOUT_MS))).toBe(240_000);
    expect(MAX_HOOK_SIDECAR_TIMEOUT_MS).toBeLessThan(5 * 60 * 1_000);
  });

  it.each(['0', '-1', '240001', '1.5', 'not-a-number'])(
    'rejects an unsafe timeout value %s',
    (raw) => expect(() => resolveHookSidecarTimeoutMs(raw)).toThrow(/must be an integer/),
  );
});
