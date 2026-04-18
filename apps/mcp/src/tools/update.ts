import { z } from 'zod';
import { updateEntry, type Source } from '@caveat/core';
import type { McpContext } from '../context.js';

const confidenceSchema = z.enum(['confirmed', 'reproduced', 'tentative']);
const outcomeSchema = z.enum(['resolved', 'impossible']);
const visibilitySchema = z.enum(['public', 'private']);

const patchFrontmatterSchema = z.object({
  title: z.string().optional(),
  confidence: confidenceSchema.optional(),
  outcome: outcomeSchema.optional(),
  visibility: visibilitySchema.optional(),
  tags: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  last_verified: z.string().optional(),
});

export const updateInputShape = {
  id: z.string(),
  source: z.string().optional(),
  patch: z.object({
    frontmatter: patchFrontmatterSchema.optional(),
    sections: z.record(z.string(), z.string()).optional(),
  }),
};

export type UpdateArgs = {
  id: string;
  source?: string;
  patch: {
    frontmatter?: z.infer<typeof patchFrontmatterSchema>;
    sections?: Record<string, string>;
  };
};

export function handleUpdate(ctx: McpContext, args: UpdateArgs) {
  const source = (args.source ?? 'own') as Source;
  return updateEntry(args.id, args.patch, {
    db: ctx.db,
    entriesRoot: ctx.paths.entriesDir,
    source,
  });
}
