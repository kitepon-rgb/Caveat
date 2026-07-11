import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { scanSource, walkMarkdown, type ScanResult } from './indexer.js';
import type { Source } from './types.js';
import type { Logger } from './db.js';
import type { ResolvedPaths } from './paths.js';

export interface EntriesDigest {
  digest: string;
  fileCount: number;
}

export interface DigestMarker extends EntriesDigest {
  generatedAt: string;
}

export interface ReindexLock {
  path: string;
}

export interface ReindexResult {
  perSource: Record<string, ScanResult>;
  fileCount: number;
}

function sourceRoots(paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'>): Array<{
  source: Source;
  root: string;
}> {
  const roots: Array<{ source: Source; root: string }> = [];
  if (existsSync(paths.entriesDir)) roots.push({ source: 'own', root: paths.entriesDir });
  if (!existsSync(paths.communityDir)) return roots;
  for (const entry of requireDirectories(paths.communityDir)) {
    const root = join(paths.communityDir, entry, 'entries');
    if (existsSync(root)) roots.push({ source: `community/${entry}`, root });
  }
  return roots;
}

function requireDirectories(root: string): string[] {
  // Kept small and synchronous: this runs on a detached worker except for
  // digest checks, where it must exactly mirror scanSource's walk.
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function computeEntriesDigest(
  paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'>,
): EntriesDigest {
  const lines: string[] = [];
  for (const { source, root } of sourceRoots(paths)) {
    for (const filePath of walkMarkdown(root)) {
      const stat = statSync(filePath);
      const rel = relative(root, filePath).replace(/\\/g, '/');
      lines.push(`${source}\t${rel}\t${stat.mtimeMs}\t${stat.size}`);
    }
  }
  lines.sort();
  return {
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
    fileCount: lines.length,
  };
}

function indexDir(caveatHome: string): string {
  return join(caveatHome, 'index');
}

function digestMarkerPath(caveatHome: string): string {
  return join(indexDir(caveatHome), '.entries-digest');
}

export function readDigestMarker(caveatHome: string): DigestMarker | null {
  try {
    const value = JSON.parse(readFileSync(digestMarkerPath(caveatHome), 'utf-8')) as unknown;
    if (
      value !== null && typeof value === 'object' &&
      typeof (value as DigestMarker).digest === 'string' &&
      typeof (value as DigestMarker).fileCount === 'number' &&
      typeof (value as DigestMarker).generatedAt === 'string'
    ) return value as DigestMarker;
  } catch {
    // Missing and malformed markers are intentionally both dirty.
  }
  return null;
}

export function writeDigestMarker(caveatHome: string, value: EntriesDigest): void {
  const dir = indexDir(caveatHome);
  mkdirSync(dir, { recursive: true });
  const path = digestMarkerPath(caveatHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...value, generatedAt: new Date().toISOString() }), 'utf-8');
  renameSync(temporary, path);
}

function lockPath(caveatHome: string): string {
  return join(indexDir(caveatHome), '.reindex-lock');
}

function tryCreateLock(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function acquireReindexLock(caveatHome: string): ReindexLock | null {
  const dir = indexDir(caveatHome);
  mkdirSync(dir, { recursive: true });
  const path = lockPath(caveatHome);
  if (tryCreateLock(path)) return { path };

  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return tryCreateLock(path) ? { path } : null;
    return null;
  }
  try {
    process.kill(pid, 0);
    return null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') return null;
  }
  try {
    unlinkSync(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return tryCreateLock(path) ? { path } : null;
}

export function releaseReindexLock(lock: ReindexLock): void {
  try {
    unlinkSync(lock.path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function reindexAllSources(opts: {
  db: DatabaseSync;
  paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'>;
  logger: Logger;
}): ReindexResult {
  const { db, paths, logger } = opts;
  const perSource: Record<string, ScanResult> = {};
  if (existsSync(paths.entriesDir)) {
    perSource.own = scanSource({ db, source: 'own', entriesRoot: paths.entriesDir });
  } else {
    logger.warn(`entries dir not found; preserving own index rows: ${paths.entriesDir}`);
  }

  const presentCommunitySources = new Set<string>();
  if (existsSync(paths.communityDir)) {
    for (const handle of requireDirectories(paths.communityDir)) {
      const source: Source = `community/${handle}`;
      const root = join(paths.communityDir, handle, 'entries');
      presentCommunitySources.add(source);
      if (!existsSync(root)) continue;
      perSource[source] = scanSource({ db, source, entriesRoot: root });
    }
  }
  const rows = db.prepare("SELECT DISTINCT source FROM entries WHERE source LIKE 'community/%'").all() as Array<{ source: string }>;
  for (const { source } of rows) {
    if (presentCommunitySources.has(source)) continue;
    db.prepare('DELETE FROM entries WHERE source = ?').run(source);
  }

  return { perSource, fileCount: computeEntriesDigest(paths).fileCount };
}
