import { pullShared } from '@caveat/core';
import type { McpContext } from '../context.js';

export const pullInputShape = {};

export type PullArgs = Record<string, never>;

export async function handlePull(ctx: McpContext, _args: PullArgs = {}) {
  const result = await pullShared({
    communityDir: ctx.paths.communityDir,
    entriesDir: ctx.paths.entriesDir,
    db: ctx.db,
    logger: ctx.logger,
  });
  return {
    pulled: result.pulled,
    indexed: result.indexed.map((i) => ({
      source: i.source,
      added: i.added,
      updated: i.updated,
      deleted: i.deleted,
    })),
  };
}
