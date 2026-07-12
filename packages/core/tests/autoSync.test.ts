import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireFileLock,
  autoSyncNotification,
  autoSyncStatePath,
  classifyOwnSyncOutcome,
  ownSyncFailureSignature,
  PROBE_REQUEST_FAILED_REASON,
  readAutoSyncState,
  releaseFileLock,
  resetAutoSyncFailureState,
  SyncError,
  writeAutoSyncState,
  type SyncErrorCode,
} from '../src/index.js';

function fresh(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-auto-sync-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('auto sync core', () => {
  it('classifies own sync outcomes by sync code and probe reason', () => {
    const skipCodes: SyncErrorCode[] = [
      'NOT_A_REPO',
      'NO_REMOTE',
      'EXTERNAL_TOPLEVEL',
      'DETACHED_HEAD',
      'OWN_REPO_EXISTS',
      'BOTH_HAVE_ENTRIES',
    ];
    for (const code of skipCodes) {
      expect(classifyOwnSyncOutcome(new SyncError(code, code), undefined)).toBe('skip');
    }

    expect(classifyOwnSyncOutcome(new SyncError('REMOTE_PUBLIC', 'public'), undefined)).toBe('fail');
    expect(classifyOwnSyncOutcome(new SyncError('SYNC_CONFLICT', 'conflict'), undefined)).toBe('fail');
    expect(classifyOwnSyncOutcome(
      new SyncError('REMOTE_VISIBILITY_INDETERMINATE', 'network'),
      { kind: 'indeterminate', reason: PROBE_REQUEST_FAILED_REASON },
    )).toBe('network-skip');
    expect(classifyOwnSyncOutcome(
      new SyncError('REMOTE_VISIBILITY_INDETERMINATE', '403'),
      { kind: 'indeterminate', reason: 'unexpected HTTP status 403' },
    )).toBe('fail');
    expect(classifyOwnSyncOutcome(new Error('boom'), undefined)).toBe('fail');
  });

  it('derives failure signatures from code only, ignoring volatile git output', () => {
    // Same code, different (git-derived) message detail → same signature, so a
    // persistent SYNC_CONFLICT whose git output changes every rebase still
    // accumulates toward the E-5 suspend threshold.
    const a = ownSyncFailureSignature(new SyncError('SYNC_CONFLICT', 'CONFLICT in a.md\nabc123'));
    const b = ownSyncFailureSignature(new SyncError('SYNC_CONFLICT', 'CONFLICT in b.md\ndef456'));
    const c = ownSyncFailureSignature(new SyncError('REMOTE_PUBLIC', 'CONFLICT in a.md\nabc123'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reports only notification-worthy autosync outcomes and dedupes by signature', () => {
    const quiet = autoSyncNotification({
      community: [{ handle: 'alice', status: 'ok' }],
      own: { disposition: 'success', pulled: false, changedFiles: 0 },
    });
    expect(quiet.text).toBeNull();
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'skip', code: 'NOT_A_REPO' },
    }).text).toBeNull();
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'network-skip', code: 'REMOTE_VISIBILITY_INDETERMINATE' },
    }).text).toBeNull();

    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'success', pulled: true, changedFiles: 1 },
    }).text).toContain('private remote');
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'fail', code: 'REMOTE_PUBLIC' },
    }).text).toContain('REMOTE_PUBLIC');
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'fail', code: 'SYNC_CONFLICT', escalated: true },
    }).text).toContain('auto-retry is paused');
    expect(autoSyncNotification({
      community: [{ handle: 'team', status: 'failed', message: 'nope' }],
      own: { disposition: 'skip' },
    }).text).toContain('team');
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'success', pulled: false, changedFiles: 0 },
    }).signature).toBe(quiet.signature);
  });

  it('round-trips state, rejects malformed state, and resets failure counters', () => {
    const { home, cleanup } = fresh();
    try {
      expect(readAutoSyncState(home)).toBeNull();
      writeAutoSyncState(home, {
        finishedAt: '2026-07-12T00:00:00.000Z',
        signature: 'sig',
        ownSync: { consecutiveFailureSignature: 'fail', consecutiveFailureCount: 2 },
      });
      expect(readAutoSyncState(home)).toEqual({
        finishedAt: '2026-07-12T00:00:00.000Z',
        signature: 'sig',
        ownSync: { consecutiveFailureSignature: 'fail', consecutiveFailureCount: 2 },
      });
      resetAutoSyncFailureState(home);
      expect(readAutoSyncState(home)?.ownSync).toEqual({
        consecutiveFailureSignature: null,
        consecutiveFailureCount: 0,
      });
      writeFileSync(autoSyncStatePath(home), '{"finishedAt":"x"}', 'utf-8');
      expect(readAutoSyncState(home)).toBeNull();
      writeFileSync(autoSyncStatePath(home), '{bad', 'utf-8');
      expect(readAutoSyncState(home)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('acquires generic file locks exclusively and replaces stale locks', () => {
    const { home, cleanup } = fresh();
    try {
      const path = join(home, 'sync', '.generic-lock');
      const lock = acquireFileLock(path);
      expect(lock).not.toBeNull();
      expect(acquireFileLock(path)).toBeNull();
      releaseFileLock(lock!);
      expect(existsSync(path)).toBe(false);

      mkdirSync(join(home, 'sync'), { recursive: true });
      writeFileSync(path, '99999999', 'utf-8');
      const replacement = acquireFileLock(path);
      expect(replacement).not.toBeNull();
      expect(readFileSync(path, 'utf-8')).toBe(String(process.pid));
      releaseFileLock(replacement!);
    } finally {
      cleanup();
    }
  });
});
