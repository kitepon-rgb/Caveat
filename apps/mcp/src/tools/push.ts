import { z } from 'zod';
import { pushEntry } from '@caveat/core';
import type { McpContext } from '../context.js';

export const pushInputShape = {
  id: z.string().min(1).describe('Entry id (frontmatter.id) to push to the shared community DB'),
  dry_run: z
    .boolean()
    .optional()
    .describe('If true, compute the plan but do not modify GitHub or local git state'),
};

export type PushArgs = {
  id: string;
  dry_run?: boolean;
};

export async function handlePush(ctx: McpContext, args: PushArgs) {
  const result = await pushEntry({
    entriesDir: ctx.paths.entriesDir,
    caveatHome: ctx.caveatHome,
    sharedRepoUrl: ctx.config.sharedRepo,
    id: args.id,
    dryRun: args.dry_run ?? false,
    logger: ctx.logger,
  });
  return {
    status: result.status,
    detail: result.detail,
    pr_url: result.prUrl,
    planned_steps: result.plannedSteps,
  };
}
