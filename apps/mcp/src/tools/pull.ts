import { existsSync } from 'node:fs';
import {
  communityPull,
  createKeyserverKeyProvider,
  prewarmSealedKeys,
  reindexAllSources,
  type Source,
} from '@caveat/core';
import type { McpContext } from '../context.js';

export const pullInputShape = {};

export type PullArgs = Record<string, never>;

export async function handlePull(ctx: McpContext, _args: PullArgs = {}) {
  const pulled: { handle: string; status: 'ok' | 'failed'; message?: string }[] = [];
  const indexed: { source: Source; added: number; updated: number; deleted: number }[] = [];

  if (existsSync(ctx.paths.communityDir)) {
    const results = await communityPull({
      communityDir: ctx.paths.communityDir,
      logger: ctx.logger,
    });
    for (const r of results) {
      pulled.push({ handle: r.handle, status: r.status, message: r.message });
    }
  }

  const keyProvider = createKeyserverKeyProvider({ caveatHome: ctx.caveatHome });
  const failures = await prewarmSealedKeys({ paths: ctx.paths, keyProvider });
  for (const failure of failures) {
    ctx.logger.warn(`${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}`);
  }

  const result = reindexAllSources({
    db: ctx.db,
    paths: ctx.paths,
    logger: ctx.logger,
    keyProvider,
  });
  for (const [source, scan] of Object.entries(result.perSource)) {
    indexed.push({ source: source as Source, ...scan });
  }

  return { pulled, indexed };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
