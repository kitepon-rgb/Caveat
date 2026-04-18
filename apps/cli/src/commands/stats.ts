import { openDb } from '@caveat/core';
import type { CliContext } from '../context.js';

interface CountRow {
  key: string;
  n: number;
}

export function runStats(ctx: CliContext): void {
  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const total = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
    process.stdout.write(`total: ${total.n}\n`);

    const bySource = db
      .prepare('SELECT source AS key, COUNT(*) AS n FROM entries GROUP BY source ORDER BY n DESC')
      .all() as unknown as CountRow[];
    if (bySource.length > 0) {
      process.stdout.write('by source:\n');
      for (const row of bySource) process.stdout.write(`  ${row.key}: ${row.n}\n`);
    }

    const byConfidence = db
      .prepare(
        'SELECT COALESCE(confidence, \'(unset)\') AS key, COUNT(*) AS n FROM entries GROUP BY confidence ORDER BY n DESC',
      )
      .all() as unknown as CountRow[];
    if (byConfidence.length > 0) {
      process.stdout.write('by confidence:\n');
      for (const row of byConfidence) process.stdout.write(`  ${row.key}: ${row.n}\n`);
    }

    const byVisibility = db
      .prepare(
        'SELECT COALESCE(visibility, \'(unset)\') AS key, COUNT(*) AS n FROM entries GROUP BY visibility ORDER BY n DESC',
      )
      .all() as unknown as CountRow[];
    if (byVisibility.length > 0) {
      process.stdout.write('by visibility:\n');
      for (const row of byVisibility) process.stdout.write(`  ${row.key}: ${row.n}\n`);
    }
  } finally {
    db.close();
  }
}
