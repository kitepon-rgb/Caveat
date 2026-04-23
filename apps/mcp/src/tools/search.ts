import { z } from 'zod';
import { markHit, search, type Confidence } from '@caveat/core';
import type { McpContext } from '../context.js';

const sourceFilter = z.enum(['own', 'community', 'all']);
const confidenceSchema = z.enum(['confirmed', 'reproduced', 'tentative']);
const visibilityFilter = z.enum(['public', 'private', 'all']);

export const searchInputShape = {
  query: z.string().describe('FTS query (3+ chars for trigram). Empty string lists without text filter.'),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      confidence: z.array(confidenceSchema).optional(),
      source: sourceFilter.optional(),
      visibility: visibilityFilter
        .optional()
        .describe(
          [
            "Narrow by publish tier.",
            "'public' = external-spec gotchas reproducible by any third party (PyInstaller, Stripe, Claude Code hook behavior, etc).",
            "'private' = your own cross-project notes (repo-specific, your workflow, intentional non-standard design).",
            "'all' (or omit) = both tiers.",
            "Use 'public' when drafting externally-visible output (PR descriptions, public docs, answers to third parties) so private notes do not bleed into external content.",
            "Use 'private' when specifically recalling your own past decisions.",
            "Default to omitting this filter — narrowing too aggressively hides relevant entries.",
          ].join(' '),
        ),
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
    visibility?: 'public' | 'private' | 'all';
  };
  limit?: number;
};

export function handleSearch(ctx: McpContext, args: SearchArgs) {
  const results = search(ctx.db, {
    query: args.query,
    filters: args.filters,
    limit: args.limit,
  });
  if (results.length > 0) markHit(ctx.db, results);
  return results;
}
