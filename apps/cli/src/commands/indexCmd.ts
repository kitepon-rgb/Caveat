import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { computeEntriesDigest, openDb, rebuildAll, reindexAllSources, writeDigestMarker } from '@caveat/core';
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

    const result = reindexAllSources({ db, paths: ctx.paths, logger: ctx.logger });
    for (const [source, scan] of Object.entries(result.perSource)) {
      if (source === 'own') {
        ctx.logger.info(`own: +${scan.added} ~${scan.updated} -${scan.deleted}`);
      } else {
        ctx.logger.info(`${source}: +${scan.added} ~${scan.updated} -${scan.deleted}`);
      }
    }
    writeDigestMarker(ctx.caveatHome, computeEntriesDigest(ctx.paths));
  } finally {
    db.close();
  }
}
