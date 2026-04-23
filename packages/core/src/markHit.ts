import type { DatabaseSync } from 'node:sqlite';

export interface HitKey {
  id: string;
  source: string;
}

/**
 * Record that the given entries were surfaced by retrieval (hook reminder,
 * caveat_search tool, etc.) by writing the current timestamp into
 * entries.last_hit_at. Caller is expected to run this AFTER a successful read
 * path; search functions themselves stay pure and do not touch last_hit_at.
 *
 * No-op when keys is empty. Uses a single prepared statement in a loop; expected
 * call sizes are small (≤ 5 for hook reminders, ≤ 200 for tool search).
 */
export function markHit(
  db: DatabaseSync,
  keys: ReadonlyArray<HitKey>,
  now: () => string = () => new Date().toISOString(),
): void {
  if (keys.length === 0) return;
  const ts = now();
  const stmt = db.prepare(
    'UPDATE entries SET last_hit_at = ? WHERE source = ? AND id = ?',
  );
  for (const k of keys) {
    stmt.run(ts, k.source, k.id);
  }
}
