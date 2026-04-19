import { z } from 'zod';
import { recordEntry } from '@caveat/core';
import type { McpContext } from '../context.js';

export const ingestResearchInputShape = {
  title: z.string().min(1),
  symptom: z.string().min(1),
  cause: z.string().optional(),
  resolution: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  brief_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
};

export type IngestResearchArgs = {
  title: string;
  symptom: string;
  cause?: string;
  resolution?: string;
  evidence?: string[];
  brief_id?: string;
  tags?: string[];
  category?: string;
};

export function handleIngestResearch(ctx: McpContext, args: IngestResearchArgs) {
  const evidenceText = args.evidence
    ? args.evidence.map((line) => `- ${line}`).join('\n')
    : '';

  return recordEntry(
    {
      title: args.title,
      symptom: args.symptom,
      cause: args.cause ?? '',
      resolution: args.resolution ?? '',
      evidence: evidenceText,
      confidence: 'tentative',
      outcome: 'resolved',
      tags: args.tags,
      category: args.category,
      brief_id: args.brief_id,
    },
    {
      db: ctx.db,
      entriesRoot: ctx.paths.entriesDir,
    },
  );
}
