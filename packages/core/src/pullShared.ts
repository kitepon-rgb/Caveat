import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { communityPull } from './community.js';
import type { Logger } from './db.js';
import { rebuildAll, scanSource } from './indexer.js';
import type { Source } from './types.js';

export interface PullSharedOptions {
  /** Absolute path to the community dir (`<knowledgeRepo>/community/`). */
  communityDir: string;
  /** Absolute path to the user's own entries dir. */
  entriesDir: string;
  /** Open SQLite db handle. Caller owns it. */
  db: DatabaseSync;
  logger?: Logger;
}

export interface PullSharedResult {
  pulled: { handle: string; status: 'ok' | 'failed'; message?: string }[];
  indexed: { source: Source; added: number; updated: number; deleted: number }[];
}

/**
 * git-pull all subscribed community repos and re-index every source. Used by
 * both `caveat pull` (CLI) and `caveat_pull` (MCP) — Claude Code can call this
 * autonomously whenever it wants fresh community contributions.
 */
export async function pullShared(opts: PullSharedOptions): Promise<PullSharedResult> {
  const result: PullSharedResult = { pulled: [], indexed: [] };

  if (!existsSync(opts.communityDir)) {
    return result;
  }

  const pulls = await communityPull({
    communityDir: opts.communityDir,
    logger: opts.logger,
  });
  for (const p of pulls) {
    result.pulled.push({
      handle: p.handle,
      status: p.status,
      message: p.message,
    });
  }

  rebuildAll(opts.db);

  if (existsSync(opts.entriesDir)) {
    const own = scanSource({ db: opts.db, source: 'own', entriesRoot: opts.entriesDir });
    result.indexed.push({ source: 'own', ...own });
  }

  for (const entry of readdirSync(opts.communityDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source: Source = `community/${entry.name}`;
    const root = join(opts.communityDir, entry.name, 'entries');
    if (!existsSync(root)) continue;
    const scan = scanSource({ db: opts.db, source, entriesRoot: root });
    result.indexed.push({ source, ...scan });
  }

  return result;
}
