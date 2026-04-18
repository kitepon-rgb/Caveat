import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery, search } from '../src/repository.js';
import { openDb } from '../src/db.js';
import { recordEntry } from '../src/record.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sanitizeFtsQuery', () => {
  it('quotes single term', () => {
    expect(sanitizeFtsQuery('sqlite')).toBe('"sqlite"');
  });

  it('strips FTS5 operators and quotes each term', () => {
    expect(sanitizeFtsQuery('node:sqlite')).toBe('"node" "sqlite"');
    expect(sanitizeFtsQuery('node.js')).toBe('"node" "js"');
    expect(sanitizeFtsQuery('a+b-c*d')).toBe('"a" "b" "c" "d"');
  });

  it('preserves CJK tokens', () => {
    expect(sanitizeFtsQuery('初期化失敗')).toBe('"初期化失敗"');
    expect(sanitizeFtsQuery('CUDA 初期化')).toBe('"CUDA" "初期化"');
  });

  it('empty on all-operators input', () => {
    expect(sanitizeFtsQuery(':.+*-')).toBe('');
  });

  it('empty on empty string', () => {
    expect(sanitizeFtsQuery('')).toBe('');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeFtsQuery('a   b\tc')).toBe('"a" "b" "c"');
  });
});

describe('search() handles special chars without throwing', () => {
  it('accepts colon-bearing query (node:sqlite)', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-fts-'));
    const db = openDb({ path: ':memory:' });
    try {
      recordEntry(
        {
          title: 'node:sqlite experimental warning',
          symptom: 'DatabaseSync import emits ExperimentalWarning',
        },
        { db, entriesRoot: join(root, 'entries') },
      );
      const results = search(db, { query: 'node:sqlite' });
      expect(results.length).toBe(1);
      expect(results[0]?.title).toContain('node:sqlite');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts dot-bearing query (node.js)', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-fts-'));
    const db = openDb({ path: ':memory:' });
    try {
      recordEntry(
        { title: 'test entry for node.js 22 edge case', symptom: 'dot in query test' },
        { db, entriesRoot: join(root, 'entries') },
      );
      const results = search(db, { query: 'node.js' });
      expect(results.length).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
