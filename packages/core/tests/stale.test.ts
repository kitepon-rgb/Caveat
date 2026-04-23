import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { listStale } from '../src/stale.js';

function insert(
  db: ReturnType<typeof openDb>,
  id: string,
  opts: { source?: string; title?: string; visibility?: string; lastHitAt?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at, last_hit_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.source ?? 'own',
    `${id}.md`,
    opts.title ?? `title-${id}`,
    'b',
    '{}',
    '[]',
    'tentative',
    opts.visibility ?? 'public',
    'm',
    'i',
    opts.lastHitAt ?? null,
  );
}

describe('listStale', () => {
  it('returns entries whose last_hit_at is older than cutoff', () => {
    const now = new Date('2026-04-23T12:00:00.000Z');
    const db = openDb({ path: ':memory:' });
    insert(db, 'old', { lastHitAt: '2026-01-01T00:00:00.000Z' }); // ~113 days old
    insert(db, 'fresh', { lastHitAt: '2026-04-20T00:00:00.000Z' }); // 3 days old
    const rows = listStale(db, { days: 90, now: () => now });
    expect(rows.map((r) => r.id)).toEqual(['old']);
  });

  it('includes entries with null last_hit_at', () => {
    const now = new Date('2026-04-23T12:00:00.000Z');
    const db = openDb({ path: ':memory:' });
    insert(db, 'never', { lastHitAt: null });
    insert(db, 'fresh', { lastHitAt: '2026-04-20T00:00:00.000Z' });
    const rows = listStale(db, { days: 90, now: () => now });
    expect(rows.map((r) => r.id)).toEqual(['never']);
  });

  it('filters by visibility', () => {
    const now = new Date('2026-04-23T12:00:00.000Z');
    const db = openDb({ path: ':memory:' });
    insert(db, 'old-pub', { lastHitAt: '2026-01-01T00:00:00.000Z', visibility: 'public' });
    insert(db, 'old-priv', { lastHitAt: '2026-01-01T00:00:00.000Z', visibility: 'private' });
    const rows = listStale(db, { days: 90, visibility: 'private', now: () => now });
    expect(rows.map((r) => r.id)).toEqual(['old-priv']);
  });

  it('orders null first, then oldest last_hit_at', () => {
    const now = new Date('2026-04-23T12:00:00.000Z');
    const db = openDb({ path: ':memory:' });
    insert(db, 'mid', { lastHitAt: '2026-01-15T00:00:00.000Z' });
    insert(db, 'never', { lastHitAt: null });
    insert(db, 'oldest', { lastHitAt: '2025-12-01T00:00:00.000Z' });
    const rows = listStale(db, { days: 90, now: () => now });
    expect(rows.map((r) => r.id)).toEqual(['never', 'oldest', 'mid']);
  });

  it('respects limit', () => {
    const now = new Date('2026-04-23T12:00:00.000Z');
    const db = openDb({ path: ':memory:' });
    for (let i = 0; i < 5; i++) insert(db, `e${i}`, { lastHitAt: null });
    const rows = listStale(db, { days: 90, limit: 2, now: () => now });
    expect(rows.length).toBe(2);
  });
});
