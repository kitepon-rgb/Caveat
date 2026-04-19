import { existsSync } from 'node:fs';
import { openDb, pullShared } from '@caveat/core';
import type { CliContext } from '../context.js';

export async function runPull(ctx: CliContext): Promise<void> {
  if (!existsSync(ctx.paths.communityDir)) {
    ctx.logger.info(
      'no community repos yet — did you run `caveat init`? ' +
        'You can also `caveat community add <url>` manually.',
    );
    return;
  }

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const result = await pullShared({
      communityDir: ctx.paths.communityDir,
      entriesDir: ctx.paths.entriesDir,
      db,
      logger: ctx.logger,
    });
    for (const p of result.pulled) {
      if (p.status === 'ok') {
        ctx.logger.info(`${p.handle}: pulled`);
      } else {
        ctx.logger.warn(`${p.handle}: FAILED — ${p.message ?? 'unknown'}`);
      }
    }
    for (const i of result.indexed) {
      ctx.logger.info(`${i.source}: +${i.added}`);
    }
  } finally {
    db.close();
  }
}
