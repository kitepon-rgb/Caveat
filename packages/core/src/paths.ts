import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dev-mode helper: walks upward until it finds pnpm-workspace.yaml.
 * Only meaningful in a git checkout of this repo — not used at runtime by
 * installed builds. Returns undefined when called from a location that is not
 * inside a pnpm workspace (e.g. `node_modules/caveat-cli/dist/`).
 */
export function findToolRoot(startFrom?: string): string | undefined {
  let dir = startFrom ?? dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function expandHome(p: string, userHome: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return join(userHome, p.slice(1));
  }
  return p;
}

/**
 * The per-user data root. Defaults to `~/.caveat/` but overridable via
 * `CAVEAT_HOME` for test isolation and advanced users.
 */
export function findCaveatHome(userHome: string): string {
  const fromEnv = process.env.CAVEAT_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(userHome, '.caveat');
}

export interface ResolvedPaths {
  caveatHome: string;
  knowledgeRepo: string;
  dbPath: string;
  entriesDir: string;
  communityDir: string;
}

export function resolvePaths(
  caveatHome: string,
  knowledgeRepo: string,
  userHome: string,
): ResolvedPaths {
  const expanded = expandHome(knowledgeRepo, userHome);
  const resolved = isAbsolute(expanded) ? expanded : resolve(caveatHome, expanded);
  return {
    caveatHome,
    knowledgeRepo: resolved,
    dbPath: join(caveatHome, 'index', 'caveat.db'),
    entriesDir: join(resolved, 'entries'),
    communityDir: join(resolved, 'community'),
  };
}
