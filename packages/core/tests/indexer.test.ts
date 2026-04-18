import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';
import { scanSource } from '../src/indexer.js';

const sampleMd = (id: string) => `---
id: ${id}
title: Sample ${id}
visibility: public
confidence: tentative
tags: [test]
environment:
  os: windows-11
source_project: p
source_session: "2026-04-18T00:00:00Z/deadbeef1234"
created_at: 2026-04-18
updated_at: 2026-04-18
---

## Symptom
test symptom text
`;

let tmp: string;
beforeEach(() => {
  tmp = join(tmpdir(), 'caveat-indexer-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(tmp, { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('scanSource', () => {
  it('adds new entries', () => {
    const db = openDb({ path: ':memory:' });
    writeFileSync(join(tmp, 'a.md'), sampleMd('a'));
    writeFileSync(join(tmp, 'b.md'), sampleMd('b'));
    const r = scanSource({ db, source: 'own', entriesRoot: tmp });
    expect(r.added).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.deleted).toBe(0);
  });

  it('is idempotent when mtime unchanged', () => {
    const db = openDb({ path: ':memory:' });
    writeFileSync(join(tmp, 'a.md'), sampleMd('a'));
    scanSource({ db, source: 'own', entriesRoot: tmp });
    const r = scanSource({ db, source: 'own', entriesRoot: tmp });
    expect(r.added).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.deleted).toBe(0);
  });

  it('deletes entries whose files are removed', () => {
    const db = openDb({ path: ':memory:' });
    writeFileSync(join(tmp, 'a.md'), sampleMd('a'));
    writeFileSync(join(tmp, 'b.md'), sampleMd('b'));
    scanSource({ db, source: 'own', entriesRoot: tmp });
    rmSync(join(tmp, 'b.md'));
    const r = scanSource({ db, source: 'own', entriesRoot: tmp });
    expect(r.deleted).toBe(1);
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('handles rename without orphan or UNIQUE conflict', () => {
    const db = openDb({ path: ':memory:' });
    writeFileSync(join(tmp, 'a.md'), sampleMd('a'));
    scanSource({ db, source: 'own', entriesRoot: tmp });
    renameSync(join(tmp, 'a.md'), join(tmp, 'renamed.md'));
    const r = scanSource({ db, source: 'own', entriesRoot: tmp });
    expect(r.deleted).toBe(0);
    expect(r.updated).toBe(1);
    const row = db.prepare(`SELECT path FROM entries WHERE source = ? AND id = ?`).get('own', 'a') as { path: string };
    expect(row.path).toBe('renamed.md');
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('only affects matching source on delete pass', () => {
    const db = openDb({ path: ':memory:' });
    writeFileSync(join(tmp, 'a.md'), sampleMd('a'));
    scanSource({ db, source: 'own', entriesRoot: tmp });

    const tmp2 = join(tmpdir(), 'caveat-indexer2-' + Date.now());
    mkdirSync(tmp2, { recursive: true });
    writeFileSync(join(tmp2, 'c.md'), sampleMd('c'));
    scanSource({ db, source: 'community/alice', entriesRoot: tmp2 });

    rmSync(join(tmp, 'a.md'));
    scanSource({ db, source: 'own', entriesRoot: tmp });

    const own = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE source = ?`).get('own') as { c: number };
    const alice = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE source = ?`).get('community/alice') as { c: number };
    expect(own.c).toBe(0);
    expect(alice.c).toBe(1);
    rmSync(tmp2, { recursive: true, force: true });
  });

  it('handles non-existent entries root as empty', () => {
    const db = openDb({ path: ':memory:' });
    const r = scanSource({ db, source: 'own', entriesRoot: join(tmp, 'no-such-dir') });
    expect(r).toEqual({ added: 0, updated: 0, deleted: 0 });
  });
});
