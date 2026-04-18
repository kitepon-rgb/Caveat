import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';

describe('openDb', () => {
  it('applies schema on new DB and sets user_version', () => {
    const db = openDb({ path: ':memory:' });
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(1);
    db.prepare('SELECT * FROM entries').all();
    db.prepare('SELECT * FROM entries_fts').all();
  });

  it('FTS trigger syncs on insert', () => {
    const db = openDb({ path: ':memory:' });
    db.prepare(
      `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('x', 'own', 'x.md', 'RTX 5090 gotcha', 'some body', '{}', '[]', 'tentative', 'public', '2026-04-18', '2026-04-18');
    const r = db.prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`).all('RTX 5090');
    expect(r.length).toBe(1);
  });

  it('FTS trigger removes on delete', () => {
    const db = openDb({ path: ':memory:' });
    db.prepare(
      `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('x', 'own', 'x.md', 'gotcha', 'body', '{}', '[]', 'tentative', 'public', 'm', 'i');
    db.prepare('DELETE FROM entries WHERE id = ?').run('x');
    const r = db.prepare(`SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?`).all('gotcha');
    expect(r.length).toBe(0);
  });

  it('UNIQUE(source, id) prevents same-source collision but allows cross-source', () => {
    const db = openDb({ path: ':memory:' });
    const stmt = db.prepare(
      `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run('x', 'own', 'a.md', 't', 'b', '{}', '[]', 'tentative', 'public', 'm', 'i');
    stmt.run('x', 'community/alice', 'a.md', 't', 'b', '{}', '[]', 'tentative', 'public', 'm', 'i');
    expect(() =>
      stmt.run('x', 'own', 'a2.md', 't', 'b', '{}', '[]', 'tentative', 'public', 'm', 'i'),
    ).toThrow();
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    expect(count.c).toBe(2);
  });
});
