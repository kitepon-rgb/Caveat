import { z } from 'zod';
import { recordEntry } from '@caveat/core';
import type { McpContext } from '../context.js';

const confidenceSchema = z.enum(['confirmed', 'reproduced', 'tentative']);
const outcomeSchema = z.enum(['resolved', 'impossible']);
const visibilitySchema = z.enum(['public', 'private']);

export const recordInputShape = {
  title: z.string().min(1),
  symptom: z.string().min(1),
  cause: z.string().optional(),
  resolution: z.string().optional(),
  evidence: z.string().optional(),
  context: z.string().optional(),
  confidence: confidenceSchema.optional(),
  outcome: outcomeSchema.optional(),
  visibility: visibilitySchema.optional(),
  tags: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  category: z.string().optional().describe('Directory under entries/ (e.g., gpu, claude-code). Default: misc'),
};

export type RecordArgs = {
  title: string;
  symptom: string;
  cause?: string;
  resolution?: string;
  evidence?: string;
  context?: string;
  confidence?: 'confirmed' | 'reproduced' | 'tentative';
  outcome?: 'resolved' | 'impossible';
  visibility?: 'public' | 'private';
  tags?: string[];
  environment?: Record<string, string>;
  category?: string;
};

export function handleRecord(ctx: McpContext, args: RecordArgs) {
  return recordEntry(args, {
    db: ctx.db,
    entriesRoot: ctx.paths.entriesDir,
  });
}
