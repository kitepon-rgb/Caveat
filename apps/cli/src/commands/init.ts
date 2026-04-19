import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureUserConfig, openDb } from '@caveat/core';

const KNOWLEDGE_GITIGNORE = [
  '# Never commit entries flagged private (visibility: private is enforced by the',
  '# pre-commit gate, but this is a filename-level backup guard).',
  '*.private.md',
  '',
  '# Obsidian per-user config: workspace layout, theme, plugin state, cache.',
  '.obsidian/',
  '',
].join('\n');
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

export async function runInit(
  ctx: CliContext,
  opts: InitOptions = { skipClaude: false, dryRun: false },
): Promise<void> {
  ensureUserConfig(ctx.userConfigPath);
  ctx.logger.info(`user config: ${ctx.userConfigPath}`);

  if (!existsSync(ctx.paths.knowledgeRepo)) {
    mkdirSync(ctx.paths.knowledgeRepo, { recursive: true });
    mkdirSync(ctx.paths.entriesDir, { recursive: true });
    ctx.logger.info(`knowledge repo scaffolded: ${ctx.paths.knowledgeRepo}`);
  } else {
    ctx.logger.info(`knowledge repo: ${ctx.paths.knowledgeRepo}`);
  }

  migrateLegacyCommunityDir(ctx);

  const gitignorePath = join(ctx.paths.knowledgeRepo, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, KNOWLEDGE_GITIGNORE, 'utf-8');
    ctx.logger.info(`.gitignore created: ${gitignorePath}`);
  }

  if (!opts.dryRun) {
    const dbDir = dirname(ctx.paths.dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
    db.close();
    ctx.logger.info(`db initialized: ${ctx.paths.dbPath}`);
  } else {
    ctx.logger.info(`[dry-run] db path: ${ctx.paths.dbPath}`);
  }
  ctx.logger.info(
    'tip: subscribe to a group repo with `caveat community add <github-url>`, then `caveat pull`.',
  );

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

/**
 * v0.6.1 の paths 修正で `community/` の位置が `<knowledgeRepo>/community/` から
 * `<caveatHome>/community/` に移った。既存インストールは旧位置に clone を持つので、
 * 1 回だけ自動で移す。現行位置が既に存在する場合は何もしない（冪等）。
 */
function migrateLegacyCommunityDir(ctx: CliContext): void {
  const legacy = join(ctx.paths.knowledgeRepo, 'community');
  const current = ctx.paths.communityDir;
  if (legacy === current) return;
  if (!existsSync(legacy)) return;
  if (existsSync(current)) {
    ctx.logger.warn(
      `legacy community dir still exists at ${legacy} — remove manually (new location in use)`,
    );
    return;
  }
  mkdirSync(current, { recursive: true });
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    renameSync(join(legacy, entry.name), join(current, entry.name));
  }
  try {
    rmdirSync(legacy);
  } catch {
    // legacy dir has leftover files we didn't touch — leave it
  }
  ctx.logger.info(`migrated legacy community/ → ${current}`);
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
