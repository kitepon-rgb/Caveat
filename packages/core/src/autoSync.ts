import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  acquireFileLock,
  acquireReindexLock,
  computeEntriesDigest,
  reindexAllSources,
  releaseFileLock,
  writeDigestMarker,
} from './autoReindex.js';
import { communityPull } from './community.js';
import type { Logger } from './db.js';
import { openDb } from './db.js';
import { appendGlobalPendingReminder } from './pendingReminders.js';
import type { ResolvedPaths } from './paths.js';
import {
  PROBE_REQUEST_FAILED_REASON,
  probeAnonymousRead,
  type RemoteAccess,
} from './remoteVisibility.js';
import { createKeyserverKeyProvider } from './sealedKeys.js';
import { prewarmSealedKeys } from './sealedIndex.js';
import { SyncError, syncOwn } from './sync.js';

export const AUTO_SYNC_DEBOUNCE_MS = 24 * 60 * 60 * 1000;
export const CAVEAT_AUTO_SYNC_ENV = 'CAVEAT_AUTO_SYNC';

function syncDir(caveatHome: string): string {
  return join(caveatHome, 'sync');
}

export function autoSyncStatePath(caveatHome: string): string {
  return join(syncDir(caveatHome), '.last-autosync.json');
}

export function autoSyncLockPath(caveatHome: string): string {
  return join(syncDir(caveatHome), '.autosync-lock');
}

export interface AutoSyncState {
  finishedAt: string;
  signature: string;
  ownSync: { consecutiveFailureSignature: string | null; consecutiveFailureCount: number };
}

export function readAutoSyncState(caveatHome: string): AutoSyncState | null {
  try {
    const value = JSON.parse(readFileSync(autoSyncStatePath(caveatHome), 'utf-8')) as unknown;
    if (!isAutoSyncState(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeAutoSyncState(caveatHome: string, state: AutoSyncState): void {
  const dir = syncDir(caveatHome);
  mkdirSync(dir, { recursive: true });
  const path = autoSyncStatePath(caveatHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), 'utf-8');
  renameSync(temporary, path);
}

export function resetAutoSyncFailureState(caveatHome: string): void {
  try {
    const current = readAutoSyncState(caveatHome);
    writeAutoSyncState(caveatHome, {
      finishedAt: current?.finishedAt ?? new Date(0).toISOString(),
      signature: current?.signature ?? '',
      ownSync: { consecutiveFailureSignature: null, consecutiveFailureCount: 0 },
    });
  } catch {
    // Manual sync must not fail because the autosync marker could not be reset.
  }
}

function isAutoSyncState(value: unknown): value is AutoSyncState {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as AutoSyncState;
  return (
    typeof candidate.finishedAt === 'string' &&
    typeof candidate.signature === 'string' &&
    candidate.ownSync !== null &&
    typeof candidate.ownSync === 'object' &&
    (
      candidate.ownSync.consecutiveFailureSignature === null ||
      typeof candidate.ownSync.consecutiveFailureSignature === 'string'
    ) &&
    Number.isInteger(candidate.ownSync.consecutiveFailureCount) &&
    candidate.ownSync.consecutiveFailureCount >= 0
  );
}

export type OwnSyncDisposition = 'success' | 'skip' | 'network-skip' | 'fail';

export function classifyOwnSyncOutcome(
  err: unknown,
  lastProbe: RemoteAccess | undefined,
): Exclude<OwnSyncDisposition, 'success'> {
  if (!(err instanceof SyncError)) return 'fail';
  switch (err.code) {
    case 'NOT_A_REPO':
    case 'NO_REMOTE':
    case 'EXTERNAL_TOPLEVEL':
    case 'DETACHED_HEAD':
    case 'OWN_REPO_EXISTS':
    case 'BOTH_HAVE_ENTRIES':
      return 'skip';
    case 'REMOTE_PUBLIC':
    case 'SYNC_CONFLICT':
      return 'fail';
    case 'REMOTE_VISIBILITY_INDETERMINATE':
      return lastProbe?.kind === 'indeterminate' && lastProbe.reason === PROBE_REQUEST_FAILED_REASON
        ? 'network-skip'
        : 'fail';
  }
}

export function ownSyncFailureSignature(err: unknown): string {
  // Code-only on purpose. SyncError messages for SYNC_CONFLICT embed raw git
  // rebase output (commit shas, changing file lists) that varies run to run;
  // hashing the message would mint a fresh signature every cycle, so the
  // consecutive-failure counter would never reach the suspend threshold on a
  // *persistent* conflict — exactly when E-5's escape hatch must fire.
  const code = err instanceof SyncError ? err.code : 'UNKNOWN';
  return sha256(code);
}

export interface AutoSyncOutcome {
  community: { handle: string; status: 'ok' | 'failed'; message?: string }[];
  own: {
    disposition: OwnSyncDisposition;
    code?: string;
    pulled?: boolean;
    changedFiles?: number;
    suspended?: boolean;
    escalated?: boolean;
  };
}

export function autoSyncNotification(outcome: AutoSyncOutcome): { signature: string; text: string | null } {
  const lines: string[] = [];
  if (outcome.own.pulled === true) {
    lines.push('autosync: pulled updates from your private remote');
  }
  if (outcome.own.escalated === true) {
    lines.push('autosync: own sync failed 3x in a row and auto-retry is paused. run `caveat sync` manually to resolve and resume.');
  } else if (outcome.own.disposition === 'fail') {
    lines.push(`autosync: own sync failed (${outcome.own.code ?? 'UNKNOWN'}). run \`caveat sync\` to resolve.`);
  }
  const failedHandles = outcome.community
    .filter((result) => result.status === 'failed')
    .map((result) => result.handle)
    .sort();
  if (failedHandles.length > 0) {
    lines.push(`autosync: community pull failed: ${failedHandles.join(', ')}`);
  }
  const text = lines.length > 0 ? lines.join('\n') : null;
  const signature = sha256(JSON.stringify({
    lines,
    own: {
      disposition: outcome.own.disposition,
      code: outcome.own.code ?? null,
      pulled: outcome.own.pulled ?? null,
      suspended: outcome.own.suspended ?? false,
      escalated: outcome.own.escalated ?? false,
    },
    communityFailed: failedHandles,
  }));
  return { signature, text };
}

export interface RunAutoSyncOptions {
  caveatHome: string;
  ownDir: string;
  paths: Pick<ResolvedPaths, 'dbPath' | 'entriesDir' | 'communityDir'>;
  logger: Logger;
  now?: () => Date;
}

export interface RunAutoSyncResult {
  ran: boolean;
  outcome?: AutoSyncOutcome;
  notified?: boolean;
}

export async function runAutoSync(opts: RunAutoSyncOptions): Promise<RunAutoSyncResult> {
  if (process.env[CAVEAT_AUTO_SYNC_ENV] === 'off') return { ran: false };
  const lock = acquireFileLock(autoSyncLockPath(opts.caveatHome));
  if (!lock) return { ran: false };

  let reindexLock: ReturnType<typeof acquireReindexLock> = null;
  try {
    // Take the reindex lock up front and hold it across the whole cycle so
    // syncOwn's internal (lock-less) reindex is serialized against the
    // standalone reindex worker (E-4). If a reindex is already running, bail
    // WITHOUT writing state: leaving the debounce clock untouched makes the
    // next stop retry promptly instead of silently deferring the push for up
    // to a full debounce window.
    reindexLock = acquireReindexLock(opts.caveatHome);
    if (!reindexLock) return { ran: false };

    const previousState = readAutoSyncState(opts.caveatHome);
    let ownSyncState = previousState?.ownSync ?? {
      consecutiveFailureSignature: null,
      consecutiveFailureCount: 0,
    };
    const community = await communityPull({
      communityDir: opts.paths.communityDir,
      logger: opts.logger,
    });

    let own: AutoSyncOutcome['own'];
    if (ownSyncState.consecutiveFailureCount >= 3) {
      // E-5: auto-retry is suspended after 3 consecutive same-code failures.
      // Only a successful manual `caveat sync` (resetAutoSyncFailureState)
      // clears it. Silent here — the escalation was already announced once.
      own = { disposition: 'skip', suspended: true };
    } else {
      let lastProbe: RemoteAccess | undefined;
      try {
        const result = await syncOwn({
          ownDir: opts.ownDir,
          caveatHome: opts.caveatHome,
          paths: opts.paths,
          logger: opts.logger,
          trustRemotePrivate: false,
          probeImpl: async (url) => {
            const probe = await probeAnonymousRead(url);
            lastProbe = probe;
            return probe;
          },
        });
        own = {
          disposition: 'success',
          pulled: result.pulled,
          changedFiles: result.changedFiles,
        };
        ownSyncState = { consecutiveFailureSignature: null, consecutiveFailureCount: 0 };
      } catch (err: unknown) {
        const disposition = classifyOwnSyncOutcome(err, lastProbe);
        const code = err instanceof SyncError ? err.code : undefined;
        own = { disposition, code };
        if (disposition === 'fail') {
          const failureSignature = ownSyncFailureSignature(err);
          const consecutiveFailureCount =
            ownSyncState.consecutiveFailureSignature === failureSignature
              ? ownSyncState.consecutiveFailureCount + 1
              : 1;
          ownSyncState = {
            consecutiveFailureSignature: failureSignature,
            consecutiveFailureCount,
          };
          if (consecutiveFailureCount === 3) own.escalated = true;
        }
      }
    }

    // Reindex under the held lock so community-pull changes land in the index
    // even when own sync was skipped or failed.
    await reindexAndMark(opts);

    const outcome: AutoSyncOutcome = { community, own };
    const { signature, text } = autoSyncNotification(outcome);
    let notified = false;
    if (text !== null && previousState?.signature !== signature) {
      appendGlobalPendingReminder(opts.caveatHome, text);
      notified = true;
    }
    writeAutoSyncState(opts.caveatHome, {
      finishedAt: (opts.now ?? (() => new Date()))().toISOString(),
      signature,
      ownSync: ownSyncState,
    });
    return { ran: true, outcome, notified };
  } catch (err: unknown) {
    opts.logger.warn(`autosync failed: ${errorMessage(err)}`);
    return { ran: true };
  } finally {
    if (reindexLock) {
      try {
        releaseFileLock(reindexLock);
      } catch (err: unknown) {
        opts.logger.warn(`autosync reindex lock release failed: ${errorMessage(err)}`);
      }
    }
    try {
      releaseFileLock(lock);
    } catch (err: unknown) {
      opts.logger.warn(`autosync lock release failed: ${errorMessage(err)}`);
    }
  }
}

async function reindexAndMark(opts: RunAutoSyncOptions): Promise<void> {
  const keyProvider = createKeyserverKeyProvider({ caveatHome: opts.caveatHome });
  const failures = await prewarmSealedKeys({ paths: opts.paths, keyProvider });
  for (const failure of failures) {
    opts.logger.warn(`${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}`);
  }
  mkdirSync(dirname(opts.paths.dbPath), { recursive: true });
  const db = openDb({ path: opts.paths.dbPath, logger: opts.logger });
  try {
    reindexAllSources({ db, paths: opts.paths, logger: opts.logger, keyProvider });
    writeDigestMarker(opts.caveatHome, computeEntriesDigest(opts.paths));
  } finally {
    db.close();
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
