import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireReindexLock,
  computeEntriesDigest,
  findCaveatsForPrompt,
  openDb,
  readDigestMarker,
  reindexAllSources,
  releaseReindexLock,
  upsertEntry,
  writeDigestMarker,
  type Logger,
} from '../src/index.js';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function sample(id: string): string {
  return `---
id: ${id}
title: Quasar junction boot failure
visibility: public
confidence: confirmed
tags: [quasar, junction]
environment: {}
source_project: null
source_session: test
created_at: 2026-07-11
updated_at: 2026-07-11
---

## Symptom
Quasar junction boot failure reports a rare anchor mismatch.
`;
}

function fresh(): { home: string; entries: string; community: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-auto-reindex-'));
  const entries = join(home, 'own', 'entries');
  const community = join(home, 'community');
  mkdirSync(entries, { recursive: true });
  return { home, entries, community, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('auto reindex core', () => {
  it('computes a deterministic digest and detects add, remove, rename, mtime, and size changes', () => {
    const { entries, community, cleanup } = fresh();
    try {
      const a = join(entries, 'a.md');
      writeFileSync(a, sample('a'));
      const first = computeEntriesDigest({ entriesDir: entries, communityDir: community });
      expect(computeEntriesDigest({ entriesDir: entries, communityDir: community })).toEqual(first);
      writeFileSync(join(entries, 'b.md'), sample('b'));
      const added = computeEntriesDigest({ entriesDir: entries, communityDir: community });
      expect(added.digest).not.toBe(first.digest);
      rmSync(join(entries, 'b.md'));
      expect(computeEntriesDigest({ entriesDir: entries, communityDir: community }).digest).toBe(first.digest);
      renameSync(a, join(entries, 'renamed.md'));
      const renamed = computeEntriesDigest({ entriesDir: entries, communityDir: community });
      expect(renamed.digest).not.toBe(first.digest);
      const beforeMtime = statSync(join(entries, 'renamed.md')).mtime;
      utimesSync(join(entries, 'renamed.md'), beforeMtime, new Date(beforeMtime.getTime() + 1000));
      const mtimeChanged = computeEntriesDigest({ entriesDir: entries, communityDir: community });
      expect(mtimeChanged.digest).not.toBe(renamed.digest);
      writeFileSync(join(entries, 'renamed.md'), `${sample('a')}extra`);
      expect(computeEntriesDigest({ entriesDir: entries, communityDir: community }).digest).not.toBe(mtimeChanged.digest);
    } finally { cleanup(); }
  });

  it('is independent of community handle enumeration order', () => {
    const { entries, community, cleanup } = fresh();
    try {
      for (const handle of ['zeta', 'alpha']) {
        const root = join(community, handle, 'entries');
        mkdirSync(root, { recursive: true });
        const file = join(root, 'entry.md');
        writeFileSync(file, sample('shared'));
        utimesSync(file, new Date(0), new Date(0));
      }
      const first = computeEntriesDigest({ entriesDir: entries, communityDir: community });
      renameSync(join(community, 'zeta'), join(community, 'temp'));
      renameSync(join(community, 'alpha'), join(community, 'zeta'));
      renameSync(join(community, 'temp'), join(community, 'alpha'));
      expect(computeEntriesDigest({ entriesDir: entries, communityDir: community })).toEqual(first);
    } finally { cleanup(); }
  });

  it('round-trips markers and treats corrupt JSON as dirty', () => {
    const { home, cleanup } = fresh();
    try {
      expect(readDigestMarker(home)).toBeNull();
      writeDigestMarker(home, { digest: 'abc', fileCount: 3 });
      expect(readDigestMarker(home)).toMatchObject({ digest: 'abc', fileCount: 3 });
      writeFileSync(join(home, 'index', '.entries-digest'), '{bad');
      expect(readDigestMarker(home)).toBeNull();
    } finally { cleanup(); }
  });

  it('acquires, rejects a live duplicate, releases, and replaces stale locks', () => {
    const { home, cleanup } = fresh();
    try {
      const lock = acquireReindexLock(home);
      expect(lock).not.toBeNull();
      expect(acquireReindexLock(home)).toBeNull();
      releaseReindexLock(lock!);
      expect(existsSync(lock!.path)).toBe(false);
      mkdirSync(join(home, 'index'), { recursive: true });
      writeFileSync(join(home, 'index', '.reindex-lock'), '99999999');
      const replacement = acquireReindexLock(home);
      expect(replacement).not.toBeNull();
      releaseReindexLock(replacement!);
    } finally { cleanup(); }
  });

  it('purges removed community sources while preserving own rows when entriesDir is absent', () => {
    const { entries, community, cleanup } = fresh();
    const db = openDb({ path: ':memory:' });
    try {
      writeFileSync(join(entries, 'own.md'), sample('own'));
      const alice = join(community, 'alice', 'entries');
      mkdirSync(alice, { recursive: true });
      writeFileSync(join(alice, 'alice.md'), sample('alice'));
      reindexAllSources({ db, paths: { entriesDir: entries, communityDir: community }, logger });
      upsertEntry(db, {
        id: 'ghost', source: 'community/alice', path: 'deleted.md', title: 'ghost', body: 'ghost',
        frontmatter_json: '{}', tags: '[]', confidence: 'tentative', visibility: 'public',
        file_mtime: new Date().toISOString(), indexed_at: new Date().toISOString(),
      });
      reindexAllSources({ db, paths: { entriesDir: entries, communityDir: community }, logger });
      expect((db.prepare("SELECT COUNT(*) AS c FROM entries WHERE id = 'ghost'").get() as { c: number }).c).toBe(0);
      rmSync(join(community, 'alice'), { recursive: true });
      rmSync(entries, { recursive: true });
      reindexAllSources({ db, paths: { entriesDir: entries, communityDir: community }, logger });
      expect((db.prepare("SELECT COUNT(*) AS c FROM entries WHERE source = 'own'").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM entries WHERE source = 'community/alice'").get() as { c: number }).c).toBe(0);
    } finally { db.close(); cleanup(); }
  });

  it('indexes new markdown so the prompt gate can surface it', () => {
    const { entries, community, cleanup } = fresh();
    const db = openDb({ path: ':memory:' });
    try {
      writeFileSync(join(entries, 'quasar.md'), sample('quasar'));
      reindexAllSources({ db, paths: { entriesDir: entries, communityDir: community }, logger });
      expect(findCaveatsForPrompt(db, 'quasar junction boot failure')).toHaveLength(1);
    } finally { db.close(); cleanup(); }
  });
});
