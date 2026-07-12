import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { publishOwn, PublishScanError, writeUserConfigPatch, type PublishChanges } from '@caveat/core';
import type { CliContext } from '../context.js';
import { askOnce, defaultGitHubRepoUrl, runGh, type GhRunner } from '../ghSetup.js';
import {
  formatCodexSidecarAdvisory,
  formatCodexSidecarAdvisoryUnavailable,
  runCodexSidecarAdvisory,
} from './codexSidecarAdvisory.js';

const HTTPS_TARGET_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/;
const SCP_TARGET_RE = /^git@github\.com:[^/]+\/[^/]+?(?:\.git)?$/;

export interface PublishCmdOptions { init?: string; dryRun: boolean; yes: boolean; allow?: string[]; save?: boolean; }
export interface PublishCmdDependencies {
  ghRunner?: GhRunner;
  isTty?: () => boolean;
  confirm?: (question: string) => boolean;
  hasCodexSidecarConfig?: (projectRoot: string) => boolean;
  runCodexSidecarAdvisory?: (changes: PublishChanges, projectRoot: string) => string;
}

export function validatePublishTarget(url: string): string {
  if (!HTTPS_TARGET_RE.test(url) && !SCP_TARGET_RE.test(url)) throw new Error('invalid publish target: use https://github.com/<org>/<repo>(.git) or git@github.com:<org>/<repo>(.git)');
  return url;
}

async function defaultPublicRepoUrl(opts: PublishCmdOptions, deps: Pick<Required<PublishCmdDependencies>, 'ghRunner' | 'isTty' | 'confirm'>): Promise<string> {
  return defaultGitHubRepoUrl({
    repositoryName: 'Caveat-Public',
    visibility: 'public',
    yes: opts.yes,
    retryCommand: 'caveat publish --init <url>',
    ...deps,
  });
}

export async function runPublish(ctx: CliContext, opts: PublishCmdOptions, dependencies: PublishCmdDependencies = {}): Promise<void> {
  try {
    const ghRunner = dependencies.ghRunner ?? runGh;
    const isTty = dependencies.isTty ?? (() => Boolean(process.stdin.isTTY));
    const confirm = dependencies.confirm ?? askOnce;
    const projectRoot = process.cwd();
    const hasCodexSidecarConfig = dependencies.hasCodexSidecarConfig ?? ((root) => existsSync(join(root, '.codex-sidecar.yml')));
    const publishAdvisory = hasCodexSidecarConfig(projectRoot)
      ? (changes: PublishChanges) => {
        try {
          return dependencies.runCodexSidecarAdvisory?.(changes, projectRoot) ?? formatCodexSidecarAdvisory(runCodexSidecarAdvisory({
            searchText: changes.lines.join('\n'),
            limit: Math.max(changes.lines.length, 1),
            projectRoot,
            prompt: 'A public Caveat publish is pending. Use Caveat context to give concise advice about privacy or secret risk. Advisory only: do not authorize or block this publish.',
          }));
        } catch (err: unknown) {
          return formatCodexSidecarAdvisoryUnavailable(err);
        }
      }
      : undefined;
    let target = ctx.config.publishTarget;
    if (opts.init !== undefined) {
      target = validatePublishTarget(opts.init);
      writeUserConfigPatch(ctx.userConfigPath, { publishTarget: target });
    }
    if (!target) {
      target = await defaultPublicRepoUrl(opts, { ghRunner, isTty, confirm });
      writeUserConfigPatch(ctx.userConfigPath, { publishTarget: target });
    }
    const result = await publishOwn({
      paths: ctx.paths,
      config: { ...ctx.config, publishTarget: target },
      logger: ctx.logger,
      confirmImpl: confirm,
      isTty,
      dryRun: opts.dryRun,
      yes: opts.yes,
      allow: opts.allow,
      saveAllow: opts.save,
      advisory: publishAdvisory,
    });
    if (result.dryRun) ctx.logger.info(`[dry-run] ${result.fileCount} public entry(ies) ready to publish`);
    else if (result.changed) ctx.logger.info(`published ${result.fileCount} public entry(ies)`);
  } catch (err) {
    if (err instanceof PublishScanError) {
      for (const finding of err.findings) {
        ctx.logger.error(`${finding.relPath}:${finding.line} ${finding.rule} ${finding.excerpt}`);
        ctx.logger.error(`  --allow ${finding.matchDigest}`);
      }
      process.exitCode = 1;
      return;
    }
    ctx.logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
