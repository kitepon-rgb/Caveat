import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { communityPull, rebuildAll, scanSource, type Source } from '@caveat/core';
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

  rebuildAll(ctx.db);
  if (existsSync(ctx.paths.entriesDir)) {
    const own = scanSource({ db: ctx.db, source: 'own', entriesRoot: ctx.paths.entriesDir });
    indexed.push({ source: 'own', ...own });
  }
  if (existsSync(ctx.paths.communityDir)) {
    for (const entry of readdirSync(ctx.paths.communityDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source: Source = `community/${entry.name}`;
      const root = join(ctx.paths.communityDir, entry.name, 'entries');
      if (!existsSync(root)) continue;
      const scan = scanSource({ db: ctx.db, source, entriesRoot: root });
      indexed.push({ source, ...scan });
    }
  }

  return { pulled, indexed };
}
