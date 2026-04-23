import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { markHit } from '../src/markHit.js';

function insert(db: ReturnType<typeof openDb>, id: string, source = 'own'): void {
  db.prepare(
    `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, source, `${id}.md`, 't', 'b', '{}', '[]', 'tentative', 'public', 'm', 'i');
}

describe('markHit', () => {
  it('writes timestamp to last_hit_at for the given (source, id) pairs', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a');
    insert(db, 'b');
    insert(db, 'c');
    markHit(db, [{ id: 'a', source: 'own' }, { id: 'c', source: 'own' }], () => '2026-04-23T12:00:00.000Z');

    const rows = db
      .prepare('SELECT id, last_hit_at FROM entries ORDER BY id')
      .all() as Array<{ id: string; last_hit_at: string | null }>;
    expect(rows).toEqual([
      { id: 'a', last_hit_at: '2026-04-23T12:00:00.000Z' },
      { id: 'b', last_hit_at: null },
      { id: 'c', last_hit_at: '2026-04-23T12:00:00.000Z' },
    ]);
  });

  it('is a no-op when keys is empty', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a');
    markHit(db, [], () => '2026-04-23T12:00:00.000Z');
    const row = db.prepare('SELECT last_hit_at FROM entries').get() as { last_hit_at: string | null };
    expect(row.last_hit_at).toBeNull();
  });

  it('only updates matching source (no cross-source collision)', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own');
    insert(db, 'a', 'community/alice');
    markHit(db, [{ id: 'a', source: 'own' }], () => '2026-04-23T12:00:00.000Z');

    const rows = db
      .prepare('SELECT source, last_hit_at FROM entries ORDER BY source')
      .all() as Array<{ source: string; last_hit_at: string | null }>;
    expect(rows).toEqual([
      { source: 'community/alice', last_hit_at: null },
      { source: 'own', last_hit_at: '2026-04-23T12:00:00.000Z' },
    ]);
  });

  it('overwrites a previous timestamp on repeated hits', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a');
    markHit(db, [{ id: 'a', source: 'own' }], () => '2026-04-23T10:00:00.000Z');
    markHit(db, [{ id: 'a', source: 'own' }], () => '2026-04-23T12:00:00.000Z');
    const row = db.prepare('SELECT last_hit_at FROM entries WHERE id = ?').get('a') as { last_hit_at: string };
    expect(row.last_hit_at).toBe('2026-04-23T12:00:00.000Z');
  });
});
