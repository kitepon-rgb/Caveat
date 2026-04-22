import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Read every pending reminder file for this session, unlink them, and
 * return their contents in timestamp-ascending order. Safe to call when
 * the session has no queue (returns empty array). Never throws on
 * individual file read / unlink failures — those are logged to stderr
 * by the caller's logger.
 */
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
