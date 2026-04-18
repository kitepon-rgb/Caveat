import { openDb, search } from '@caveat/core';
import type { SearchFilters, Confidence } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface SearchCommandOptions {
  query: string;
  source?: 'own' | 'community' | 'all';
  tags?: string[];
  confidence?: Confidence[];
}

export function runSearch(ctx: CliContext, opts: SearchCommandOptions): void {
  const filters: SearchFilters = {};
  if (opts.source) filters.source = opts.source;
  if (opts.tags && opts.tags.length > 0) filters.tags = opts.tags;
  if (opts.confidence && opts.confidence.length > 0) filters.confidence = opts.confidence;

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const results = search(db, { query: opts.query, filters });
    if (results.length === 0) {
      process.stdout.write('(no results)\n');
      return;
    }
    for (const r of results) {
      process.stdout.write(`${r.id} [${r.source}] (${r.confidence}) ${r.title}\n`);
      if (r.symptomExcerpt) {
        const oneLine = r.symptomExcerpt.replace(/\s+/g, ' ').slice(0, 140);
        process.stdout.write(`  ${oneLine}\n`);
      }
    }
  } finally {
    db.close();
  }
}
