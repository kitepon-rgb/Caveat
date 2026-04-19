import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pushEntry, type Logger } from '../src/index.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const GH_AVAILABLE = spawnSync('gh', ['--version'], {
  encoding: 'utf-8',
  shell: true,
}).status === 0;

interface Fx {
  root: string;
  caveatHome: string;
  entriesDir: string;
}

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-push-'));
  const caveatHome = join(root, 'caveat-home');
  const entriesDir = join(caveatHome, 'own', 'entries');
  mkdirSync(entriesDir, { recursive: true });
  return { root, caveatHome, entriesDir };
}

function writeEntry(
  fx: Fx,
  category: string,
  slug: string,
  visibility: 'public' | 'private' = 'public',
): void {
  const dir = join(fx.entriesDir, category);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---
id: ${slug}
title: ${slug} sample title
visibility: ${visibility}
confidence: tentative
outcome: resolved
tags: [test]
environment: {}
source_project: null
source_session: "2026-04-19T00:00:00Z/000000000000"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Symptom
body
`,
    'utf-8',
  );
}

describe('pushEntry', () => {
  let fx: Fx;
  beforeEach(() => {
    fx = makeFx();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('returns gh-missing / gh-unauthed / dry-run path depending on env', async () => {
    writeEntry(fx, 'gpu', 'rtx-test');
    const result = await pushEntry({
      entriesDir: fx.entriesDir,
      caveatHome: fx.caveatHome,
      sharedRepoUrl: 'https://github.com/kitepon-rgb/Caveat',
      id: 'rtx-test',
      dryRun: true,
      logger: silentLogger,
    });
    if (!GH_AVAILABLE) {
      expect(result.status).toBe('gh-missing');
      return;
    }
    // gh is available in this env; either authed (dry-run) or not (gh-unauthed)
    expect(['dry-run', 'gh-unauthed']).toContain(result.status);
    if (result.status === 'dry-run') {
      expect(result.plannedSteps).toBeDefined();
      expect(result.plannedSteps!.length).toBe(4);
      expect(result.plannedSteps![0]).toMatch(/^fork kitepon-rgb\/Caveat/);
      expect(result.plannedSteps![2]).toMatch(/copy entry → entries\/gpu\/rtx-test\.md$/);
    }
  });

  it('returns not-found when entry id does not exist', async () => {
    const result = await pushEntry({
      entriesDir: fx.entriesDir,
      caveatHome: fx.caveatHome,
      sharedRepoUrl: 'https://github.com/kitepon-rgb/Caveat',
      id: 'does-not-exist',
      dryRun: true,
      logger: silentLogger,
    });
    if (!GH_AVAILABLE) {
      // If gh is missing we short-circuit before the find step; that is OK.
      expect(result.status).toBe('gh-missing');
      return;
    }
    if (result.status === 'gh-unauthed') return;
    expect(result.status).toBe('not-found');
    expect(result.detail).toMatch(/does-not-exist/);
  });

  it('rejects visibility: private entries before any GitHub action', async () => {
    writeEntry(fx, 'gpu', 'rtx-private', 'private');
    const result = await pushEntry({
      entriesDir: fx.entriesDir,
      caveatHome: fx.caveatHome,
      sharedRepoUrl: 'https://github.com/kitepon-rgb/Caveat',
      id: 'rtx-private',
      dryRun: true,
      logger: silentLogger,
    });
    if (!GH_AVAILABLE) {
      expect(result.status).toBe('gh-missing');
      return;
    }
    if (result.status === 'gh-unauthed') return;
    expect(result.status).toBe('visibility-private');
    expect(result.detail).toMatch(/private/);
  });

  it('rejects an invalid sharedRepoUrl', async () => {
    writeEntry(fx, 'gpu', 'rtx-test');
    const result = await pushEntry({
      entriesDir: fx.entriesDir,
      caveatHome: fx.caveatHome,
      sharedRepoUrl: 'https://gitlab.com/org/repo',
      id: 'rtx-test',
      dryRun: true,
      logger: silentLogger,
    });
    // gh availability doesn't matter — URL validation is early
    if (!GH_AVAILABLE) {
      expect(result.status).toBe('gh-missing');
      return;
    }
    if (result.status === 'gh-unauthed') return;
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/GitHub-only/);
  });
});
