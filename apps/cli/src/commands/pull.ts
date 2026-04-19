import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  openDb,
  communityPull,
  rebuildAll,
  scanSource,
  type Source,
} from '@caveat/core';
import type { CliContext } from '../context.js';

/**
 * Convenience: pull all community repos (including the shared DB) and re-index.
 * For users who don't care about the distinction between `community pull` and
 * `index` — they just want `caveat pull` to refresh their knowledge base.
 */
export async function runPull(ctx: CliContext): Promise<void> {
  if (!existsSync(ctx.paths.communityDir)) {
    ctx.logger.info(
      'no community repos yet — did you run `caveat init`? ' +
        'You can also `caveat community add <url>` manually.',
    );
    return;
  }

  const results = await communityPull({
    communityDir: ctx.paths.communityDir,
    logger: ctx.logger,
  });
  for (const r of results) {
    if (r.status === 'ok') {
      ctx.logger.info(`${r.handle}: pulled`);
    } else {
      ctx.logger.warn(`${r.handle}: FAILED — ${r.message ?? 'unknown'}`);
    }
  }

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    rebuildAll(db);
    if (existsSync(ctx.paths.entriesDir)) {
      const ownResult = scanSource({ db, source: 'own', entriesRoot: ctx.paths.entriesDir });
      ctx.logger.info(`own: +${ownResult.added}`);
    }
    for (const entry of readdirSync(ctx.paths.communityDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source: Source = `community/${entry.name}`;
      const root = join(ctx.paths.communityDir, entry.name, 'entries');
      if (!existsSync(root)) continue;
      const scan = scanSource({ db, source, entriesRoot: root });
      ctx.logger.info(`${source}: +${scan.added}`);
    }
  } finally {
    db.close();
  }
}
