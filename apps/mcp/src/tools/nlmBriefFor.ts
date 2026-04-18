import { z } from 'zod';
import { generateBrief } from '@caveat/core';
import type { McpContext } from '../context.js';

export const nlmBriefForInputShape = {
  topic: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
};

export type NlmBriefForArgs = { topic: string; limit?: number };

export function handleNlmBriefFor(ctx: McpContext, args: NlmBriefForArgs) {
  return generateBrief(ctx.db, args.topic, args.limit);
}
