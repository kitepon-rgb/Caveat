import { z } from 'zod';
import { search, type Confidence } from '@caveat/core';
import type { McpContext } from '../context.js';

const sourceFilter = z.enum(['own', 'community', 'all']);
const confidenceSchema = z.enum(['confirmed', 'reproduced', 'tentative']);

export const searchInputShape = {
  query: z.string().describe('FTS query (3+ chars for trigram). Empty string lists without text filter.'),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      confidence: z.array(confidenceSchema).optional(),
      source: sourceFilter.optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

export type SearchArgs = {
  query: string;
  filters?: {
    tags?: string[];
    confidence?: Confidence[];
    source?: 'own' | 'community' | 'all';
  };
  limit?: number;
};

export function handleSearch(ctx: McpContext, args: SearchArgs) {
  const results = search(ctx.db, {
    query: args.query,
    filters: args.filters,
    limit: args.limit,
  });
  return results;
}
