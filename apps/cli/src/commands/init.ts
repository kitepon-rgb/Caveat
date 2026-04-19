import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  communityAdd,
  openDb,
  ensureUserConfig,
  rebuildAll,
  scanSource,
  validateCommunityUrl,
  type Source,
} from '@caveat/core';

const KNOWLEDGE_GITIGNORE = [
  '# Never commit entries flagged private (visibility: private is enforced by the',
  '# pre-commit gate, but this is a filename-level backup guard).',
  '*.private.md',
  '',
  '# Obsidian per-user config: workspace layout, theme, plugin state, cache.',
  '.obsidian/',
  '',
  '# community/ is a local cache of shallow-cloned third-party caveat repos',
  '# (populated by `caveat community add`). Each contains its own .git and is not',
  "# part of this repo's tracked knowledge.",
  'community/',
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
  skipShared: boolean;
  dryRun: boolean;
}

export async function runInit(
  ctx: CliContext,
  opts: InitOptions = { skipClaude: false, skipShared: false, dryRun: false },
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

  const gitignorePath = join(ctx.paths.knowledgeRepo, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, KNOWLEDGE_GITIGNORE, 'utf-8');
    ctx.logger.info(`.gitignore created: ${gitignorePath}`);
  }

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    if (!opts.skipShared && !opts.dryRun) {
      await subscribeSharedRepo(ctx, db);
    } else if (opts.skipShared) {
      ctx.logger.info('shared community DB subscription skipped (--skip-shared)');
    } else if (opts.dryRun) {
      ctx.logger.info(`[dry-run] would subscribe to shared community DB: ${ctx.config.sharedRepo}`);
    }
  } finally {
    db.close();
  }
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

async function subscribeSharedRepo(
  ctx: CliContext,
  db: ReturnType<typeof openDb>,
): Promise<void> {
  const url = ctx.config.sharedRepo;
  const validation = validateCommunityUrl(url);
  if (!validation.valid) {
    ctx.logger.warn(
      `sharedRepo is not a valid GitHub URL — skipping: ${validation.reason}`,
    );
    return;
  }
  const handle = validation.handle!;
  const target = join(ctx.paths.communityDir, handle);

  if (!existsSync(target)) {
    if (!existsSync(ctx.paths.communityDir)) {
      mkdirSync(ctx.paths.communityDir, { recursive: true });
    }
    try {
      await communityAdd({
        url,
        communityDir: ctx.paths.communityDir,
        logger: ctx.logger,
      });
      ctx.logger.info(`shared community DB subscribed: ${url} → community/${handle}/`);
    } catch (err) {
      ctx.logger.warn(
        `shared community DB subscription failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  } else {
    ctx.logger.info(`shared community DB already subscribed: community/${handle}/`);
  }

  // Index the shared repo so entries are searchable immediately.
  if (existsSync(ctx.paths.communityDir)) {
    rebuildAll(db);
    if (existsSync(ctx.paths.entriesDir)) {
      scanSource({ db, source: 'own', entriesRoot: ctx.paths.entriesDir });
    }
    for (const entry of readdirSync(ctx.paths.communityDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source: Source = `community/${entry.name}`;
      const root = join(ctx.paths.communityDir, entry.name, 'entries');
      if (!existsSync(root)) continue;
      const result = scanSource({ db, source, entriesRoot: root });
      ctx.logger.info(`indexed ${source}: +${result.added}`);
    }
  }
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
