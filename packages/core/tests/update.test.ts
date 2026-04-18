import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { recordEntry } from '../src/record.js';
import { updateEntry } from '../src/update.js';
import { parseMarkdown } from '../src/frontmatter.js';

interface Fx {
  root: string;
  entriesRoot: string;
  db: DatabaseSync;
}

function fx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-update-'));
  const entriesRoot = join(root, 'entries');
  const db = openDb({ path: ':memory:' });
  return { root, entriesRoot, db };
}
function cleanup(f: Fx): void {
  f.db.close();
  rmSync(f.root, { recursive: true, force: true });
}

function setupEntry(f: Fx) {
  return recordEntry(
    {
      title: 'initial',
      symptom: 'old symptom',
      cause: 'old cause',
      resolution: 'old res',
      confidence: 'tentative',
      tags: ['a', 'b'],
      environment: { gpu: 'RTX 5090', cuda: '<12.5' },
    },
    { db: f.db, entriesRoot: f.entriesRoot },
  );
}

describe('updateEntry', () => {
  let f: Fx;
  beforeEach(() => {
    f = fx();
  });
  afterEach(() => {
    cleanup(f);
  });

  it('updates confidence and bumps updated_at', () => {
    const { id } = setupEntry(f);
    updateEntry(
      id,
      { frontmatter: { confidence: 'confirmed' } },
      { db: f.db, entriesRoot: f.entriesRoot, now: () => new Date(Date.UTC(2026, 5, 1)) },
    );

    const row = f.db
      .prepare('SELECT confidence, frontmatter_json FROM entries WHERE id = ?')
      .get(id) as { confidence: string; frontmatter_json: string };
    expect(row.confidence).toBe('confirmed');
    const fm = JSON.parse(row.frontmatter_json) as { updated_at: string };
    expect(fm.updated_at).toBe('2026-06-01');
  });

  it('shallow-merges environment', () => {
    const { id } = setupEntry(f);
    updateEntry(
      id,
      { frontmatter: { environment: { driver: '>=555' } } },
      { db: f.db, entriesRoot: f.entriesRoot },
    );

    const row = f.db
      .prepare('SELECT frontmatter_json FROM entries WHERE id = ?')
      .get(id) as { frontmatter_json: string };
    const fm = JSON.parse(row.frontmatter_json) as { environment: Record<string, string> };
    expect(fm.environment.gpu).toBe('RTX 5090');
    expect(fm.environment.cuda).toBe('<12.5');
    expect(fm.environment.driver).toBe('>=555');
  });

  it('replaces tags array completely (no merge)', () => {
    const { id } = setupEntry(f);
    updateEntry(
      id,
      { frontmatter: { tags: ['z'] } },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    const row = f.db.prepare('SELECT tags FROM entries WHERE id = ?').get(id) as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(['z']);
  });

  it('rejects immutable keys', () => {
    const { id } = setupEntry(f);
    expect(() =>
      updateEntry(id, { frontmatter: { id: 'other' } }, { db: f.db, entriesRoot: f.entriesRoot }),
    ).toThrow(/immutable/);
    expect(() =>
      updateEntry(
        id,
        { frontmatter: { created_at: '2020-01-01' } },
        { db: f.db, entriesRoot: f.entriesRoot },
      ),
    ).toThrow(/immutable/);
  });

  it('replaces existing section content by heading name', () => {
    const { id } = setupEntry(f);
    updateEntry(
      id,
      { sections: { Resolution: 'new resolution' } },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    const filePath = join(f.entriesRoot, 'misc', `${id}.md`);
    const parsed = parseMarkdown(readFileSync(filePath, 'utf-8'));
    expect(parsed.sections['Resolution']).toBe('new resolution');
    expect(parsed.sections['Cause']).toBe('old cause');
  });

  it('appends new section when heading does not exist', () => {
    const { id } = setupEntry(f);
    updateEntry(
      id,
      { sections: { Context: 'newly added context' } },
      { db: f.db, entriesRoot: f.entriesRoot },
    );
    const filePath = join(f.entriesRoot, 'misc', `${id}.md`);
    const parsed = parseMarkdown(readFileSync(filePath, 'utf-8'));
    expect(parsed.sections['Context']).toBe('newly added context');
  });

  it('throws when id not found', () => {
    expect(() =>
      updateEntry('missing', { frontmatter: { title: 'x' } }, { db: f.db, entriesRoot: f.entriesRoot }),
    ).toThrow(/not found/);
  });
});
