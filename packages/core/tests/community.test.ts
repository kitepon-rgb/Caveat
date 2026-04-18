import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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

  it('pull returns failed entry when git fails', async () => {
    const communityDir = join(playground, 'community');
    mkdirSync(join(communityDir, 'not-a-repo'));

    const results = await communityPull({ communityDir });
    expect(results.length).toBe(1);
    expect(results[0]?.handle).toBe('not-a-repo');
    expect(results[0]?.status).toBe('failed');
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

function readdirSafe(path: string): string[] {
  try {
    return require('node:fs').readdirSync(path) as string[];
  } catch {
    return [];
  }
}
