import { openDb, listStale, type Visibility } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface StaleOptions {
  days: number;
  visibility?: Visibility;
  limit: number;
}

export function runStale(ctx: CliContext, opts: StaleOptions): void {
  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const rows = listStale(db, {
      days: opts.days,
      visibility: opts.visibility,
      limit: opts.limit,
    });
    if (rows.length === 0) {
      process.stdout.write('(no stale entries)\n');
      return;
    }
    for (const r of rows) {
      const age = r.last_hit_at ?? 'never';
      process.stdout.write(`${r.id} [${r.source}] (${r.visibility}) ${age} — ${r.title}\n`);
    }
  } finally {
    db.close();
  }
}
