import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertEntry } from '../src/indexer.js';
import { search, get, listRecent } from '../src/repository.js';

const insert = (db: ReturnType<typeof openDb>, id: string, source: 'own' | `community/${string}` = 'own', overrides: Partial<{ title: string; body: string; tags: string[]; confidence: string; updated_at: string }> = {}) => {
  const fm = {
    id, title: overrides.title ?? `Title ${id}`, visibility: 'public',
    confidence: overrides.confidence ?? 'reproduced',
    tags: overrides.tags ?? ['gpu'],
    environment: { os: 'windows-11' },
    source_project: 'p', source_session: '2026-04-18T00:00:00Z/deadbeef1234',
    created_at: '2026-04-18', updated_at: overrides.updated_at ?? '2026-04-18',
  };
  upsertEntry(db, {
    id, source, path: `${id}.md`,
    title: fm.title, body: overrides.body ?? `## Symptom\nsym-${id}\n\n## Cause\ncau-${id}`,
    frontmatter_json: JSON.stringify(fm),
    tags: JSON.stringify(fm.tags),
    confidence: fm.confidence, visibility: fm.visibility,
    file_mtime: '2026-04-18', indexed_at: '2026-04-18',
  });
};

describe('search', () => {
  it('returns all when no query or filters', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a');
    insert(db, 'b');
    expect(search(db).length).toBe(2);
  });

  it('FTS matches title text', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { title: 'RTX 5090 CUDA init failure' });
    insert(db, 'b', 'own', { title: 'VSCode terminal width' });
    const r = search(db, { query: 'RTX' });
    expect(r.length).toBe(1);
    expect(r[0]!.id).toBe('a');
  });

  it('filters by source own vs community', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own');
    insert(db, 'b', 'community/alice');
    expect(search(db, { filters: { source: 'own' } }).map((r) => r.id)).toEqual(['a']);
    expect(search(db, { filters: { source: 'community' } }).map((r) => r.id)).toEqual(['b']);
    expect(search(db, { filters: { source: 'all' } }).length).toBe(2);
  });

  it('filters by confidence', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { confidence: 'tentative' });
    insert(db, 'b', 'own', { confidence: 'reproduced' });
    const r = search(db, { filters: { confidence: ['tentative'] } });
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  it('filters by tags (AND semantics)', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { tags: ['gpu', 'cuda'] });
    insert(db, 'b', 'own', { tags: ['gpu'] });
    const r = search(db, { filters: { tags: ['gpu', 'cuda'] } });
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  it('symptomExcerpt extracted from Symptom section', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { body: '## Symptom\nthe problem\n\n## Cause\nthe reason' });
    const r = search(db);
    expect(r[0]!.symptomExcerpt).toBe('the problem');
  });
});

describe('get', () => {
  it('returns null for missing id', () => {
    const db = openDb({ path: ':memory:' });
    expect(get(db, 'missing')).toBeNull();
  });

  it('returns parsed entry with sections map', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { body: '## Symptom\nsym\n\n## Resolution\nfix' });
    const r = get(db, 'a');
    expect(r).not.toBeNull();
    expect(r!.sections.Symptom).toBe('sym');
    expect(r!.sections.Resolution).toBe('fix');
  });
});

describe('listRecent', () => {
  it('orders by updated_at DESC', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { updated_at: '2026-04-10' });
    insert(db, 'b', 'own', { updated_at: '2026-04-18' });
    insert(db, 'c', 'own', { updated_at: '2026-04-15' });
    const r = listRecent(db);
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});
