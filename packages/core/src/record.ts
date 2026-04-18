import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Frontmatter, Source, Confidence, Outcome, Visibility } from './types.js';
import { slugify, resolveCollision, generateSourceSession } from './id.js';
import { fingerprint, inferSourceProject } from './env.js';
import { buildEntry, writeEntryFile } from './writer.js';
import { upsertEntry } from './indexer.js';

export interface RecordInput {
  title: string;
  symptom: string;
  cause?: string;
  resolution?: string;
  evidence?: string;
  context?: string;
  confidence?: Confidence;
  outcome?: Outcome;
  visibility?: Visibility;
  tags?: string[];
  environment?: Record<string, string>;
  id?: string;
  brief_id?: string;
  cwd?: string;
  category?: string;
}

export interface RecordOptions {
  db: DatabaseSync;
  entriesRoot: string;
  projectRoots?: string[];
  now?: () => Date;
  source?: Source;
}

export interface RecordResult {
  id: string;
  path: string;
  filePath: string;
}

const DEFAULT_CATEGORY = 'misc';

export function recordEntry(input: RecordInput, opts: RecordOptions): RecordResult {
  const now = opts.now ?? (() => new Date());
  const source: Source = opts.source ?? 'own';
  const nowDate = now();
  const ymd = formatYmd(nowDate);

  const baseId = input.id ?? slugify(input.title, now);
  const id = resolveCollision(baseId, (candidate) => entryExists(opts.db, source, candidate));

  const mergedEnv: Record<string, string> = {
    ...fingerprint(),
    ...(input.environment ?? {}),
  };

  const sourceProject = input.cwd ? inferSourceProject(input.cwd, opts.projectRoots) : null;

  const frontmatter: Frontmatter = {
    id,
    title: input.title,
    visibility: input.visibility ?? 'public',
    confidence: input.confidence ?? 'tentative',
    outcome: input.outcome ?? 'resolved',
    tags: input.tags ?? [],
    environment: mergedEnv,
    source_project: sourceProject,
    source_session: generateSourceSession(now),
    created_at: ymd,
    updated_at: ymd,
    last_verified: ymd,
    ...(input.brief_id !== undefined ? { brief_id: input.brief_id } : {}),
  };

  const sections: Record<string, string> = {};
  if (input.context !== undefined) sections['Context'] = input.context;
  sections['Symptom'] = input.symptom;
  sections['Cause'] = input.cause ?? '';
  sections['Resolution'] = input.resolution ?? '';
  sections['Evidence'] = input.evidence ?? '';

  const built = buildEntry(frontmatter, sections);
  const category = input.category ?? DEFAULT_CATEGORY;
  const relPath = `${category}/${id}.md`;
  const filePath = join(opts.entriesRoot, relPath);

  writeEntryFile(filePath, built.content);

  const stat = statSync(filePath);
  upsertEntry(opts.db, {
    id,
    source,
    path: relPath,
    title: frontmatter.title,
    body: built.body,
    frontmatter_json: JSON.stringify(frontmatter),
    tags: JSON.stringify(frontmatter.tags),
    confidence: frontmatter.confidence,
    visibility: frontmatter.visibility,
    file_mtime: stat.mtime.toISOString(),
    indexed_at: nowDate.toISOString(),
  });

  return { id, path: relPath, filePath };
}

function entryExists(db: DatabaseSync, source: Source, id: string): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM entries WHERE source = ? AND id = ? LIMIT 1')
    .get(source, id);
  return row !== undefined && row !== null;
}

function formatYmd(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
