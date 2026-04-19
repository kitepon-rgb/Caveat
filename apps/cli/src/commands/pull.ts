import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { communityPull, openDb, rebuildAll, scanSource, type Source } from '@caveat/core';
import type { CliContext } from '../context.js';

export async function runPull(ctx: CliContext): Promise<void> {
  if (!existsSync(ctx.paths.communityDir)) {
    ctx.logger.info(
      'no community repos yet — add one with `caveat community add <github-url>`.',
    );
    return;
  }

  const pulls = await communityPull({
    communityDir: ctx.paths.communityDir,
    logger: ctx.logger,
  });
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
    if (existsSync(ctx.paths.entriesDir)) {
      const own = scanSource({ db, source: 'own', entriesRoot: ctx.paths.entriesDir });
      ctx.logger.info(`own: +${own.added}`);
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
