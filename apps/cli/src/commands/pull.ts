import { existsSync } from 'node:fs';
import {
  communityPull,
  computeEntriesDigest,
  createKeyserverKeyProvider,
  openDb,
  prewarmSealedKeys,
  reindexAllSources,
  writeDigestMarker,
} from '@caveat/core';
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
    const keyProvider = createKeyserverKeyProvider({ caveatHome: ctx.caveatHome });
    const failures = await prewarmSealedKeys({ paths: ctx.paths, keyProvider });
    for (const failure of failures) {
      ctx.logger.warn(`${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}`);
    }
    const result = reindexAllSources({ db, paths: ctx.paths, logger: ctx.logger, keyProvider });
    for (const [source, scan] of Object.entries(result.perSource)) {
      ctx.logger.info(`${source}: +${scan.added}`);
    }
    writeDigestMarker(ctx.caveatHome, computeEntriesDigest(ctx.paths));
  } finally {
    db.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
