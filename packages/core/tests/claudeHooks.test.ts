import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractPromptCandidates,
  findCaveatsForPrompt,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  stopReminderText,
} from '../src/claudeHooks.js';
import { openDb } from '../src/db.js';
import { recordEntry } from '../src/record.js';

describe('extractPromptCandidates', () => {
  it('returns [] on empty / non-string', () => {
    expect(extractPromptCandidates('')).toEqual([]);
    expect(extractPromptCandidates(undefined)).toEqual([]);
    expect(extractPromptCandidates(null)).toEqual([]);
  });

  it('keeps 3+ char ASCII words', () => {
    expect(extractPromptCandidates('rtx cuda init')).toEqual(['rtx', 'cuda', 'init']);
  });

  it('drops tokens shorter than 3 chars', () => {
    expect(extractPromptCandidates('on in at io hi me node')).toEqual(['node']);
  });

  it('strips FTS5 operator chars and splits', () => {
    expect(extractPromptCandidates('node:sqlite fails')).toEqual(['node', 'sqlite', 'fails']);
    expect(extractPromptCandidates('a+b*c driver')).toEqual(['driver']);
  });

  it('deduplicates case-insensitively, preserving first-seen casing', () => {
    expect(extractPromptCandidates('CUDA cuda Cuda driver Driver')).toEqual(['CUDA', 'driver']);
  });

  it('expands CJK runs into 3-char sliding windows', () => {
    expect(extractPromptCandidates('RTX 5090 で 初期化失敗 する')).toEqual([
      'RTX',
      '5090',
      '初期化',
      '期化失',
      '化失敗',
    ]);
  });

  it('produces all 3-char windows for no-space CJK (incl. pure-hira)', () => {
    const tokens = extractPromptCandidates('なぜか初期化失敗する');
    expect(tokens).toContain('初期化');
    expect(tokens).toContain('化失敗');
    // Pure-hiragana windows like なぜか are kept here; the co-occurrence rule
    // is what prevents them from triggering unrelated matches on their own.
    expect(tokens).toContain('なぜか');
  });

  it('caps at 50 candidate tokens', () => {
    const many = Array.from({ length: 120 }, (_, i) => `tok${i}`).join(' ');
    expect(extractPromptCandidates(many).length).toBe(50);
  });

  it('does not hardcode any stopword filter', () => {
    // make / new / what all survive this layer — the co-occurrence rule is
    // what neutralizes them against a real corpus
    expect(extractPromptCandidates('make a new button')).toEqual(['make', 'new', 'button']);
    expect(extractPromptCandidates('what does the thing do')).toContain('what');
    expect(extractPromptCandidates('what does the thing do')).toContain('the');
  });
});

describe('findCaveatsForPrompt (co-occurrence based)', () => {
  function seededDb(entries: Array<{ title: string; symptom: string }>) {
    const root = mkdtempSync(join(tmpdir(), 'caveat-hook-'));
    const db = openDb({ path: ':memory:' });
    for (const e of entries) {
      recordEntry(
        { title: e.title, symptom: e.symptom },
        { db, entriesRoot: join(root, 'entries') },
      );
    }
    return {
      db,
      cleanup: () => {
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it('returns [] when prompt has no usable tokens', () => {
    const { db, cleanup } = seededDb([{ title: 'RTX 5090 CUDA init', symptom: 'x' }]);
    try {
      expect(findCaveatsForPrompt(db, '').length).toBe(0);
      expect(findCaveatsForPrompt(db, 'a b c').length).toBe(0);
      expect(findCaveatsForPrompt(db, '.,:;+*-').length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('single-token prompt falls back to 1-of-1 match', () => {
    const { db, cleanup } = seededDb([
      { title: 'RTX 5090 CUDA init', symptom: 'driver crash' },
      { title: 'Unrelated thing', symptom: 'nothing here' },
    ]);
    try {
      const hits = findCaveatsForPrompt(db, 'cuda');
      expect(hits.length).toBe(1);
      expect(hits[0]!.title).toContain('CUDA');
    } finally {
      cleanup();
    }
  });

  it('multi-token prompt requires ≥ 2 distinct tokens to co-occur', () => {
    // Only entry #1 has both `cuda` and `5090`; the `common` entry only has
    // one match token. A 2-of-N rule should return just entry #1.
    const { db, cleanup } = seededDb([
      { title: 'RTX 5090 CUDA init failure', symptom: 'driver crash' },
      { title: 'common-thing', symptom: 'just mentions cuda once' },
    ]);
    try {
      const hits = findCaveatsForPrompt(db, 'RTX 5090 の CUDA が failure');
      expect(hits.length).toBe(1);
      expect(hits[0]!.title).toContain('5090');
    } finally {
      cleanup();
    }
  });

  it('suppresses single-token noise without any hardcoded list', () => {
    // 10 entries each mention `make` in prose, 5 entries each mention `new`,
    // but none mentions both. Prompt "make a new button" should therefore
    // produce 0 hits because no entry has 2 distinct token matches.
    const makeEntries = Array.from({ length: 10 }, (_, i) => ({
      title: `make-entry ${i}`,
      symptom: `need to make the alpha${i} thing work`,
    }));
    const newEntries = Array.from({ length: 5 }, (_, i) => ({
      title: `new-entry ${i}`,
      symptom: `beta${i} requires a new approach`,
    }));
    const { db, cleanup } = seededDb([...makeEntries, ...newEntries]);
    try {
      expect(findCaveatsForPrompt(db, 'make a new button please').length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('still hits when a single entry genuinely co-occurs with common words', () => {
    // One entry has "make" AND "new" together; others have only one or none.
    const { db, cleanup } = seededDb([
      { title: 'rare-co-occurrence', symptom: 'how to make a new pipeline' },
      { title: 'other-1', symptom: 'mentions only make' },
      { title: 'other-2', symptom: 'only new here' },
    ]);
    try {
      const hits = findCaveatsForPrompt(db, 'make a new item');
      expect(hits.length).toBe(1);
      expect(hits[0]!.title).toBe('rare-co-occurrence');
    } finally {
      cleanup();
    }
  });

  it('orders results by distinct-match count DESC', () => {
    const { db, cleanup } = seededDb([
      { title: 'triple-hit', symptom: 'cuda driver nvenc running together' },
      { title: 'double-hit', symptom: 'cuda driver only' },
    ]);
    try {
      const hits = findCaveatsForPrompt(db, 'CUDA driver nvenc check');
      expect(hits[0]!.title).toBe('triple-hit');
      expect(hits[1]!.title).toBe('double-hit');
    } finally {
      cleanup();
    }
  });

  it('matches CJK substrings via trigram windows', () => {
    const { db, cleanup } = seededDb([
      { title: 'CUDA 初期化失敗', symptom: 'ドライバ更新後に発生' },
    ]);
    try {
      // CJK trigram windows: 初期化, 期化失, 化失敗 — all co-occur in the entry
      const hits = findCaveatsForPrompt(db, 'なぜか初期化失敗する');
      expect(hits.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('does NOT throw on prompts with FTS5 operator chars', () => {
    const { db, cleanup } = seededDb([{ title: 'node:sqlite note', symptom: 'warning' }]);
    try {
      expect(() => findCaveatsForPrompt(db, 'node:sqlite + a*b throws?')).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('honors limit option', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      title: `cuda entry ${i}`,
      symptom: `driver crash ${i}`,
    }));
    const { db, cleanup } = seededDb(entries);
    try {
      // All 10 entries have both "cuda" and "driver" → 10 qualifying hits
      expect(findCaveatsForPrompt(db, 'cuda driver', { limit: 3 }).length).toBe(3);
    } finally {
      cleanup();
    }
  });
});

describe('userPromptSubmitReminderText', () => {
  it('includes hit count, id/source/title per row, and trailing guidance', () => {
    const text = userPromptSubmitReminderText([
      {
        id: 'rtx-5090-cuda',
        source: 'own',
        title: 'RTX 5090 CUDA init failure',
        symptomExcerpt: 'Driver crashes on first launch after cold boot',
        confidence: 'reproduced',
        visibility: 'public',
        environment: {},
      },
    ]);
    expect(text).toContain('[caveat]');
    expect(text).toContain('1 件');
    expect(text).toContain('rtx-5090-cuda');
    expect(text).toContain('own');
    expect(text).toContain('RTX 5090 CUDA init failure');
    expect(text).toContain('症状:');
    expect(text).toContain('mcp__caveat__caveat_get');
    expect(text).toContain('environment');
  });

  it('collapses whitespace and truncates long symptoms', () => {
    const longSymptom = 'a'.repeat(300);
    const text = userPromptSubmitReminderText([
      {
        id: 'x',
        source: 'own',
        title: 't',
        symptomExcerpt: longSymptom,
        confidence: 'reproduced',
        visibility: 'public',
        environment: {},
      },
    ]);
    const symptomLine = text.split('\n').find((l) => l.trim().startsWith('症状:'));
    expect(symptomLine).toBeDefined();
    expect(symptomLine!.length).toBeLessThan(200);
  });
});

describe('toolErrorReminderText', () => {
  it('frames the hits as responding to a tool error, not a prompt', () => {
    const text = toolErrorReminderText([
      {
        id: 'node-sqlite-experimental-warning',
        source: 'own',
        title: 'Node 22.5+ node:sqlite ExperimentalWarning',
        symptomExcerpt: 'import emits ExperimentalWarning once per process',
        confidence: 'reproduced',
        visibility: 'public',
        environment: {},
      },
    ]);
    expect(text).toContain('[caveat]');
    expect(text).toContain('直前のエラー');
    expect(text).toContain('1 件');
    expect(text).toContain('node-sqlite-experimental-warning');
    expect(text).toContain('症状:');
    expect(text).toContain('mcp__caveat__caveat_get');
  });
});

describe('stopReminderText', () => {
  const sig = {
    toolFailureCount: 5,
    fileEditCounts: [{ path: '/repo/foo.ts', count: 4 }],
    webSearchCount: 2,
    webFetchCount: 0,
    bashRetryCount: 1,
    durationMinutes: 40,
    errorSnippets: ['ERR_XYZ crash'],
    searchQueries: ['how to fix X'],
  };

  it('embeds concrete signal numbers and caveat_record guidance', () => {
    const text = stopReminderText(sig, []);
    expect(text).toContain('[caveat]');
    expect(text).toContain('tool failure: 5 件');
    expect(text).toContain('foo.ts × 4');
    expect(text).toContain('WebSearch: 2 回');
    expect(text).toContain('再実行: 1 種');
    expect(text).toContain('経過時間: 40 分');
    expect(text).toContain('caveat_record');
    expect(text).toContain('outcome: impossible');
  });

  it('lists related caveats and prefers caveat_update when any are found', () => {
    const text = stopReminderText(sig, [
      {
        id: 'express-trust-proxy-rate-limit',
        source: 'own',
        title: 'Express trust proxy × rate-limit mismatch',
        symptomExcerpt: 'ERR_ERL_PERMISSIVE_TRUST_PROXY',
        confidence: 'reproduced',
        visibility: 'public',
        environment: {},
      },
    ]);
    expect(text).toContain('既存罠 1 件');
    expect(text).toContain('express-trust-proxy-rate-limit');
    expect(text).toContain('caveat_update');
    expect(text).toContain('caveat_record');
  });

  it('omits signal lines with zero values', () => {
    const text = stopReminderText(
      {
        toolFailureCount: 0,
        fileEditCounts: [],
        webSearchCount: 3,
        webFetchCount: 0,
        bashRetryCount: 0,
        durationMinutes: 0,
        errorSnippets: [],
        searchQueries: ['hello'],
      },
      [],
    );
    expect(text).not.toContain('tool failure');
    expect(text).not.toContain('同一ファイル');
    expect(text).toContain('WebSearch: 3 回');
  });
});
