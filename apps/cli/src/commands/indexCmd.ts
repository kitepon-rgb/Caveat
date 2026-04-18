import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb, scanSource, rebuildAll } from '@caveat/core';
import type { Source } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface IndexOptions {
  full: boolean;
}

export function runIndex(ctx: CliContext, opts: IndexOptions): void {
  const dbDir = dirname(ctx.paths.dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    if (opts.full) {
      ctx.logger.info('full rebuild: DELETE FROM entries');
      rebuildAll(db);
    }

    if (existsSync(ctx.paths.entriesDir)) {
      const result = scanSource({ db, source: 'own', entriesRoot: ctx.paths.entriesDir });
      ctx.logger.info(`own: +${result.added} ~${result.updated} -${result.deleted}`);
    } else {
      ctx.logger.warn(`entries dir not found: ${ctx.paths.entriesDir}`);
    }

    if (existsSync(ctx.paths.communityDir)) {
      for (const entry of readdirSync(ctx.paths.communityDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source: Source = `community/${entry.name}`;
        const root = join(ctx.paths.communityDir, entry.name, 'entries');
        if (!existsSync(root)) continue;
        const result = scanSource({ db, source, entriesRoot: root });
        ctx.logger.info(`${source}: +${result.added} ~${result.updated} -${result.deleted}`);
      }
    }
  } finally {
    db.close();
  }
}
