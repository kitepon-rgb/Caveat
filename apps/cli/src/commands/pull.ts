import { existsSync } from 'node:fs';
import { communityPull, computeEntriesDigest, openDb, rebuildAll, reindexAllSources, writeDigestMarker } from '@caveat/core';
import type { CliContext } from '../context.js';

export async function runPull(ctx: CliContext): Promise<void> {
  const hasCommunityDir = existsSync(ctx.paths.communityDir);
  if (!hasCommunityDir) {
    ctx.logger.info(
      'no community repos yet — add one with `caveat community add <github-url>`.',
    );
  }

  const pulls = hasCommunityDir
    ? await communityPull({ communityDir: ctx.paths.communityDir, logger: ctx.logger })
    : [];
  for (const p of pulls) {
    if (p.status === 'ok') {
      ctx.logger.info(`${p.handle}: pulled`);
    } else {
      ctx.logger.warn(`${p.handle}: FAILED — ${p.message ?? 'unknown'}`);
    }
  }

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    rebuildAll(db);
    const result = reindexAllSources({ db, paths: ctx.paths, logger: ctx.logger });
    for (const [source, scan] of Object.entries(result.perSource)) {
      ctx.logger.info(`${source}: +${scan.added}`);
    }
    writeDigestMarker(ctx.caveatHome, computeEntriesDigest(ctx.paths));
  } finally {
    db.close();
  }
}
