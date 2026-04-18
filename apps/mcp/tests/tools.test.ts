import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, loadConfigFromPaths, resolvePaths, type Logger } from '@caveat/core';
import type { McpContext } from '../src/context.js';
import { handleSearch } from '../src/tools/search.js';
import { handleGet } from '../src/tools/get.js';
import { handleRecord } from '../src/tools/record.js';
import { handleUpdate } from '../src/tools/update.js';
import { handleListRecent } from '../src/tools/listRecent.js';
import { handleNlmBriefFor } from '../src/tools/nlmBriefFor.js';
import { handleIngestResearch } from '../src/tools/ingestResearch.js';

interface Fx {
  root: string;
  toolRoot: string;
  userHome: string;
  knowledgeRepo: string;
  ctx: McpContext;
  db: DatabaseSync;
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-mcp-'));
  const toolRoot = join(root, 'tool');
  const userHome = join(root, 'home');
  const knowledgeRepo = join(root, 'caveats-quo');

  mkdirSync(toolRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(join(knowledgeRepo, 'entries'), { recursive: true });
  mkdirSync(join(toolRoot, '.index'), { recursive: true });
  mkdirSync(join(toolRoot, 'config'), { recursive: true });

  writeFileSync(join(toolRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n', 'utf-8');
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

  const userConfigPath = join(userHome, '.caveatrc.json');
  const config = loadConfigFromPaths(toolRoot, userConfigPath);
  const paths = resolvePaths(toolRoot, config.knowledgeRepo, userHome);
  const db = openDb({ path: paths.dbPath, logger: silentLogger });

  const ctx: McpContext = {
    toolRoot,
    userHome,
    userConfigPath,
    config,
    paths,
    logger: silentLogger,
    db,
    cwd: root,
  };
  return { root, toolRoot, userHome, knowledgeRepo, ctx, db };
}

function cleanup(f: Fx): void {
  f.db.close();
  rmSync(f.root, { recursive: true, force: true });
}

describe('MCP tool handlers', () => {
  let f: Fx;
  beforeEach(() => {
    f = makeFx();
  });
  afterEach(() => {
    cleanup(f);
  });

  describe('caveat_record', () => {
    it('creates md file with auto-filled frontmatter', () => {
      const result = handleRecord(f.ctx, {
        title: 'Sample gotcha',
        symptom: 'Something broken',
        confidence: 'reproduced',
        tags: ['test'],
      });
      expect(result.id).toBe('sample-gotcha');
      expect(existsSync(result.filePath)).toBe(true);
      const raw = readFileSync(result.filePath, 'utf-8');
      expect(raw).toContain('confidence: reproduced');
      expect(raw).toContain('outcome: resolved');
    });
  });

  describe('caveat_search', () => {
    it('finds newly recorded caveats via FTS', () => {
      handleRecord(f.ctx, { title: 'RTX 5090 issue', symptom: 'something', tags: ['gpu'] });
      const results = handleSearch(f.ctx, { query: 'rtx' });
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe('rtx-5090-issue');
    });

    it('filters by confidence', () => {
      handleRecord(f.ctx, {
        title: 'C1 test',
        symptom: 's',
        confidence: 'confirmed',
      });
      handleRecord(f.ctx, {
        title: 'T1 test',
        symptom: 's',
        confidence: 'tentative',
      });
      const confirmed = handleSearch(f.ctx, {
        query: 'test',
        filters: { confidence: ['confirmed'] },
      });
      expect(confirmed.length).toBe(1);
      expect(confirmed[0]?.confidence).toBe('confirmed');
    });
  });

  describe('caveat_get', () => {
    it('returns full entry by id', () => {
      handleRecord(f.ctx, {
        title: 'detail test',
        symptom: 'full body content',
        cause: 'cause text',
      });
      const got = handleGet(f.ctx, { id: 'detail-test' });
      expect(got.frontmatter.title).toBe('detail test');
      expect(got.sections['Symptom']).toBe('full body content');
      expect(got.sections['Cause']).toBe('cause text');
    });

    it('throws when id not found', () => {
      expect(() => handleGet(f.ctx, { id: 'nonexistent' })).toThrow(/not found/);
    });
  });

  describe('caveat_update', () => {
    it('patches frontmatter and syncs DB', () => {
      const { id } = handleRecord(f.ctx, {
        title: 'original',
        symptom: 's',
        confidence: 'tentative',
      });
      handleUpdate(f.ctx, {
        id,
        patch: { frontmatter: { confidence: 'confirmed' } },
      });
      const got = handleGet(f.ctx, { id });
      expect(got.frontmatter.confidence).toBe('confirmed');
    });

    it('rejects immutable keys', () => {
      const { id } = handleRecord(f.ctx, { title: 'immutable test', symptom: 's' });
      expect(() =>
        handleUpdate(f.ctx, {
          id,
          patch: { frontmatter: { id: 'other' } as never },
        }),
      ).toThrow(/immutable/);
    });
  });

  describe('caveat_list_recent', () => {
    it('returns entries in updated_at DESC order', () => {
      handleRecord(f.ctx, { title: 'first', symptom: 's' });
      handleRecord(f.ctx, { title: 'second', symptom: 's' });
      const results = handleListRecent(f.ctx, { limit: 10 });
      expect(results.length).toBe(2);
    });
  });

  describe('nlm_brief_for', () => {
    it('returns brief_id and formatted text', () => {
      const result = handleNlmBriefFor(f.ctx, { topic: 'CUDA 12.5 Blackwell' });
      expect(result.brief_id).toMatch(/^brf-/);
      expect(result.text).toContain('CUDA 12.5 Blackwell');
      expect(result.text).toContain(`brief_id: ${result.brief_id}`);
    });
  });

  describe('ingest_research', () => {
    it('creates caveat with confidence: tentative', () => {
      const result = handleIngestResearch(f.ctx, {
        title: 'research finding',
        symptom: 'new symptom',
        resolution: 'use version X',
        evidence: ['https://example.com/1', 'https://example.com/2'],
        brief_id: 'brf-test-1',
      });
      const got = handleGet(f.ctx, { id: result.id });
      expect(got.frontmatter.confidence).toBe('tentative');
      expect(got.frontmatter.brief_id).toBe('brf-test-1');
      expect(got.sections['Evidence']).toContain('https://example.com/1');
      expect(got.sections['Evidence']).toContain('https://example.com/2');
    });
  });
});
