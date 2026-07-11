import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  collectPublishSet,
  publishOwn,
  verifyMirror,
} from '../src/publish.js';
import type { CaveatConfig } from '../src/config.js';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const alwaysYes = () => true;

// publishOwn commits inside the mirror clone it creates, which has no local
// git identity. CI runners have no global identity either — inject one via
// env so every git child (execFileSync and simple-git) inherits it.
process.env.GIT_AUTHOR_NAME = 'caveat test';
process.env.GIT_AUTHOR_EMAIL = 'caveat-test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'caveat test';
process.env.GIT_COMMITTER_EMAIL = 'caveat-test@example.invalid';

interface Fixture {
  root: string;
  remote: string;
  entriesDir: string;
  mirrorDir: string;
  config: CaveatConfig;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function entry(id: string, visibility: string, body = 'symptom text'): string {
  return `---\nid: ${id}\ntitle: ${id}\nvisibility: ${visibility}\nconfidence: tentative\n---\n\n## Symptom\n${body}\n`;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'caveat-publish-'));
  const remote = join(root, 'remote.git');
  git(['init', '--bare', remote]);
  const entriesDir = join(root, 'own', 'entries');
  mkdirSync(entriesDir, { recursive: true });
  return {
    root,
    remote,
    entriesDir,
    mirrorDir: join(root, 'publish', 'mirror'),
    config: {
      knowledgeRepo: 'own',
      semverKeys: [],
      communitySources: [],
      publishTarget: remote,
    },
  };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const d of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, d.name);
      if (d.name === '.git') continue;
      if (d.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

// Real git subprocess chains (clone/fetch/reset/clean/commit/push × 2 per
// test) exceed vitest's 5s default on the slowest Windows CI runner.
const GIT_TEST_TIMEOUT_MS = 60_000;

let fixture: Fixture;
beforeEach(() => { fixture = makeFixture(); });
afterEach(() => {
  // maxRetries: Windows can report EBUSY on rmdir while a git child releases handles.
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('collectPublishSet', () => {
  it('returns only public entries and lists every invalid one', () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public'));
    mkdirSync(join(fixture.entriesDir, 'cat'), { recursive: true });
    writeFileSync(join(fixture.entriesDir, 'cat', 'b.md'), entry('b', 'private', 'secret repo detail'));
    writeFileSync(join(fixture.entriesDir, 'c.md'), entry('c', 'Public')); // typo → invalid
    writeFileSync(join(fixture.entriesDir, 'd.md'), '---\nid: d\nvisibility: [broken\n');

    const set = collectPublishSet(fixture.entriesDir);
    expect(set.files.map((f) => f.relPath).sort()).toEqual(['a.md']);
    expect(set.invalid.map((x) => x.relPath).sort()).toEqual(['c.md', 'd.md']);
  });
});

describe('publishOwn (local bare mirror)', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  function cloneMirrorBack(): string {
    const check = join(fixture.root, 'verify-clone');
    rmSync(check, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    git(['clone', fixture.remote, check]);
    return check;
  }

  it('mirrors ONLY public entries — no private bytes reach the remote', async () => {
    writeFileSync(join(fixture.entriesDir, 'pub.md'), entry('pub', 'public', 'public boot failure'));
    mkdirSync(join(fixture.entriesDir, 'secret'), { recursive: true });
    writeFileSync(join(fixture.entriesDir, 'secret', 'priv.md'), entry('priv', 'private', 'CONFIDENTIAL-INTERNAL-TOKEN'));

    const result = await publishOwn({
      paths: { entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir },
      config: fixture.config, logger, confirmImpl: alwaysYes, isTty: () => false, yes: true,
    });
    expect(result.changed).toBe(true);
    expect(result.fileCount).toBe(1);

    const clone = cloneMirrorBack();
    const allText = walkFiles(clone).map((p) => readFileSync(p, 'utf-8')).join('\n');
    // The private entry's id, body, and the word "private" must be absent.
    expect(allText).not.toContain('CONFIDENTIAL-INTERNAL-TOKEN');
    expect(allText).not.toContain('priv');
    expect(allText).not.toContain('visibility: private');
    expect(existsSync(join(clone, 'entries', 'pub.md'))).toBe(true);
    expect(existsSync(join(clone, 'entries', 'secret'))).toBe(false);
  });

  it('aborts entirely when any entry has invalid visibility', async () => {
    writeFileSync(join(fixture.entriesDir, 'ok.md'), entry('ok', 'public'));
    writeFileSync(join(fixture.entriesDir, 'bad.md'), entry('bad', 'Public')); // capitalized typo → invalid
    await expect(publishOwn({
      paths: { entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir },
      config: fixture.config, logger, confirmImpl: alwaysYes, yes: true,
    })).rejects.toThrow(/invalid entries/i);
    // Nothing pushed.
    const clone = cloneMirrorBack();
    expect(existsSync(join(clone, 'entries'))).toBe(false);
  });

  it('follows renames, deletions and public→private flips on re-publish', async () => {
    writeFileSync(join(fixture.entriesDir, 'keep.md'), entry('keep', 'public'));
    writeFileSync(join(fixture.entriesDir, 'gone.md'), entry('gone', 'public'));
    writeFileSync(join(fixture.entriesDir, 'demote.md'), entry('demote', 'public'));
    const base = { paths: { entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir }, config: fixture.config, logger, confirmImpl: alwaysYes, isTty: () => false, yes: true };
    await publishOwn(base);

    rmSync(join(fixture.entriesDir, 'gone.md'));
    writeFileSync(join(fixture.entriesDir, 'demote.md'), entry('demote', 'private', 'now secret'));
    writeFileSync(join(fixture.entriesDir, 'fresh.md'), entry('fresh', 'public'));
    await publishOwn(base);

    const clone = cloneMirrorBack();
    const present = walkFiles(join(clone, 'entries')).map((p) => relative(join(clone, 'entries'), p)).sort();
    expect(present).toEqual(['fresh.md', 'keep.md']);
  });

  it('is a no-op with no commit when nothing changed (deterministic README)', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public'));
    const base = { paths: { entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir }, config: fixture.config, logger, confirmImpl: alwaysYes, isTty: () => false, yes: true };
    await publishOwn(base);
    const clone1 = cloneMirrorBack();
    const count1 = git(['rev-list', '--count', 'HEAD'], clone1).trim();
    const second = await publishOwn(base);
    expect(second.changed).toBe(false);
    rmSync(join(fixture.root, 'verify-clone'), { recursive: true, force: true });
    const clone2 = cloneMirrorBack();
    const count2 = git(['rev-list', '--count', 'HEAD'], clone2).trim();
    expect(count2).toBe(count1);
  });

  it('cleans untracked debris in the reused mirror before committing (C4)', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public'));
    const base = { paths: { entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir }, config: fixture.config, logger, confirmImpl: alwaysYes, isTty: () => false, yes: true };
    await publishOwn(base);
    // Simulate a crashed prior run leaving a stray file outside entries/.
    writeFileSync(join(fixture.mirrorDir, 'leaked-secret.txt'), 'PRIVATE LEAK');
    writeFileSync(join(fixture.entriesDir, 'b.md'), entry('b', 'public'));
    await publishOwn(base);
    const clone = cloneMirrorBack();
    const allText = walkFiles(clone).map((p) => readFileSync(p, 'utf-8')).join('\n');
    expect(allText).not.toContain('PRIVATE LEAK');
    expect(existsSync(join(clone, 'leaked-secret.txt'))).toBe(false);
  });

  it('removes pre-existing tracked files outside entries/ — the mirror is a true full replacement', async () => {
    // Seed the remote with a tracked root-level file (as if some past process
    // committed it). reset --hard restores tracked files, clean only removes
    // untracked ones — the full-replacement writeMirror must still delete it.
    const seed = join(fixture.root, 'seed');
    git(['clone', fixture.remote, seed]);
    git(['config', 'user.email', 't@t'], seed);
    git(['config', 'user.name', 't'], seed);
    git(['config', 'commit.gpgsign', 'false'], seed);
    writeFileSync(join(seed, 'rootsecret.md'), 'ROOT-PRIVATE-LEAK-XYZ');
    git(['add', '-A'], seed);
    git(['commit', '-m', 'seed'], seed);
    git(['push', 'origin', 'HEAD:main'], seed);

    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public'));
    await publishOwn({
      paths: { entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir },
      config: fixture.config, logger, confirmImpl: alwaysYes, isTty: () => false, yes: true,
    });

    const clone = cloneMirrorBack();
    const allText = walkFiles(clone).map((p) => readFileSync(p, 'utf-8')).join('\n');
    expect(allText).not.toContain('ROOT-PRIVATE-LEAK-XYZ');
    expect(existsSync(join(clone, 'rootsecret.md'))).toBe(false);
    expect(existsSync(join(clone, 'entries', 'a.md'))).toBe(true);
  });

  it('rejects a mirror workdir pointing at a different target', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public'));
    const base = { paths: { entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir }, config: fixture.config, logger, confirmImpl: alwaysYes, isTty: () => false, yes: true };
    await publishOwn(base);
    const otherRemote = join(fixture.root, 'other.git');
    git(['init', '--bare', otherRemote]);
    await expect(publishOwn({ ...base, config: { ...fixture.config, publishTarget: otherRemote } }))
      .rejects.toThrow(/mirror points at/i);
  });
});

describe('verifyMirror', () => {
  it('throws if a private or malformed entry is present in the mirror', () => {
    const dir = join(fixture.root, 'mirror-check');
    mkdirSync(join(dir, 'entries'), { recursive: true });
    writeFileSync(join(dir, 'entries', 'ok.md'), entry('ok', 'public'));
    expect(verifyMirror(dir).fileCount).toBe(1);
    writeFileSync(join(dir, 'entries', 'leak.md'), entry('leak', 'private'));
    expect(() => verifyMirror(dir)).toThrow(/verification failed/i);
  });
});
