import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { simpleGit } from 'simple-git';
import type { Logger } from './db.js';

const GITHUB_URL_RE = /^https:\/\/github\.com\/[^/]+\/([^/]+?)(\.git)?\/?$/;

export interface UrlValidation {
  valid: boolean;
  handle?: string;
  reason?: string;
}

export function validateCommunityUrl(url: string): UrlValidation {
  const trimmed = (url ?? '').trim();
  const m = GITHUB_URL_RE.exec(trimmed);
  if (!m) {
    return {
      valid: false,
      reason: 'v1 is GitHub-only; URL must match ^https://github\\.com/<org>/<repo>(\\.git)?$',
    };
  }
  const handle = m[1]!.replace(/\.git$/, '');
  if (!handle || handle === '.' || handle === '..') {
    return { valid: false, reason: 'repo name is empty or reserved' };
  }
  return { valid: true, handle };
}

export function resolveHandleCollision(
  baseHandle: string,
  exists: (h: string) => boolean,
): string {
  if (!exists(baseHandle)) return baseHandle;
  let n = 2;
  while (exists(`${baseHandle}-${n}`)) n++;
  return `${baseHandle}-${n}`;
}

export interface CommunityAddOptions {
  url: string;
  communityDir: string;
  depth?: number;
  logger?: Logger;
}

export interface CommunityAddResult {
  handle: string;
  path: string;
}

export async function communityAdd(opts: CommunityAddOptions): Promise<CommunityAddResult> {
  const validation = validateCommunityUrl(opts.url);
  if (!validation.valid) {
    throw new Error(`invalid community URL: ${validation.reason}`);
  }
  const handle = resolveHandleCollision(validation.handle!, (h) =>
    existsSync(join(opts.communityDir, h)),
  );
  const target = join(opts.communityDir, handle);
  const depth = opts.depth ?? 1;

  const git = simpleGit();
  await git.clone(opts.url, target, ['--depth', String(depth)]);

  return { handle, path: target };
}

export interface CommunityPullOptions {
  communityDir: string;
  logger?: Logger;
}

export interface CommunityPullResult {
  handle: string;
  path: string;
  status: 'ok' | 'failed';
  message?: string;
}

export async function communityPull(
  opts: CommunityPullOptions,
): Promise<CommunityPullResult[]> {
  if (!existsSync(opts.communityDir)) return [];
  const results: CommunityPullResult[] = [];
  for (const entry of readdirSync(opts.communityDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(opts.communityDir, entry.name);
    const git = simpleGit(path);
    try {
      await git.pull();
      results.push({ handle: entry.name, path, status: 'ok' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ handle: entry.name, path, status: 'failed', message });
    }
  }
  return results;
}

export interface CommunityListOptions {
  communityDir: string;
  db: DatabaseSync;
}

export interface CommunityListEntry {
  handle: string;
  path: string;
  entryCount: number;
}

export function communityList(opts: CommunityListOptions): CommunityListEntry[] {
  if (!existsSync(opts.communityDir)) return [];
  const out: CommunityListEntry[] = [];
  for (const entry of readdirSync(opts.communityDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(opts.communityDir, entry.name);
    const row = opts.db
      .prepare('SELECT COUNT(*) AS n FROM entries WHERE source = ?')
      .get(`community/${entry.name}`) as { n: number } | undefined;
    out.push({ handle: entry.name, path, entryCount: row?.n ?? 0 });
  }
  return out;
}

export interface CommunityRemoveOptions {
  communityDir: string;
  handle: string;
  db: DatabaseSync;
  dryRun?: boolean;
  logger?: Logger;
}

export interface CommunityRemoveResult {
  handle: string;
  path: string;
  dirExisted: boolean;
  rowCount: number;
  removed: boolean;
  dryRun: boolean;
}

export function communityRemove(opts: CommunityRemoveOptions): CommunityRemoveResult {
  const handle = (opts.handle ?? '').trim();
  if (!handle) {
    throw new Error('handle is required');
  }
  if (handle === '.' || handle === '..' || /[\\/]/.test(handle)) {
    throw new Error(`invalid handle (no path separators or relative segments): ${opts.handle}`);
  }

  const target = join(opts.communityDir, handle);
  const dirExisted = existsSync(target) && statSync(target).isDirectory();

  const source = `community/${handle}`;
  const row = opts.db
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE source = ?')
    .get(source) as { n: number } | undefined;
  const rowCount = row?.n ?? 0;

  if (opts.dryRun) {
    return { handle, path: target, dirExisted, rowCount, removed: false, dryRun: true };
  }

  if (dirExisted) {
    rmSync(target, { recursive: true, force: true });
  }
  if (rowCount > 0) {
    opts.db.prepare('DELETE FROM entries WHERE source = ?').run(source);
  }

  return {
    handle,
    path: target,
    dirExisted,
    rowCount,
    removed: dirExisted || rowCount > 0,
    dryRun: false,
  };
}
