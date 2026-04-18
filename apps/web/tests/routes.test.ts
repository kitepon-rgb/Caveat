import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  openDb,
  recordEntry,
  loadConfigFromPaths,
  resolvePaths,
  type Logger,
} from '@caveat/core';
import type { WebContext } from '../src/context.js';
import { createApp } from '../src/app.js';

interface Fx {
  root: string;
  toolRoot: string;
  userHome: string;
  ctx: WebContext;
  db: DatabaseSync;
  app: ReturnType<typeof createApp>;
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-web-'));
  const toolRoot = join(root, 'tool');
  const userHome = join(root, 'home');
  const knowledgeRepo = join(root, 'caveats-quo');

  mkdirSync(toolRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(join(knowledgeRepo, 'entries'), { recursive: true });
  mkdirSync(join(toolRoot, '.index'), { recursive: true });
  mkdirSync(join(toolRoot, 'config'), { recursive: true });

  writeFileSync(join(toolRoot, 'pnpm-workspace.yaml'), 'packages:\n', 'utf-8');
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

  const config = loadConfigFromPaths(toolRoot, join(userHome, '.caveatrc.json'));
  const paths = resolvePaths(toolRoot, config.knowledgeRepo, userHome);
  const db = openDb({ path: paths.dbPath, logger: silentLogger });

  const ctx: WebContext = {
    toolRoot,
    userHome,
    userConfigPath: join(userHome, '.caveatrc.json'),
    config,
    paths,
    logger: silentLogger,
    db,
  };
  const app = createApp(ctx);
  return { root, toolRoot, userHome, ctx, db, app };
}

function cleanup(f: Fx): void {
  f.db.close();
  rmSync(f.root, { recursive: true, force: true });
}

describe('web routes', () => {
  let f: Fx;
  beforeEach(() => {
    f = makeFx();
  });
  afterEach(() => {
    cleanup(f);
  });

  describe('GET /', () => {
    it('returns empty state when no entries', async () => {
      const res = await f.app.request('/');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('no entries yet');
      expect(html).toContain('<title>Caveat</title>');
    });

    it('lists recent entries when present', async () => {
      recordEntry(
        { title: 'Sample gotcha', symptom: 'Something broken', tags: ['gpu'] },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/');
      const html = await res.text();
      expect(html).toContain('Sample gotcha');
      expect(html).toContain('/g/sample-gotcha');
    });

    it('FTS search filters results', async () => {
      recordEntry(
        { title: 'RTX 5090 issue', symptom: 'gpu fail' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      recordEntry(
        { title: 'unrelated topic', symptom: 'nothing' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/?q=rtx');
      const html = await res.text();
      expect(html).toContain('RTX 5090 issue');
      expect(html).not.toContain('unrelated topic');
    });
  });

  describe('GET /g/:id', () => {
    it('returns 404 for missing id', async () => {
      const res = await f.app.request('/g/nonexistent');
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('not found');
    });

    it('renders full caveat with frontmatter + body', async () => {
      recordEntry(
        {
          title: 'detail case',
          symptom: 'body of the symptom',
          cause: 'cause text',
          confidence: 'confirmed',
          tags: ['gpu'],
        },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/g/detail-case');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('detail case');
      expect(html).toContain('body of the symptom');
      expect(html).toContain('cause text');
      expect(html).toContain('confirmed');
    });

    it('renders wikilinks in body', async () => {
      recordEntry(
        {
          title: 'referencing case',
          symptom: 'see [[other-case]] for context',
        },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/g/referencing-case');
      const html = await res.text();
      expect(html).toContain('href="/g/other-case"');
      expect(html).toContain('class="wikilink"');
    });
  });

  describe('GET /community', () => {
    it('shows empty state when no community repos', async () => {
      const res = await f.app.request('/community');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('no community repos imported');
    });

    it('lists imported community handles', async () => {
      mkdirSync(join(f.ctx.paths.communityDir, 'alice'), { recursive: true });
      mkdirSync(join(f.ctx.paths.communityDir, 'bob'), { recursive: true });
      const res = await f.app.request('/community');
      const html = await res.text();
      expect(html).toContain('alice');
      expect(html).toContain('bob');
    });
  });
});
