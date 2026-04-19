import { pushEntry } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface PushOptions {
  id: string;
  dryRun: boolean;
}

export async function runPush(ctx: CliContext, opts: PushOptions): Promise<void> {
  const result = await pushEntry({
    entriesDir: ctx.paths.entriesDir,
    caveatHome: ctx.caveatHome,
    sharedRepoUrl: ctx.config.sharedRepo,
    id: opts.id,
    dryRun: opts.dryRun,
    logger: ctx.logger,
  });

  switch (result.status) {
    case 'ok':
      ctx.logger.info(`PR opened: ${result.prUrl ?? ''}`);
      ctx.logger.info(
        'Once merged, other subscribers will see your entry after their next `caveat pull`.',
      );
      break;
    case 'dry-run':
      for (const [i, step] of (result.plannedSteps ?? []).entries()) {
        ctx.logger.info(`[dry-run] ${i + 1}. ${step}`);
      }
      break;
    case 'not-found':
      ctx.logger.error(
        `${result.detail}. List entries with \`caveat list\` or write + index first.`,
      );
      process.exitCode = 1;
      break;
    case 'gh-missing':
    case 'gh-unauthed':
      ctx.logger.error(result.detail ?? 'gh CLI issue');
      process.exitCode = 1;
      break;
    case 'failed':
      ctx.logger.error(result.detail ?? 'unknown failure');
      process.exitCode = 1;
      break;
  }
}
