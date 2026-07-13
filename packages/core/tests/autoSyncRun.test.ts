import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainGlobalPendingReminders,
  readAutoSyncState,
  resetAutoSyncFailureState,
  runAutoSync,
  type Logger,
} from '../src/index.js';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Caveat Test',
      GIT_AUTHOR_EMAIL: 'caveat@example.com',
      GIT_COMMITTER_NAME: 'Caveat Test',
      GIT_COMMITTER_EMAIL: 'caveat@example.com',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function entry(): string {
  return `---
id: pulsar-drift
title: Pulsar drift calibration failure
visibility: private
confidence: confirmed
tags: [pulsar, drift]
environment: {}
source_project: null
source_session: test
created_at: 2026-07-12
updated_at: 2026-07-12
---

## Symptom
Pulsar drift calibration failure reports a rare anchor mismatch.
`;
}

/**
 * Own repo whose only remote is an un-probeable file:// URL. syncOwn's
 * preflight cannot verify the remote is private (deriveAnonymousProbeUrl
 * returns undefined for file://), so with trustRemotePrivate:false it throws
 * REMOTE_VISIBILITY_INDETERMINATE *before any push* — a deterministic,
 * side-effect-free own-sync 'fail' we can repeat to exercise the E-5 escape.
 */
function freshOwnRepoWithUnprobeableRemote(): { home: string; paths: { dbPath: string; entriesDir: string; communityDir: string }; ownDir: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-autosync-run-'));
  const ownDir = join(home, 'own');
  const entriesDir = join(ownDir, 'entries');
  mkdirSync(entriesDir, { recursive: true });
  mkdirSync(join(home, 'community'), { recursive: true });
  mkdirSync(join(home, 'index'), { recursive: true });
  const bare = join(home, 'remote.git');
  git(['init', '--bare', bare], home);
  git(['init', '-b', 'main', ownDir], home);
  git(['remote', 'add', 'origin', `file://${bare}`], ownDir);
  writeFileSync(join(entriesDir, 'pulsar.md'), entry());
  git(['add', '-A'], ownDir);
  git(['commit', '-m', 'own entry'], ownDir);
  return {
    home,
    ownDir,
    paths: {
      dbPath: join(home, 'index', 'caveat.db'),
      entriesDir,
      communityDir: join(home, 'community'),
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('runAutoSync own-sync failure escape (E-5)', () => {
  it('applies its background git timeout policy to own sync', async () => {
    const { home, paths, ownDir, cleanup } = freshOwnRepoWithUnprobeableRemote();
    try {
      const result = await runAutoSync({
        caveatHome: home,
        ownDir,
        paths,
        logger: silent,
        gitTimeoutMs: 5_999,
      });
      expect(result.outcome?.own).toMatchObject({
        disposition: 'fail',
        code: undefined,
      });
    } finally {
      cleanup();
    }
  });

  it('increments on repeated failure, escalates once at 3, suspends after, and resets manually', async () => {
    const { home, paths, ownDir, cleanup } = freshOwnRepoWithUnprobeableRemote();
    try {
      const opts = { caveatHome: home, ownDir, paths, logger: silent };

      // Cycle 1: first failure → count 1, notified.
      const r1 = await runAutoSync(opts);
      expect(r1.ran).toBe(true);
      expect(r1.outcome?.own.disposition).toBe('fail');
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(1);
      expect(r1.notified).toBe(true);
      const drained1 = drainGlobalPendingReminders(home);
      expect(drained1.join('\n')).toContain('own sync failed');

      // Cycle 2: same failure → count 2, deduped (no new notification).
      const r2 = await runAutoSync(opts);
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(2);
      expect(r2.notified).toBe(false);
      expect(drainGlobalPendingReminders(home)).toHaveLength(0);

      // Cycle 3: third failure → count 3, escalated once.
      const r3 = await runAutoSync(opts);
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(3);
      expect(r3.outcome?.own.escalated).toBe(true);
      expect(r3.notified).toBe(true);
      expect(drainGlobalPendingReminders(home).join('\n')).toContain('auto-retry is paused');

      // Cycle 4: suspended — own sync not attempted, count frozen, silent.
      const r4 = await runAutoSync(opts);
      expect(r4.outcome?.own.suspended).toBe(true);
      expect(r4.outcome?.own.disposition).toBe('skip');
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(3);
      expect(r4.notified).toBe(false);
      expect(drainGlobalPendingReminders(home)).toHaveLength(0);

      // Manual sync success resets the counter and re-enables auto-retry.
      resetAutoSyncFailureState(home);
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(0);
      const r5 = await runAutoSync(opts);
      expect(r5.outcome?.own.disposition).toBe('fail');
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});
