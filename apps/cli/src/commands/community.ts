import {
  communityAdd,
  communityList,
  communityPull,
  communityRemove,
  openDb,
} from '@caveat/core';
import type { CliContext } from '../context.js';

export async function runCommunityAdd(ctx: CliContext, url: string): Promise<void> {
  try {
    const result = await communityAdd({
      url,
      communityDir: ctx.paths.communityDir,
      logger: ctx.logger,
    });
    ctx.logger.info(`added ${result.handle} → ${result.path}`);
    ctx.logger.info('run `caveat index` to pick up its entries');
  } catch (err) {
    ctx.logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function runCommunityPull(ctx: CliContext): Promise<void> {
  const results = await communityPull({
    communityDir: ctx.paths.communityDir,
    logger: ctx.logger,
  });
  if (results.length === 0) {
    ctx.logger.info('no community repos — use `caveat community add <github-url>` to import');
    return;
  }
  for (const r of results) {
    if (r.status === 'ok') {
      ctx.logger.info(`${r.handle}: pulled`);
    } else {
      ctx.logger.warn(`${r.handle}: FAILED — ${r.message ?? 'unknown'}`);
    }
  }
  ctx.logger.info('run `caveat index` to refresh the index');
}

export function runCommunityList(ctx: CliContext): void {
  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const entries = communityList({ communityDir: ctx.paths.communityDir, db });
    if (entries.length === 0) {
      process.stdout.write('(no community repos)\n');
      return;
    }
    for (const e of entries) {
      process.stdout.write(`${e.handle}  (${e.entryCount} entries)  ${e.path}\n`);
    }
  } finally {
    db.close();
  }
}

export interface CommunityRemoveCmdOptions {
  dryRun: boolean;
}

export function runCommunityRemove(
  ctx: CliContext,
  handle: string,
  opts: CommunityRemoveCmdOptions,
): void {
  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const result = communityRemove({
      communityDir: ctx.paths.communityDir,
      handle,
      db,
      dryRun: opts.dryRun,
      logger: ctx.logger,
    });

    if (!result.dirExisted && result.rowCount === 0) {
      ctx.logger.warn(`no community subscription named "${handle}" — nothing to remove`);
      return;
    }

    const prefix = result.dryRun ? '[dry-run] would ' : '';
    if (result.dirExisted) {
      ctx.logger.info(`${prefix}remove dir: ${result.path}`);
    }
    if (result.rowCount > 0) {
      ctx.logger.info(
        `${prefix}delete ${result.rowCount} db row(s) for source=community/${handle}`,
      );
    }
  } catch (err) {
    ctx.logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
