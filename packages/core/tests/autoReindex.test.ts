import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireReindexLock,
  computeEntriesDigest,
  createKeyserverKeyProvider,
  findCaveatsForPrompt,
  openDb,
  prewarmSealedKeys,
  readDigestMarker,
  reindexAllSources,
  releaseReindexLock,
  sealBundle,
  search,
  upsertEntry,
  writeDigestMarker,
  type ContentKeyProvider,
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

async function startKeyServer(contentKey: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/v1/keys/sealed-v1') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keyId: 'sealed-v1', key: contentKey.toString('base64') }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('unexpected server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function sealedSample(id: string, unique: string): string {
  return `---
id: ${id}
title: Sealed nebula boot failure
visibility: public
confidence: confirmed
tags: [sealed, nebula]
environment: {}
source_project: null
source_session: test
created_at: 2026-07-11
updated_at: 2026-07-11
---

## Symptom
Sealed nebula boot failure reports ${unique}.
`;
}

function filesContain(root: string, needle: string, skipDirs = new Set<string>()): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      if (filesContain(join(root, entry.name), needle, skipDirs)) return true;
    } else if (entry.isFile()) {
      if (readFileSync(join(root, entry.name)).includes(Buffer.from(needle))) return true;
    }
  }
  return false;
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

  it('indexes a sealed community bundle without writing decrypted markdown to disk', async () => {
    const { home, entries, community, cleanup } = fresh();
    const db = openDb({ path: join(home, 'index', 'caveat.db') });
    const contentKey = Buffer.alloc(32, 42);
    const server = await startKeyServer(contentKey);
    const unique = 'unique-sealed-plain-never-on-disk';
    try {
      mkdirSync(entries, { recursive: true });
      const repo = join(community, 'sealed-team');
      mkdirSync(join(repo, 'bundle'), { recursive: true });
      writeFileSync(join(repo, 'README.md'), 'sealed public caveats\n');
      writeFileSync(join(repo, 'bundle', 'entries.caveat'), sealBundle({
        files: [{ relPath: 'sealed.md', content: Buffer.from(sealedSample('sealed', unique)) }],
        contentKey,
        keyId: 'keyserver:sealed-v1',
        keyserverUrl: server.url,
      }));

      const keyProvider = createKeyserverKeyProvider({ caveatHome: home });
      expect(await prewarmSealedKeys({ paths: { communityDir: community }, keyProvider })).toEqual([]);
      reindexAllSources({ db, paths: { entriesDir: entries, communityDir: community }, logger, keyProvider });

      expect(search(db, { query: 'nebula boot failure', filters: { source: 'community' } })).toHaveLength(1);
      expect(findCaveatsForPrompt(db, 'sealed nebula boot failure')).toHaveLength(1);
      expect(filesContain(community, unique)).toBe(false);
      expect(filesContain(home, unique, new Set(['index']))).toBe(false);
    } finally {
      db.close();
      await server.close();
      cleanup();
    }
  });

  it('preserves a sealed source when key resolution fails and still indexes other sources', () => {
    const { entries, community, cleanup } = fresh();
    const db = openDb({ path: ':memory:' });
    const warnings: string[] = [];
    const warningLogger: Logger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    const failingProvider: ContentKeyProvider = {
      ensureKeyAvailable: async () => {},
      resolveContentKey: () => { throw new Error('no key'); },
    };
    try {
      writeFileSync(join(entries, 'own.md'), sample('own'));
      const repo = join(community, 'sealed-team');
      mkdirSync(join(repo, 'bundle'), { recursive: true });
      writeFileSync(join(repo, 'bundle', 'entries.caveat'), sealBundle({
        files: [{ relPath: 'sealed.md', content: Buffer.from(sealedSample('sealed', 'retained')) }],
        contentKey: Buffer.alloc(32, 8),
        keyId: 'keyserver:missing',
        keyserverUrl: 'http://127.0.0.1:65535',
      }));
      upsertEntry(db, {
        id: 'sealed', source: 'community/sealed-team', path: 'sealed.md', title: 'old', body: 'old',
        frontmatter_json: '{}', tags: '[]', confidence: 'tentative', visibility: 'public',
        file_mtime: 'old', indexed_at: 'old',
      });

      reindexAllSources({
        db,
        paths: { entriesDir: entries, communityDir: community },
        logger: warningLogger,
        keyProvider: failingProvider,
      });

      expect((db.prepare("SELECT COUNT(*) AS c FROM entries WHERE source = 'community/sealed-team' AND id = 'sealed'").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM entries WHERE source = 'own'").get() as { c: number }).c).toBe(1);
      expect(warnings.some((m) => m.includes('sealed reindex failed'))).toBe(true);
    } finally { db.close(); cleanup(); }
  });

  it('rolls back mid-stream upserts when a later file in the same sealed bundle fails to parse', async () => {
    const { home, entries, community, cleanup } = fresh();
    const db = openDb({ path: join(home, 'index', 'caveat.db') });
    const warnings: string[] = [];
    const warningLogger: Logger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    const contentKey = Buffer.alloc(32, 77);
    const server = await startKeyServer(contentKey);
    try {
      writeFileSync(join(entries, 'own.md'), sample('own'));
      const repo = join(community, 'sealed-team');
      mkdirSync(join(repo, 'bundle'), { recursive: true });
      const bundlePath = join(repo, 'bundle', 'entries.caveat');

      // preexisting: 正常な1件だけの bundle で先に reindex し、当該 source に既存行を作っておく
      writeFileSync(bundlePath, sealBundle({
        files: [{ relPath: 'a-preexisting.md', content: Buffer.from(sealedSample('preexisting', 'preexisting-marker')) }],
        contentKey,
        keyId: 'keyserver:sealed-v1',
        keyserverUrl: server.url,
      }));
      const keyProvider = createKeyserverKeyProvider({ caveatHome: home });
      expect(await prewarmSealedKeys({ paths: { communityDir: community }, keyProvider })).toEqual([]);
      reindexAllSources({ db, paths: { entriesDir: entries, communityDir: community }, logger: warningLogger, keyProvider });
      expect(
        (db.prepare("SELECT id FROM entries WHERE source = 'community/sealed-team'").all() as Array<{ id: string }>)
          .map((r) => r.id),
      ).toEqual(['preexisting']);
      const ownRowBefore = db.prepare("SELECT title, file_mtime FROM entries WHERE source = 'own'").get();

      // good→broken の順で並ぶよう relPath を付与する（sealBundle は relPath バイト順に
      // canonicalize するため、'a-good.md' < 'b-broken.md' で good が先に scan される）。
      const brokenFrontmatter = `---
id: broken
bad: !!js/function "function () { return 1 }"
---

body
`;
      writeFileSync(bundlePath, sealBundle({
        files: [
          { relPath: 'a-good.md', content: Buffer.from(sealedSample('good-new', 'good-new-marker')) },
          { relPath: 'b-broken.md', content: Buffer.from(brokenFrontmatter) },
        ],
        contentKey,
        keyId: 'keyserver:sealed-v1',
        keyserverUrl: server.url,
      }));

      reindexAllSources({ db, paths: { entriesDir: entries, communityDir: community }, logger: warningLogger, keyProvider });

      // savepoint rollback: mid-stream で upsert 済みだった good-new も巻き戻り、
      // 当該 source は preexisting のまま（partial に good だけ入って残らない）
      const sealedRows = db.prepare("SELECT id FROM entries WHERE source = 'community/sealed-team'").all() as Array<{ id: string }>;
      expect(sealedRows.map((r) => r.id)).toEqual(['preexisting']);

      // own source は無傷
      const ownRowAfter = db.prepare("SELECT title, file_mtime FROM entries WHERE source = 'own'").get();
      expect(ownRowAfter).toEqual(ownRowBefore);

      // warn が出る
      expect(warnings.some((m) => m.includes('sealed reindex failed'))).toBe(true);

      // FTS 整合（external-content table と entries の食い違いがあれば integrity-check が例外を投げる）
      expect(() => db.exec("INSERT INTO entries_fts(entries_fts) VALUES('integrity-check')")).not.toThrow();
    } finally {
      db.close();
      await server.close();
      cleanup();
    }
  });

  it('reports a prewarm failure entry when the keyserver is unreachable', async () => {
    const { home, entries, community, cleanup } = fresh();
    try {
      mkdirSync(entries, { recursive: true });
      const repo = join(community, 'sealed-team');
      mkdirSync(join(repo, 'bundle'), { recursive: true });
      writeFileSync(join(repo, 'bundle', 'entries.caveat'), sealBundle({
        files: [{ relPath: 'sealed.md', content: Buffer.from(sealedSample('sealed', 'unreachable-marker')) }],
        contentKey: Buffer.alloc(32, 3),
        keyId: 'keyserver:unreachable',
        keyserverUrl: 'http://127.0.0.1:65535',
      }));
      const keyProvider = createKeyserverKeyProvider({ caveatHome: home });
      const failures = await prewarmSealedKeys({ paths: { communityDir: community }, keyProvider });
      expect(failures).toHaveLength(1);
      expect(failures[0]!.source).toBe('community/sealed-team');
      expect(failures[0]!.error).toBeInstanceOf(Error);
    } finally { cleanup(); }
  });

  it('changes digest when a sealed bundle mtime or size changes', () => {
    const { entries, community, cleanup } = fresh();
    try {
      const bundlePath = join(community, 'sealed-team', 'bundle', 'entries.caveat');
      mkdirSync(join(community, 'sealed-team', 'bundle'), { recursive: true });
      writeFileSync(bundlePath, 'sealed-a');
      const first = computeEntriesDigest({ entriesDir: entries, communityDir: community });
      expect(computeEntriesDigest({ entriesDir: entries, communityDir: community })).toEqual(first);
      const beforeMtime = statSync(bundlePath).mtime;
      utimesSync(bundlePath, beforeMtime, new Date(beforeMtime.getTime() + 1000));
      expect(computeEntriesDigest({ entriesDir: entries, communityDir: community }).digest).not.toBe(first.digest);
      const mtimeChanged = computeEntriesDigest({ entriesDir: entries, communityDir: community });
      writeFileSync(bundlePath, 'sealed-a-extra');
      expect(computeEntriesDigest({ entriesDir: entries, communityDir: community }).digest).not.toBe(mtimeChanged.digest);
    } finally { cleanup(); }
  });
});
