import { openDb, listRecent } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface ListOptions {
  limit: number;
}

export function runList(ctx: CliContext, opts: ListOptions): void {
  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const results = listRecent(db, opts.limit);
    if (results.length === 0) {
      process.stdout.write('(no entries)\n');
      return;
    }
    for (const r of results) {
      process.stdout.write(`${r.id} [${r.source}] (${r.confidence}) ${r.title}\n`);
    }
  } finally {
    db.close();
  }
}
