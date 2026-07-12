import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, loadConfig, resolvePaths, type Logger } from '@caveat/core';
import type { McpContext } from '../src/context.js';
import { handleSearch } from '../src/tools/search.js';
import { handleGet } from '../src/tools/get.js';
import { handleRecord } from '../src/tools/record.js';
import { handleUpdate } from '../src/tools/update.js';
import { handleListRecent } from '../src/tools/listRecent.js';
import { recordInputShape } from '../src/tools/record.js';
import { updateInputShape } from '../src/tools/update.js';
import { searchInputShape } from '../src/tools/search.js';
import { registerAllTools } from '../src/registerTools.js';

interface Fx {
  root: string;
  caveatHome: string;
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
  const caveatHome = join(root, 'caveat-home');
  const userHome = join(root, 'home');
  const knowledgeRepo = join(caveatHome, 'own');

  mkdirSync(caveatHome, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(join(knowledgeRepo, 'entries'), { recursive: true });

  const userConfigPath = join(userHome, '.caveatrc.json');
  const config = loadConfig(userConfigPath);
  const paths = resolvePaths(caveatHome, config.knowledgeRepo, userHome);
  const db = openDb({ path: paths.dbPath, logger: silentLogger });

  const ctx: McpContext = {
    caveatHome,
    userHome,
    userConfigPath,
    config,
    paths,
    logger: silentLogger,
    db,
  };
  return { root, caveatHome, userHome, knowledgeRepo, ctx, db };
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

    it('rejects community sources at the tool boundary', () => {
      expect(() =>
        handleUpdate(f.ctx, {
          id: 'sample',
          source: 'community/team',
          patch: { frontmatter: { confidence: 'confirmed' } },
        }),
      ).toThrow(/community エントリは購読物/);
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

});

describe('MCP tool metadata contracts', () => {
  it('describes bilingual symptom enrichment without altering raw errors', () => {
    expect(recordInputShape.symptom.description).toContain('Preserve raw errors');
    expect(recordInputShape.symptom.description).toMatch(/Japanese and English/);
    expect(recordInputShape.symptom.description).toContain('Do not force a full translation');

    const sections = updateInputShape.patch.shape.sections;
    expect(sections.description).toContain('When changing the Symptom section');
    expect(sections.description).toContain('preserve raw errors');
    expect(sections.description).toMatch(/Japanese and English/);
  });

  it('describes retrying zero-hit searches with bilingual synonyms while retaining plain-token FTS', () => {
    expect(searchInputShape.query.description).toContain('If a search returns 0 hits');
    expect(searchInputShape.query.description).toMatch(/synonyms and Japanese\/English paraphrases/);
    expect(searchInputShape.query.description).toContain('FTS operators are not supported');
  });

  it('registers current search, visibility, and Symptom-update guidance', () => {
    const registered = new Map<string, { description: string }>();
    const server = {
      registerTool(name: string, config: { description: string }) {
        registered.set(name, config);
      },
    };
    const f = makeFx();
    try {
      registerAllTools(server as never, f.ctx);
    } finally {
      cleanup(f);
    }

    const search = registered.get('caveat_search')?.description ?? '';
    expect(search).toContain('If it returns 0 hits');
    expect(search).toMatch(/synonyms and Japanese\/English paraphrases/);
    expect(search).toContain('no OR/NEAR/other FTS5 operators');

    const record = registered.get('caveat_record')?.description ?? '';
    expect(record).toContain('run caveat_search first to avoid duplicates');
    expect(record).toContain('third party could reproduce it');
    expect(record).toContain('when unclear, prefer `private`');
    expect(record).toContain('follow an explicit user visibility choice');
    expect(record).toContain('reusable repo-specific traps may be `private`');
    expect(record).not.toMatch(/ASK THE USER|never auto-classify|project-internal bugs, user preferences, session summaries, ephemeral task notes/);
    expect(record).not.toContain('kept local only');

    const update = registered.get('caveat_update')?.description ?? '';
    expect(update).toContain('When changing `Symptom`, preserve raw errors verbatim');
    expect(update).toMatch(/Japanese\/English symptom keywords/);
  });
});
