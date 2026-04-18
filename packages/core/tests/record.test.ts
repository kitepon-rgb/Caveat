import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { recordEntry } from '../src/record.js';
import { parseMarkdown } from '../src/frontmatter.js';
import type { DatabaseSync } from 'node:sqlite';

interface Fx {
  root: string;
  entriesRoot: string;
  db: DatabaseSync;
}

function fx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-record-'));
  const entriesRoot = join(root, 'entries');
  const db = openDb({ path: ':memory:' });
  return { root, entriesRoot, db };
}

function cleanup(f: Fx): void {
  f.db.close();
  rmSync(f.root, { recursive: true, force: true });
}

describe('recordEntry', () => {
  let f: Fx;
  beforeEach(() => {
    f = fx();
  });
  afterEach(() => {
    cleanup(f);
  });

  it('writes md file, auto-fills frontmatter, syncs DB', () => {
    const result = recordEntry(
      {
        title: 'RTX 5090 で CUDA 12.4 が失敗',
        symptom: 'cudaGetDeviceCount が 0',
        confidence: 'reproduced',
        tags: ['gpu', 'cuda'],
        environment: { cuda: '<12.5' },
      },
      { db: f.db, entriesRoot: f.entriesRoot },
    );

    expect(existsSync(result.filePath)).toBe(true);
    const raw = readFileSync(result.filePath, 'utf-8');
    const parsed = parseMarkdown(raw);
    expect(parsed.frontmatter.title).toBe('RTX 5090 で CUDA 12.4 が失敗');
    expect(parsed.frontmatter.confidence).toBe('reproduced');
    expect(parsed.frontmatter.outcome).toBe('resolved');
    expect(parsed.frontmatter.visibility).toBe('public');
    expect(parsed.frontmatter.environment.cuda).toBe('<12.5');
    expect(parsed.frontmatter.source_session).toMatch(/^.+\/[0-9a-f]{12}$/);
    expect(parsed.frontmatter.last_verified).toBe(parsed.frontmatter.created_at);

    // DB sync
    const row = f.db
      .prepare('SELECT id, title, confidence FROM entries WHERE source = ? AND id = ?')
      .get('own', result.id) as { id: string; title: string; confidence: string } | undefined;
    expect(row?.id).toBe(result.id);
    expect(row?.confidence).toBe('reproduced');
  });

  it('generates slug from title', () => {
    const result = recordEntry(
      { title: 'Hello World!', symptom: 's' },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    expect(result.id).toBe('hello-world');
  });

  it('falls back to entry-YYYYMMDD-<hex> for non-ASCII-only title', () => {
    const result = recordEntry(
      { title: '仕様', symptom: 's' },
      { db: f.db, entriesRoot: f.entriesRoot, now: () => new Date(Date.UTC(2026, 3, 18)) },
    );
    expect(result.id).toMatch(/^entry-20260418-[0-9a-f]{6}$/);
  });

  it('appends -2 on collision', () => {
    recordEntry({ title: 'same title', symptom: 's' }, { db: f.db, entriesRoot: f.entriesRoot });
    const second = recordEntry(
      { title: 'same title', symptom: 's2' },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    expect(second.id).toBe('same-title-2');
  });

  it('defaults confidence to tentative, outcome to resolved', () => {
    const result = recordEntry(
      { title: 'defaults', symptom: 's' },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    const parsed = parseMarkdown(readFileSync(result.filePath, 'utf-8'));
    expect(parsed.frontmatter.confidence).toBe('tentative');
    expect(parsed.frontmatter.outcome).toBe('resolved');
  });

  it('includes Context section when provided', () => {
    const result = recordEntry(
      { title: 't', symptom: 's', context: 'working on foo' },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    const raw = readFileSync(result.filePath, 'utf-8');
    expect(raw).toContain('## Context');
    expect(raw).toContain('working on foo');
    const contextIdx = raw.indexOf('## Context');
    const symptomIdx = raw.indexOf('## Symptom');
    expect(contextIdx).toBeLessThan(symptomIdx);
  });

  it('generates empty sections for ingest_research-style minimal input', () => {
    const result = recordEntry(
      { title: 't', symptom: 'sym', confidence: 'tentative' },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    const raw = readFileSync(result.filePath, 'utf-8');
    expect(raw).toContain('## Symptom');
    expect(raw).toContain('## Cause');
    expect(raw).toContain('## Resolution');
    expect(raw).toContain('## Evidence');
  });
});
