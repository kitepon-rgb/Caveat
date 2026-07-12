import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Per-session on-disk queue of deferred reminders. Used by the async
 * PostToolUse hook pipeline: a fast foreground hook writes request files,
 * a detached worker processes them and writes reminder files here, then
 * the next hook invocation drains the queue to stdout.
 */

function sanitizeSessionId(raw: string): string {
  // Only allow hex / dash / underscore. Prevents traversal via crafted
  // session_id values. Empty input → fallback bucket.
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.length > 0 ? clean : '_unknown';
}

export const GLOBAL_PENDING_SESSION = '_global';

export function pendingDirFor(caveatHome: string, sessionId: string): string {
  return join(caveatHome, 'pending', sanitizeSessionId(sessionId));
}

export function appendPendingReminder(
  caveatHome: string,
  sessionId: string,
  text: string,
): string {
  const dir = pendingDirFor(caveatHome, sessionId);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
  const path = join(dir, name);
  writeFileSync(path, text, 'utf-8');
  return path;
}

export function appendGlobalPendingReminder(caveatHome: string, text: string): string {
  return appendPendingReminder(caveatHome, GLOBAL_PENDING_SESSION, text);
}

/**
 * Read every pending reminder file for this session, unlink them, and
 * return their contents in timestamp-ascending order. Safe to call when
 * the session has no queue (returns empty array). Never throws on
 * individual file read / unlink failures — those are logged to stderr
 * by the caller's logger.
 */
/**
 * Sweep stale per-session pending directories under `<caveatHome>/pending/`.
 *
 * A subdirectory is removed (subtree-rmSync) iff every entry — the directory
 * itself and any leftover `.txt` files — has an mtime older than `staleDays`.
 * Empty husks left behind by a successful drain age out naturally because
 * their mtime stops updating once nothing writes to them. Stranded reminders
 * from sessions that ended before drain are handled the same way: once
 * `staleDays` has elapsed since the last write, the whole subtree is recycled.
 *
 * Active sessions are safe — any recent append or drain refreshes the parent
 * directory's mtime, so an in-flight session's directory is never collected.
 */
export function cleanupStalePendingDirs(
  caveatHome: string,
  options: { staleDays?: number; now?: Date } = {},
): { removed: string[]; kept: number } {
  const staleDays = options.staleDays ?? 7;
  if (staleDays < 0) {
    throw new Error(`cleanupStalePendingDirs: staleDays must be >= 0 (got ${staleDays})`);
  }
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const root = join(caveatHome, 'pending');
  if (!existsSync(root)) return { removed: [], kept: 0 };

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed: [], kept: 0 };
  }

  const removed: string[] = [];
  let kept = 0;
  for (const entry of entries) {
    const sub = join(root, entry);
    let subStat;
    try {
      subStat = statSync(sub);
    } catch {
      continue;
    }
    if (!subStat.isDirectory()) continue;

    let newest = subStat.mtimeMs;
    let scanFailed = false;
    try {
      for (const f of readdirSync(sub)) {
        const fp = join(sub, f);
        try {
          const fs = statSync(fp);
          if (fs.mtimeMs > newest) newest = fs.mtimeMs;
        } catch {
          scanFailed = true;
          break;
        }
      }
    } catch {
      scanFailed = true;
    }

    if (scanFailed || newest >= cutoffMs) {
      kept++;
      continue;
    }
    try {
      rmSync(sub, { recursive: true, force: true });
      removed.push(sub);
    } catch {
      // Best-effort: leave the directory if rm fails (permission, race).
      kept++;
    }
  }
  return { removed, kept };
}

export interface MaybeSweepResult {
  swept?: { removed: string[]; kept: number };
  skipped?: 'env_off' | 'no_pending_dir' | 'debounced';
}

/**
 * Hook-driven, debounced wrapper around `cleanupStalePendingDirs`.
 *
 * Designed to be called from the hot path (e.g. `caveat hook stop`) where
 * the same hook fires many times per session. Behavior:
 *
 *   1. If `CAVEAT_PENDING_SWEEP=off` is set, return `{ skipped: 'env_off' }`
 *      without touching the filesystem. Escape hatch for users who want to
 *      manage `pending/` themselves.
 *   2. If `<caveatHome>/pending/` does not yet exist, return
 *      `{ skipped: 'no_pending_dir' }` (nothing to sweep).
 *   3. Otherwise read `<caveatHome>/pending/.last-sweep` mtime. If the
 *      marker is fresher than `debounceDays` (default 1), skip with
 *      `{ skipped: 'debounced' }`.
 *   4. Otherwise call `cleanupStalePendingDirs(caveatHome, { staleDays })`
 *      and refresh the marker. Marker is refreshed even when the sweep
 *      removed nothing, so the next debounce window starts now.
 *
 * The marker file is `pending/.last-sweep`, which is intentionally placed
 * inside `pending/` itself: `cleanupStalePendingDirs` only descends into
 * directories under that root, so a top-level file is never collected.
 */
export function maybeSweepPendingDirs(
  caveatHome: string,
  options: { staleDays?: number; debounceDays?: number; now?: Date } = {},
): MaybeSweepResult {
  if (process.env.CAVEAT_PENDING_SWEEP === 'off') {
    return { skipped: 'env_off' };
  }
  const staleDays = options.staleDays ?? 7;
  const debounceDays = options.debounceDays ?? 1;
  if (debounceDays < 0) {
    throw new Error(
      `maybeSweepPendingDirs: debounceDays must be >= 0 (got ${debounceDays})`,
    );
  }
  const now = options.now ?? new Date();
  const pendingRoot = join(caveatHome, 'pending');
  if (!existsSync(pendingRoot)) return { skipped: 'no_pending_dir' };

  const marker = join(pendingRoot, '.last-sweep');
  try {
    const m = statSync(marker);
    const ageMs = now.getTime() - m.mtimeMs;
    if (ageMs < debounceDays * 24 * 60 * 60 * 1000) {
      return { skipped: 'debounced' };
    }
  } catch {
    // Marker missing: first sweep, fall through.
  }

  const result = cleanupStalePendingDirs(caveatHome, { staleDays, now });
  try {
    writeFileSync(marker, '', 'utf-8');
  } catch {
    // Best-effort: a missing marker just means the next call will sweep
    // again, which is wasteful but correct.
  }
  return { swept: result };
}

export function drainPendingReminders(caveatHome: string, sessionId: string): string[] {
  const dir = pendingDirFor(caveatHome, sessionId);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      out.push(readFileSync(path, 'utf-8'));
    } catch {
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup; leaving the file means it may be re-drained
      // once next hook fires, which is preferable to blocking on failure.
    }
  }
  return out;
}

export function drainGlobalPendingReminders(caveatHome: string): string[] {
  return drainPendingReminders(caveatHome, GLOBAL_PENDING_SESSION);
}
