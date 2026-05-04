import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

describe('openDb', () => {
  it('applies schema on new DB and sets user_version', () => {
    const db = openDb({ path: ':memory:' });
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(3);
    db.prepare('SELECT * FROM entries').all();
    db.prepare('SELECT * FROM entries_fts').all();
  });

  it('entries table has last_hit_at column (v2)', () => {
    const db = openDb({ path: ':memory:' });
    const cols = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'last_hit_at')).toBe(true);
  });

  it('entries table has topical_text and symptom_text columns (v3)', () => {
    const db = openDb({ path: ':memory:' });
    const cols = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('topical_text');
    expect(names).toContain('symptom_text');
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

  it('migration 002: upgrades a v1 DB to v2 and adds last_hit_at column', () => {
    // Build a v1-shape DB directly (schema as it was before migration 002)
    const dir = mkdtempSync(join(tmpdir(), 'caveat-db-mig-'));
    const dbPath = join(dir, 'test.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 1');
    raw.exec(`
      CREATE TABLE entries (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        tags TEXT,
        confidence TEXT,
        visibility TEXT,
        file_mtime TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE (source, id)
      );
    `);
    raw.prepare(
      `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('preexisting', 'own', 'p.md', 't', 'b', '{}', '[]', 'tentative', 'public', 'm', 'i');
    raw.close();

    // Reopen via openDb — should apply migrations 002 and 003 in sequence
    const db = openDb({ path: dbPath });
    const ver = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(ver.user_version).toBe(3);

    const cols = db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'last_hit_at')).toBe(true);
    expect(cols.some((c) => c.name === 'topical_text')).toBe(true);
    expect(cols.some((c) => c.name === 'symptom_text')).toBe(true);

    // Pre-existing data survives
    const row = db.prepare('SELECT id, last_hit_at FROM entries').get() as {
      id: string;
      last_hit_at: string | null;
    };
    expect(row.id).toBe('preexisting');
    expect(row.last_hit_at).toBeNull();

    db.close();
  });

  it('migration 003 backfill: pre-v3 rows get topical_text/symptom_text populated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caveat-db-mig3-'));
    const dbPath = join(dir, 'test.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 2');
    raw.exec(`
      CREATE TABLE entries (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        tags TEXT,
        confidence TEXT,
        visibility TEXT,
        file_mtime TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        last_hit_at TEXT,
        UNIQUE (source, id)
      );
    `);
    const body = '## Symptom\nSQLITE_READONLY when writing\n\n## Cause\nbind mount uid mismatch\n';
    raw
      .prepare(
        `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'docker-sqlite',
        'own',
        'd.md',
        'Docker bind mount UID mismatch',
        body,
        JSON.stringify({ environment: { os: 'Ubuntu 26.04' } }),
        JSON.stringify(['docker', 'sqlite']),
        'reproduced',
        'private',
        'm',
        'i',
      );
    raw.close();

    const db = openDb({ path: dbPath });
    const r = db
      .prepare('SELECT topical_text, symptom_text FROM entries WHERE id = ?')
      .get('docker-sqlite') as { topical_text: string; symptom_text: string };
    expect(r.topical_text).toContain('Docker bind mount UID mismatch');
    expect(r.topical_text).toContain('docker');
    expect(r.topical_text).toContain('sqlite');
    expect(r.topical_text).toContain('Ubuntu 26.04');
    expect(r.symptom_text).toContain('SQLITE_READONLY');
    // Cause section should NOT be in symptom_text
    expect(r.symptom_text).not.toContain('bind mount uid mismatch');
    db.close();
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
