import type { DatabaseSync } from 'node:sqlite';
import type { Source, Visibility } from './types.js';

export interface StaleOptions {
  /** Cutoff threshold in days. Entries whose last_hit_at is older than this — or null — are returned. */
  days?: number;
  /** Narrow by publish tier. Omit to include both. */
  visibility?: Visibility;
  /** Max rows to return. */
  limit?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface StaleRow {
  id: string;
  source: Source;
  title: string;
  visibility: Visibility;
  /** Null when the entry has never been surfaced since last_hit_at was introduced. */
  last_hit_at: string | null;
}

/**
 * List entries that have not been surfaced by retrieval for at least `days`
 * days (default 90). Entries with a null last_hit_at are always included —
 * they have either never been retrieved, or predate the v2 schema.
 *
 * Sort order: nulls first (never seen), then oldest last_hit_at first.
 */
export function listStale(db: DatabaseSync, opts: StaleOptions = {}): StaleRow[] {
  const days = opts.days ?? 90;
  const limit = opts.limit ?? 50;
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const conditions: string[] = ['(last_hit_at IS NULL OR last_hit_at < ?)'];
  const params: unknown[] = [cutoff];

  if (opts.visibility === 'public' || opts.visibility === 'private') {
    conditions.push('visibility = ?');
    params.push(opts.visibility);
  }

  const sql = `
    SELECT id, source, title, visibility, last_hit_at
    FROM entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_hit_at IS NULL DESC, last_hit_at ASC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...(params as never[])) as Array<{
    id: string;
    source: string;
    title: string;
    visibility: string | null;
    last_hit_at: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    source: r.source as Source,
    title: r.title,
    visibility: (r.visibility as Visibility) ?? 'public',
    last_hit_at: r.last_hit_at,
  }));
}
