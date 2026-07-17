// TEMPORARY DIAGNOSTIC — do not merge.
//
// `runtimeErrors.test.ts > is strictly opt-in and creates no state while
// disabled` fails intermittently on Windows CI with `store_unsafe`, and has
// been "stabilized" three times (42f0451 / 0c4678f / 07a84b2) without anyone
// seeing the cause: the seam used to swallow PowerShell's stderr and collapse
// every failure mode into one word.
//
// Neither hypothesis survives on a real Windows workstation: powershell spawn
// costs ~150ms idle / ~200ms with 12 in flight (vs a 3000ms budget), and the
// real apply script succeeded 120/120 across 8 parallel workers. The remaining
// difference is the GitHub-hosted runner itself, so this reproduces the exact
// operation there, under the same parallel suite load, and prints what fails.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runWindowsAcl } from '../src/runtimeErrors.js';

const ITERATIONS = 40;
const isWindows = process.platform === 'win32';

describe.runIf(isWindows)('windows acl flake diagnostic', { timeout: 240_000 }, () => {
  it('reports how the acl seam fails under repeated apply', () => {
    const failures: string[] = [];
    const durations: number[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      // Mirror tests/runtimeErrors.test.ts env(): fresh temp tree, write the
      // config, then apply the ACL to that freshly written file.
      const root = mkdtempSync(join(tmpdir(), 'caveat-acl-diag-'));
      const config = join(root, 'dotagents', 'factory-reporter', 'config.json');
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, '{"schema_version":"1.0"}', { mode: 0o600 });
      const started = Date.now();
      try {
        runWindowsAcl(config, false, true);
        durations.push(Date.now() - started);
      } catch (err: unknown) {
        durations.push(Date.now() - started);
        failures.push(`iter=${i} elapsed=${Date.now() - started}ms ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const max = Math.max(...durations);
    const sorted = [...durations].sort((a, b) => a - b);
    console.log(`[acl-diag] iterations=${ITERATIONS} failures=${failures.length}`);
    console.log(`[acl-diag] ms min=${sorted[0]} p50=${sorted[Math.floor(sorted.length / 2)]} max=${max}`);
    console.log(`[acl-diag] slowest_first_call=${durations[0]}ms over_3000=${durations.filter((d) => d > 3000).length}`);
    for (const failure of failures.slice(0, 10)) console.log(`[acl-diag] ${failure}`);

    // Fail loudly when it reproduces so the log is impossible to miss.
    expect(failures).toEqual([]);
  });
});
