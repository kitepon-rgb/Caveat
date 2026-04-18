import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findToolRoot(startFrom?: string): string {
  let dir = startFrom ?? dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('Could not locate tool repo root (pnpm-workspace.yaml not found)');
    }
    dir = parent;
  }
}

export function expandHome(p: string, userHome: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return join(userHome, p.slice(1));
  }
  return p;
}

export interface ResolvedPaths {
  toolRoot: string;
  knowledgeRepo: string;
  dbPath: string;
  entriesDir: string;
  communityDir: string;
}

export function resolvePaths(toolRoot: string, knowledgeRepo: string, userHome: string): ResolvedPaths {
  const expanded = expandHome(knowledgeRepo, userHome);
  const resolved = resolve(toolRoot, expanded);
  return {
    toolRoot,
    knowledgeRepo: resolved,
    dbPath: join(toolRoot, '.index', 'caveat.db'),
    entriesDir: join(resolved, 'entries'),
    communityDir: join(resolved, 'community'),
  };
}
