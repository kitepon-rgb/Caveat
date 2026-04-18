import { z } from 'zod';
import { listRecent } from '@caveat/core';
import type { McpContext } from '../context.js';

export const listRecentInputShape = {
  limit: z.number().int().min(1).max(200).optional(),
};

export type ListRecentArgs = { limit?: number };

export function handleListRecent(ctx: McpContext, args: ListRecentArgs) {
  return listRecent(ctx.db, args.limit ?? 20);
}
