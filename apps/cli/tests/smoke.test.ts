import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Logger } from '@caveat/core';
import { buildContext } from '../src/context.js';
import { runInit } from '../src/commands/init.js';
import { runIndex } from '../src/commands/indexCmd.js';

interface Fixture {
  root: string;
  toolRoot: string;
  userHome: string;
  knowledgeRepo: string;
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'caveat-cli-'));
  const toolRoot = join(root, 'tool');
  const userHome = join(root, 'home');
  const knowledgeRepo = join(root, 'caveats-quo');

  mkdirSync(toolRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(knowledgeRepo, { recursive: true });
  mkdirSync(join(knowledgeRepo, 'entries', 'gpu'), { recursive: true });

  // Minimum file to mark toolRoot as a workspace root (even though we pass it via override)
  writeFileSync(join(toolRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n', 'utf-8');
  mkdirSync(join(toolRoot, 'config'), { recursive: true });
  writeFileSync(
    join(toolRoot, 'config', 'default.json'),
    JSON.stringify({
      knowledgeRepo: '../caveats-quo',
      semverKeys: ['driver', 'cuda', 'node'],
      projectRoots: [],
      communitySources: [],
    }),
    'utf-8',
  );

  return { root, toolRoot, userHome, knowledgeRepo };
}

function cleanup(fx: Fixture): void {
  rmSync(fx.root, { recursive: true, force: true });
}

function sampleCaveat(id: string, title: string): string {
  return `---
id: ${id}
title: ${title}
visibility: public
confidence: reproduced
outcome: resolved
tags: [gpu, cuda]
environment:
  gpu: RTX 5090
  cuda: ">=12.5"
source_project: null
source_session: "2026-04-18T12:34:56Z/abc123def456"
created_at: 2026-04-18
updated_at: 2026-04-18
last_verified: 2026-04-18
---

## Symptom
Sample symptom text.

## Cause
Sample cause.

## Resolution
Sample resolution.

## Evidence
- http://example.com
`;
}

describe('init', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('creates ~/.caveatrc.json if missing and initializes .index/caveat.db', () => {
    const ctx = buildContext(silentLogger, { toolRoot: fx.toolRoot, userHome: fx.userHome });
    runInit(ctx);

    expect(existsSync(join(fx.userHome, '.caveatrc.json'))).toBe(true);
    expect(readFileSync(join(fx.userHome, '.caveatrc.json'), 'utf-8').trim()).toBe('{}');
    expect(existsSync(join(fx.toolRoot, '.index', 'caveat.db'))).toBe(true);
  });

  it('preserves existing user config content', () => {
    writeFileSync(
      join(fx.userHome, '.caveatrc.json'),
      JSON.stringify({ knowledgeRepo: '/custom/path' }),
      'utf-8',
    );
    const ctx = buildContext(silentLogger, { toolRoot: fx.toolRoot, userHome: fx.userHome });
    runInit(ctx);

    const after = JSON.parse(readFileSync(join(fx.userHome, '.caveatrc.json'), 'utf-8')) as {
      knowledgeRepo: string;
    };
    expect(after.knowledgeRepo).toBe('/custom/path');
  });
});

describe('index', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('picks up md files under entries/', () => {
    writeFileSync(
      join(fx.knowledgeRepo, 'entries', 'gpu', 'foo.md'),
      sampleCaveat('foo', 'Foo title'),
      'utf-8',
    );

    const ctx = buildContext(silentLogger, { toolRoot: fx.toolRoot, userHome: fx.userHome });
    runInit(ctx);
    runIndex(ctx, { full: false });

    // Read back via opened db
    const db = openDb({ path: ctx.paths.dbPath });
    try {
      const row = db.prepare('SELECT id, source, title FROM entries WHERE id = ?').get('foo') as
        | { id: string; source: string; title: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.source).toBe('own');
      expect(row?.title).toBe('Foo title');
    } finally {
      db.close();
    }
  });

  it('--full DELETEs existing entries before rescan', () => {
    writeFileSync(
      join(fx.knowledgeRepo, 'entries', 'gpu', 'a.md'),
      sampleCaveat('a', 'A'),
      'utf-8',
    );

    const ctx = buildContext(silentLogger, { toolRoot: fx.toolRoot, userHome: fx.userHome });
    runInit(ctx);
    runIndex(ctx, { full: false });

    // Verify 'a' was inserted
    let db = openDb({ path: ctx.paths.dbPath });
    let count = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    db.close();
    expect(count).toBe(1);

    // Full rebuild: delete 'a' first, then rescan (which re-inserts 'a' since md still exists)
    runIndex(ctx, { full: true });

    db = openDb({ path: ctx.paths.dbPath });
    count = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    db.close();
    expect(count).toBe(1);
  });
});
