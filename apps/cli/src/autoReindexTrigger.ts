import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeEntriesDigest, readDigestMarker } from '@caveat/core';
import type { CliContext } from './context.js';

export function maybeTriggerAutoReindex(ctx: CliContext): void {
  if (process.env.CAVEAT_INDEX_AUTOSYNC === 'off') return;
  if (!existsSync(ctx.paths.dbPath)) return;
  if (existsSync(join(ctx.caveatHome, 'index', '.reindex-lock'))) return;
  const current = computeEntriesDigest(ctx.paths);
  const marker = readDigestMarker(ctx.caveatHome);
  if (marker?.digest === current.digest && marker.fileCount === current.fileCount) return;

  const cliScript = process.argv[1];
  if (!cliScript) throw new Error('current Caveat CLI script path is unavailable');
  const child = spawn(
    process.execPath,
    // execArgv を継承して親と同じランタイム（例: テストハーネスの --import tsx）で
    // worker を起動する。素の node だと TS ソース実行のテスト環境で worker が即死する。
    [...process.execArgv, '--disable-warning=ExperimentalWarning', cliScript, 'hook', 'reindex'],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}
