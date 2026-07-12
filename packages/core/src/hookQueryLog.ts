import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CAVEAT_HOOK_QUERY_LOG_ENV = 'CAVEAT_HOOK_QUERY_LOG';
export const HOOK_QUERY_LOG_MAX_BYTES = 1024 * 1024;
export const HOOK_QUERY_LOG_MAX_QUERY_CODE_UNITS = 1000;

export type HookQueryAgent = 'claude' | 'codex';
export type HookQuerySurface = 'user_prompt' | 'tool_error' | 'stop';

export interface HookQueryMiss {
  caveatHome: string;
  agent: HookQueryAgent;
  surface: HookQuerySurface;
  query: string;
}

export interface HookQueryLogDependencies {
  appendFileSync: typeof appendFileSync;
  chmodSync: typeof chmodSync;
  mkdirSync: typeof mkdirSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
}

const fsDependencies: HookQueryLogDependencies = {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
};

function isMissingPathError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

function chmodExistingFile(
  path: string,
  dependencies: HookQueryLogDependencies,
): void {
  try {
    dependencies.chmodSync(path, 0o600);
  } catch (err: unknown) {
    if (!isMissingPathError(err)) throw err;
  }
}

/**
 * Append an opt-in, privacy-minimized record for a successful zero-hit hook search.
 * Filesystem failures intentionally propagate so hook adapters can report them while
 * preserving their search result contract.
 */
export function logHookQueryMiss(
  miss: HookQueryMiss,
  dependencies: HookQueryLogDependencies = fsDependencies,
): void {
  if (process.env[CAVEAT_HOOK_QUERY_LOG_ENV] !== 'on') return;

  const metricsDir = join(resolve(miss.caveatHome), 'metrics');
  const activePath = join(metricsDir, 'hook-search-misses.jsonl');
  const backupPath = `${activePath}.1`;
  const record = JSON.stringify({
    at: new Date().toISOString(),
    agent: miss.agent,
    surface: miss.surface,
    query: miss.query.slice(0, HOOK_QUERY_LOG_MAX_QUERY_CODE_UNITS),
  }) + '\n';

  dependencies.mkdirSync(metricsDir, { recursive: true, mode: 0o700 });
  dependencies.chmodSync(metricsDir, 0o700);

  // Tighten any files left by an older process before inspecting, rotating,
  // or appending them. A chmod failure aborts the record entirely so no query
  // bytes are ever written while an existing file remains too permissive.
  chmodExistingFile(activePath, dependencies);
  chmodExistingFile(backupPath, dependencies);

  let activeSize = 0;
  try {
    activeSize = dependencies.statSync(activePath).size;
  } catch (err: unknown) {
    if (!isMissingPathError(err)) throw err;
  }
  if (activeSize + Buffer.byteLength(record, 'utf8') > HOOK_QUERY_LOG_MAX_BYTES) {
    try {
      dependencies.unlinkSync(backupPath);
    } catch (err: unknown) {
      if (!isMissingPathError(err)) throw err;
    }
    try {
      dependencies.renameSync(activePath, backupPath);
      dependencies.chmodSync(backupPath, 0o600);
    } catch (err: unknown) {
      if (!isMissingPathError(err)) throw err;
    }
  }

  dependencies.appendFileSync(activePath, record, { encoding: 'utf8', mode: 0o600 });
  dependencies.chmodSync(activePath, 0o600);
  try {
    dependencies.chmodSync(backupPath, 0o600);
  } catch (err: unknown) {
    if (!isMissingPathError(err)) throw err;
  }
}
