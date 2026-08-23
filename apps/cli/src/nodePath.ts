import { existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { nodeExecutableNames } from '@caveat/core';

type RealpathFn = (path: string) => string;

const defaultRealpath: RealpathFn = (path) => realpathSync.native(path);

function safeRealpath(path: string, realpath: RealpathFn = defaultRealpath): string | null {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

export function resolveHookNodePath({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  exists = existsSync,
  realpath = defaultRealpath,
}: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
} = {}): string {
  const execRealpath = safeRealpath(execPath, realpath);
  const pathEnv = env.PATH ?? env.Path ?? '';
  const names = nodeExecutableNames(platform);

  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!exists(candidate)) continue;
      const candidateRealpath = safeRealpath(candidate, realpath);
      if (execRealpath && candidateRealpath && candidateRealpath === execRealpath) {
        return candidate;
      }
    }
  }

  return execPath;
}
