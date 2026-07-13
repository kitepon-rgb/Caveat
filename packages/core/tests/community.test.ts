import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.js';
import {
  validateCommunityUrl,
  resolveHandleCollision,
  communityAdd,
  communityPull,
  communityList,
  communityRemove,
} from '../src/community.js';

describe('validateCommunityUrl', () => {
  it('accepts github.com/<org>/<repo>', () => {
    const r = validateCommunityUrl('https://github.com/alice/caveats-alice');
    expect(r.valid).toBe(true);
    expect(r.handle).toBe('caveats-alice');
  });

  it('accepts .git suffix', () => {
    const r = validateCommunityUrl('https://github.com/alice/caveats-alice.git');
    expect(r.valid).toBe(true);
    expect(r.handle).toBe('caveats-alice');
  });

  it('accepts trailing slash', () => {
    const r = validateCommunityUrl('https://github.com/alice/caveats-alice/');
    expect(r.valid).toBe(true);
    expect(r.handle).toBe('caveats-alice');
  });

  it('rejects gitlab', () => {
    const r = validateCommunityUrl('https://gitlab.com/x/y');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('GitHub-only');
  });

  it('rejects ssh url', () => {
    const r = validateCommunityUrl('git@github.com:alice/caveats.git');
    expect(r.valid).toBe(false);
  });

  it('rejects http (not https)', () => {
    const r = validateCommunityUrl('http://github.com/a/b');
    expect(r.valid).toBe(false);
  });

  it('rejects deep paths', () => {
    const r = validateCommunityUrl('https://github.com/a/b/tree/main');
    expect(r.valid).toBe(false);
  });

  it('rejects empty string', () => {
    const r = validateCommunityUrl('');
    expect(r.valid).toBe(false);
  });
});

describe('communityAdd bare-name expansion (C6 traversal guard)', () => {
  it('rejects a traversal/invalid bare name without attempting a clone', async () => {
    // A bare name that is not a valid GitHub handle must NOT be expanded to a
    // URL and must NOT reach git clone; it falls through to URL validation and
    // is rejected. This is the path-traversal guard.
    for (const bad of ['../evil', 'a/b', '-leading', 'trailing-', 'has space']) {
      await expect(
        communityAdd({ url: bad, communityDir: mkdtempSync(join(tmpdir(), 'caveat-c6-')) }),
      ).rejects.toThrow(/invalid community URL/i);
    }
  });
});

describe('resolveHandleCollision', () => {
  it('returns base when no conflict', () => {
    expect(resolveHandleCollision('foo', () => false)).toBe('foo');
  });

  it('appends -2, -3, ... when taken', () => {
    const taken = new Set(['foo', 'foo-2']);
    expect(resolveHandleCollision('foo', (h) => taken.has(h))).toBe('foo-3');
  });
});

interface FakeRemote {
  root: string;
  bareUrl: string;
  workdir: string;
}

function initBareWithContent(): FakeRemote {
  const root = mkdtempSync(join(tmpdir(), 'caveat-remote-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');

  execFileSync('git', ['init', '--bare', bare], { stdio: 'pipe' });

  execFileSync('git', ['clone', bare, work], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: work });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: work });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: work });

  mkdirSync(join(work, 'entries', 'gpu'), { recursive: true });
  writeFileSync(
    join(work, 'entries', 'gpu', 'sample.md'),
    `---\nid: sample\ntitle: Sample\nvisibility: public\nconfidence: tentative\n---\n\n## Symptom\nx\n`,
    'utf-8',
  );
  execFileSync('git', ['add', '-A'], { cwd: work });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: work });
  execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: work });

  return { root, bareUrl: bare, workdir: work };
}

describe('communityAdd / communityPull / communityList (integration)', () => {
  let remote: FakeRemote;
  let playground: string;
  beforeEach(() => {
    remote = initBareWithContent();
    playground = mkdtempSync(join(tmpdir(), 'caveat-play-'));
    mkdirSync(join(playground, 'community'), { recursive: true });
  });
  afterEach(() => {
    rmSync(remote.root, { recursive: true, force: true });
    rmSync(playground, { recursive: true, force: true });
  });

  it('add rejects non-github URLs without touching filesystem', async () => {
    await expect(
      communityAdd({
        url: 'https://gitlab.com/x/y',
        communityDir: join(playground, 'community'),
      }),
    ).rejects.toThrow(/GitHub-only/);
    expect(readdirSafe(join(playground, 'community'))).toEqual([]);
  });

  it('pull iterates existing community handles (noop success for up-to-date)', async () => {
    // Set up: manually clone the bare repo into community/foo
    const communityDir = join(playground, 'community');
    execFileSync('git', ['clone', '--depth', '1', remote.bareUrl, join(communityDir, 'foo')], {
      stdio: 'pipe',
    });

    const results = await communityPull({ communityDir });
    expect(results.length).toBe(1);
    expect(results[0]?.handle).toBe('foo');
    expect(results[0]?.status).toBe('ok');
  });

  it('pull updates plaintext community repos through fetch reset clean', async () => {
    const communityDir = join(playground, 'community');
    const target = join(communityDir, 'foo');
    execFileSync('git', ['clone', '--depth', '1', remote.bareUrl, target], { stdio: 'pipe' });

    writeFileSync(
      join(remote.workdir, 'entries', 'gpu', 'sample.md'),
      `---\nid: sample\ntitle: Updated\nvisibility: public\nconfidence: tentative\n---\n\n## Symptom\nupdated plaintext\n`,
      'utf-8',
    );
    execFileSync('git', ['add', '-A'], { cwd: remote.workdir });
    execFileSync('git', ['commit', '-m', 'update'], { cwd: remote.workdir });
    execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: remote.workdir });

    const results = await communityPull({ communityDir });
    expect(results[0]?.status).toBe('ok');
    expect(readFileSafe(join(target, 'entries', 'gpu', 'sample.md'))).toContain('updated plaintext');
  });

  it('pull survives orphan force-push replacement without unrelated histories failure', async () => {
    const communityDir = join(playground, 'community');
    const target = join(communityDir, 'foo');
    execFileSync('git', ['clone', '--depth', '1', remote.bareUrl, target], { stdio: 'pipe' });

    execFileSync('git', ['checkout', '--orphan', 'sealed-replacement'], { cwd: remote.workdir });
    execFileSync('git', ['rm', '-rf', '.'], { cwd: remote.workdir });
    mkdirSync(join(remote.workdir, 'bundle'), { recursive: true });
    writeFileSync(join(remote.workdir, 'README.md'), 'sealed replacement\n', 'utf-8');
    writeFileSync(join(remote.workdir, 'bundle', 'entries.caveat'), 'encrypted', 'utf-8');
    execFileSync('git', ['add', '-A'], { cwd: remote.workdir });
    execFileSync('git', ['commit', '-m', 'orphan replacement'], { cwd: remote.workdir });
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: target,
      encoding: 'utf-8',
    }).trim();
    execFileSync('git', ['push', '--force', 'origin', `HEAD:${branch}`], { cwd: remote.workdir });

    const results = await communityPull({ communityDir });
    expect(results[0]?.status).toBe('ok');
    expect(existsSync(join(target, 'entries'))).toBe(false);
    expect(readFileSafe(join(target, 'README.md'))).toContain('sealed replacement');
    expect(readFileSafe(join(target, 'bundle', 'entries.caveat'))).toBe('encrypted');
  });

  it('pull returns failed entry when git fails', async () => {
    const communityDir = join(playground, 'community');
    mkdirSync(join(communityDir, 'not-a-repo'));

    const results = await communityPull({ communityDir });
    expect(results.length).toBe(1);
    expect(results[0]?.handle).toBe('not-a-repo');
    expect(results[0]?.status).toBe('failed');
  });

  it('passes the requested git timeout policy to each community pull', async () => {
    const communityDir = join(playground, 'community');
    mkdirSync(join(communityDir, 'timeout-probe'));

    const results = await communityPull({ communityDir, gitTimeoutMs: 5_999 });
    expect(results).toEqual([expect.objectContaining({
      handle: 'timeout-probe',
      status: 'failed',
      message: expect.stringContaining('at least 6000'),
    })]);
  });

  it('list reports handles + entry counts from DB', () => {
    const communityDir = join(playground, 'community');
    mkdirSync(join(communityDir, 'alice'));
    mkdirSync(join(communityDir, 'bob'));

    const db = openDb({ path: ':memory:' });
    try {
      db.prepare(
        `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'x',
        'community/alice',
        'entries/x.md',
        'X',
        '',
        '{}',
        '[]',
        'tentative',
        'public',
        '2026-04-18',
        '2026-04-18',
      );

      const result = communityList({ communityDir, db });
      const alice = result.find((r) => r.handle === 'alice');
      const bob = result.find((r) => r.handle === 'bob');
      expect(alice?.entryCount).toBe(1);
      expect(bob?.entryCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('list returns empty when community dir does not exist', () => {
    const db = openDb({ path: ':memory:' });
    try {
      const result = communityList({
        communityDir: join(playground, 'nonexistent'),
        db,
      });
      expect(result).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('communityRemove', () => {
  let playground: string;
  beforeEach(() => {
    playground = mkdtempSync(join(tmpdir(), 'caveat-remove-'));
    mkdirSync(join(playground, 'community'), { recursive: true });
  });
  afterEach(() => {
    rmSync(playground, { recursive: true, force: true });
  });

  function seedRow(db: ReturnType<typeof openDb>, source: string, id: string): void {
    db.prepare(
      `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      source,
      `entries/${id}.md`,
      id,
      '',
      '{}',
      '[]',
      'tentative',
      'public',
      '2026-04-19',
      '2026-04-19',
    );
  }

  it('removes the directory and deletes db rows for the source', () => {
    const communityDir = join(playground, 'community');
    mkdirSync(join(communityDir, 'alice', 'entries'), { recursive: true });
    writeFileSync(join(communityDir, 'alice', 'entries', 'a.md'), 'x', 'utf-8');

    const db = openDb({ path: ':memory:' });
    try {
      seedRow(db, 'community/alice', 'a1');
      seedRow(db, 'community/alice', 'a2');
      seedRow(db, 'community/bob', 'b1');

      const result = communityRemove({ communityDir, handle: 'alice', db });
      expect(result.dirExisted).toBe(true);
      expect(result.rowCount).toBe(2);
      expect(result.removed).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(existsSync(join(communityDir, 'alice'))).toBe(false);

      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM entries WHERE source LIKE ?')
        .get('community/%') as { n: number };
      expect(remaining.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('dry-run reports counts without mutating disk or db', () => {
    const communityDir = join(playground, 'community');
    mkdirSync(join(communityDir, 'alice'));
    const db = openDb({ path: ':memory:' });
    try {
      seedRow(db, 'community/alice', 'a1');

      const result = communityRemove({ communityDir, handle: 'alice', db, dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.removed).toBe(false);
      expect(result.dirExisted).toBe(true);
      expect(result.rowCount).toBe(1);
      expect(existsSync(join(communityDir, 'alice'))).toBe(true);

      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM entries WHERE source = ?')
        .get('community/alice') as { n: number };
      expect(remaining.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('returns dirExisted=false rowCount=0 for an unknown handle (idempotent)', () => {
    const communityDir = join(playground, 'community');
    const db = openDb({ path: ':memory:' });
    try {
      const result = communityRemove({ communityDir, handle: 'ghost', db });
      expect(result.dirExisted).toBe(false);
      expect(result.rowCount).toBe(0);
      expect(result.removed).toBe(false);
    } finally {
      db.close();
    }
  });

  it('rejects path traversal handles', () => {
    const communityDir = join(playground, 'community');
    const db = openDb({ path: ':memory:' });
    try {
      expect(() => communityRemove({ communityDir, handle: '../escape', db })).toThrow(
        /invalid handle/,
      );
      expect(() => communityRemove({ communityDir, handle: '..', db })).toThrow(/invalid handle/);
      expect(() => communityRemove({ communityDir, handle: '.', db })).toThrow(/invalid handle/);
      expect(() => communityRemove({ communityDir, handle: 'a/b', db })).toThrow(/invalid handle/);
      expect(() => communityRemove({ communityDir, handle: '', db })).toThrow(/required/);
    } finally {
      db.close();
    }
  });

  it('purges only the targeted source (own and other community handles untouched)', () => {
    const communityDir = join(playground, 'community');
    mkdirSync(join(communityDir, 'alice'));
    mkdirSync(join(communityDir, 'bob'));

    const db = openDb({ path: ':memory:' });
    try {
      seedRow(db, 'own', 'o1');
      seedRow(db, 'community/alice', 'a1');
      seedRow(db, 'community/bob', 'b1');

      communityRemove({ communityDir, handle: 'alice', db });

      const own = db
        .prepare('SELECT COUNT(*) AS n FROM entries WHERE source = ?')
        .get('own') as { n: number };
      const bob = db
        .prepare('SELECT COUNT(*) AS n FROM entries WHERE source = ?')
        .get('community/bob') as { n: number };
      expect(own.n).toBe(1);
      expect(bob.n).toBe(1);
      expect(existsSync(join(communityDir, 'bob'))).toBe(true);
    } finally {
      db.close();
    }
  });
});

function readdirSafe(path: string): string[] {
  try {
    return require('node:fs').readdirSync(path) as string[];
  } catch {
    return [];
  }
}

function readFileSafe(path: string): string {
  return readFileSync(path, 'utf-8');
}
