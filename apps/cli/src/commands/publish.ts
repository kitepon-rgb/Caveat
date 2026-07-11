import { publishOwn, writeUserConfigPatch } from '@caveat/core';
import type { CliContext } from '../context.js';
import { askOnce, commandError, runGh, type GhRunner } from '../ghSetup.js';

const HTTPS_TARGET_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/;
const SCP_TARGET_RE = /^git@github\.com:[^/]+\/[^/]+?(?:\.git)?$/;

export interface PublishCmdOptions { init?: string; dryRun: boolean; yes: boolean; }
export interface PublishCmdDependencies { ghRunner?: GhRunner; isTty?: () => boolean; confirm?: (question: string) => boolean; }

function validatePublishTarget(url: string): string {
  if (!HTTPS_TARGET_RE.test(url) && !SCP_TARGET_RE.test(url)) throw new Error('invalid publish target: use https://github.com/<org>/<repo>(.git) or git@github.com:<org>/<repo>(.git)');
  return url;
}

async function defaultPublicRepoUrl(opts: PublishCmdOptions, deps: Required<PublishCmdDependencies>): Promise<string> {
  const version = deps.ghRunner(['--version']);
  if (version.status !== 0) throw new Error('gh is not available. create a public repository named Caveat-Public on GitHub, then run:\n  caveat publish --init <url>\n  # or install gh and run caveat publish');
  const user = deps.ghRunner(['api', 'user', '-q', '.login']);
  if (user.status !== 0 || !user.stdout.trim()) throw new Error('gh is not authenticated; run `gh auth login`, then retry `caveat publish`');
  const login = user.stdout.trim();
  const name = `${login}/Caveat-Public`;
  const view = deps.ghRunner(['repo', 'view', name]);
  if (view.status !== 0) {
    const question = `create public repo github.com/${name}? [y/N]`;
    if (!opts.yes) {
      if (!deps.isTty()) throw new Error(`${question}; rerun with --yes to approve non-interactively`);
      if (!deps.confirm(question)) throw new Error('public repository creation cancelled');
    }
    const create = deps.ghRunner(['repo', 'create', 'Caveat-Public', '--public']);
    if (create.status !== 0) throw commandError(create, 'gh repo create failed');
  }
  return `https://github.com/${name}.git`;
}

export async function runPublish(ctx: CliContext, opts: PublishCmdOptions, dependencies: PublishCmdDependencies = {}): Promise<void> {
  try {
    const ghRunner = dependencies.ghRunner ?? runGh;
    const isTty = dependencies.isTty ?? (() => Boolean(process.stdin.isTTY));
    const confirm = dependencies.confirm ?? askOnce;
    let target = ctx.config.publishTarget;
    if (opts.init !== undefined) {
      target = validatePublishTarget(opts.init);
      writeUserConfigPatch(ctx.userConfigPath, { publishTarget: target });
    }
    if (!target) {
      target = await defaultPublicRepoUrl(opts, { ghRunner, isTty, confirm });
      writeUserConfigPatch(ctx.userConfigPath, { publishTarget: target });
    }
    const result = await publishOwn({ paths: ctx.paths, config: { ...ctx.config, publishTarget: target }, logger: ctx.logger, confirmImpl: confirm, isTty, dryRun: opts.dryRun, yes: opts.yes });
    if (result.dryRun) ctx.logger.info(`[dry-run] ${result.fileCount} public entry(ies) ready to publish`);
    else if (result.changed) ctx.logger.info(`published ${result.fileCount} public entry(ies)`);
  } catch (err) {
    ctx.logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
