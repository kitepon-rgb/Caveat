import { z } from 'zod';
import { get, type Source } from '@caveat/core';
import type { McpContext } from '../context.js';

export const getInputShape = {
  id: z.string(),
  source: z.string().optional().describe('own or community/<handle>. Default: own'),
};

export type GetArgs = { id: string; source?: string };

export function handleGet(ctx: McpContext, args: GetArgs) {
  const source = (args.source ?? 'own') as Source;
  const result = get(ctx.db, args.id, source);
  if (!result) {
    throw new Error(`caveat not found: id=${args.id} source=${source}`);
  }
  return result;
}
