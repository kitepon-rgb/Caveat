import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, ensureUserConfig } from '@caveat/core';
import type { CliContext } from '../context.js';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  type ClaudeInstallResult,
} from '../claudeInstall.js';

export interface InitOptions {
  skipClaude: boolean;
  dryRun: boolean;
}

export function runInit(ctx: CliContext, opts: InitOptions = { skipClaude: false, dryRun: false }): void {
  ensureUserConfig(ctx.userConfigPath);
  ctx.logger.info(`user config: ${ctx.userConfigPath}`);

  if (!existsSync(ctx.paths.knowledgeRepo)) {
    mkdirSync(ctx.paths.knowledgeRepo, { recursive: true });
    mkdirSync(ctx.paths.entriesDir, { recursive: true });
    ctx.logger.info(`knowledge repo scaffolded: ${ctx.paths.knowledgeRepo}`);
  } else {
    ctx.logger.info(`knowledge repo: ${ctx.paths.knowledgeRepo}`);
  }

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  db.close();
  ctx.logger.info(`db initialized: ${ctx.paths.dbPath}`);

  if (opts.skipClaude) {
    ctx.logger.info('Claude Code integration skipped (--skip-claude)');
    return;
  }

  const cliScriptPath = process.argv[1];
  if (!cliScriptPath) {
    ctx.logger.warn('cannot determine CLI script path; skipping Claude integration');
    return;
  }

  const result = installClaudeIntegration({
    claudeDir: join(ctx.userHome, '.claude'),
    cliScriptPath,
    nodePath: process.execPath,
    dryRun: opts.dryRun,
    logger: ctx.logger,
  });
  reportInstallResult(ctx, result, opts.dryRun);
}

export interface UninstallOptions {
  dryRun: boolean;
}

export function runUninstall(ctx: CliContext, opts: UninstallOptions): void {
  const cliScriptPath = process.argv[1];
  if (!cliScriptPath) {
    ctx.logger.error('cannot determine CLI script path');
    process.exit(1);
  }

  const result = uninstallClaudeIntegration({
    claudeDir: join(ctx.userHome, '.claude'),
    cliScriptPath,
    nodePath: process.execPath,
    dryRun: opts.dryRun,
    logger: ctx.logger,
  });

  ctx.logger.info(
    `MCP: ${result.mcp.action}${result.mcp.detail ? ` (${result.mcp.detail})` : ''}`,
  );
  ctx.logger.info(
    `UserPromptSubmit hook: ${result.hooks.userPromptSubmit === 'added' ? 'removed' : 'not present'}`,
  );
  ctx.logger.info(
    `Stop hook: ${result.hooks.stop === 'added' ? 'removed' : 'not present'}`,
  );
  if (result.backupPath) {
    ctx.logger.info(`settings.json backed up: ${result.backupPath}`);
  }
}

function reportInstallResult(
  ctx: CliContext,
  result: ClaudeInstallResult,
  dryRun: boolean,
): void {
  const prefix = dryRun ? '[dry-run] ' : '';
  ctx.logger.info(
    `${prefix}MCP: ${result.mcp.action}${result.mcp.detail ? ` (${result.mcp.detail})` : ''}`,
  );
  ctx.logger.info(
    `${prefix}UserPromptSubmit hook: ${result.hooks.userPromptSubmit}`,
  );
  ctx.logger.info(`${prefix}Stop hook: ${result.hooks.stop}`);
  if (result.backupPath) {
    ctx.logger.info(`settings.json backed up: ${result.backupPath}`);
  }
  if (!dryRun && result.mcp.action === 'registered') {
    ctx.logger.info('next: restart Claude Code, then try /mcp to see the caveat server');
  }
}
