import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, ensureUserConfig } from '@caveat/core';
import type { CliContext } from '../context.js';

export function runInit(ctx: CliContext): void {
  ensureUserConfig(ctx.userConfigPath);
  ctx.logger.info(`user config: ${ctx.userConfigPath}`);

  const dbDir = dirname(ctx.paths.dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  db.close();
  ctx.logger.info(`db initialized: ${ctx.paths.dbPath}`);

  const kRepoExists = existsSync(ctx.paths.knowledgeRepo);
  ctx.logger.info(
    `knowledge repo: ${ctx.paths.knowledgeRepo}${kRepoExists ? '' : ' (not found — create separately)'}`,
  );
}
