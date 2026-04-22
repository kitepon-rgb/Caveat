import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasAnyStruggleSignal,
  readSessionSignals,
  struggleSearchText,
  type SessionSignals,
} from '../src/transcriptSignals.js';

interface Line {
  type: string;
  timestamp?: string;
  message?: { content?: unknown[] };
}

function writeTranscript(lines: Line[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'caveat-tr-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return path;
}

function toolUse(name: string, input: Record<string, unknown>): Line {
  return {
    type: 'assistant',
    timestamp: '2026-04-22T10:00:00.000Z',
    message: { content: [{ type: 'tool_use', name, input, id: 'x' }] },
  };
}

function toolResult(isError: boolean, content: unknown): Line {
  return {
    type: 'user',
    timestamp: '2026-04-22T10:00:01.000Z',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'x', is_error: isError, content },
      ],
    },
  };
}

describe('readSessionSignals', () => {
  it('returns null when file does not exist', () => {
    expect(readSessionSignals('/nonexistent/path.jsonl')).toBeNull();
  });

  it('returns zeroed signals on empty file', () => {
    const path = writeTranscript([]);
    const s = readSessionSignals(path)!;
    expect(s.toolFailureCount).toBe(0);
    expect(s.fileEditCounts).toEqual([]);
    expect(s.webSearchCount).toBe(0);
    expect(s.webFetchCount).toBe(0);
    expect(s.bashRetryCount).toBe(0);
    expect(s.errorSnippets).toEqual([]);
    expect(s.searchQueries).toEqual([]);
  });

  it('counts tool failures and captures error snippets', () => {
    const path = writeTranscript([
      toolUse('Bash', { command: 'cargo build' }),
      toolResult(true, 'error[E0382]: borrow of moved value'),
      toolUse('Bash', { command: 'cargo check' }),
      toolResult(true, [{ type: 'text', text: 'another failure' }]),
      toolUse('Bash', { command: 'cargo test' }),
      toolResult(false, 'ok'),
    ]);
    const s = readSessionSignals(path)!;
    expect(s.toolFailureCount).toBe(2);
    expect(s.errorSnippets).toHaveLength(2);
    expect(s.errorSnippets[0]).toContain('borrow of moved value');
    expect(s.errorSnippets[1]).toContain('another failure');
  });

  it('reports files edited more than once, drops single-edit files', () => {
    const path = writeTranscript([
      toolUse('Edit', { file_path: '/repo/a.ts' }),
      toolUse('Edit', { file_path: '/repo/a.ts' }),
      toolUse('Edit', { file_path: '/repo/a.ts' }),
      toolUse('Edit', { file_path: '/repo/b.ts' }),
      toolUse('Write', { file_path: '/repo/c.ts' }),
      toolUse('Write', { file_path: '/repo/c.ts' }),
    ]);
    const s = readSessionSignals(path)!;
    expect(s.fileEditCounts).toEqual([
      { path: '/repo/a.ts', count: 3 },
      { path: '/repo/c.ts', count: 2 },
    ]);
  });

  it('captures WebSearch count and queries', () => {
    const path = writeTranscript([
      toolUse('WebSearch', { query: 'express-rate-limit trust proxy error' }),
      toolUse('WebSearch', { query: 'cuda 12.4 rtx 5090 init' }),
    ]);
    const s = readSessionSignals(path)!;
    expect(s.webSearchCount).toBe(2);
    expect(s.searchQueries).toContain('express-rate-limit trust proxy error');
    expect(s.searchQueries).toContain('cuda 12.4 rtx 5090 init');
  });

  it('counts distinct Bash commands that were retried', () => {
    const path = writeTranscript([
      toolUse('Bash', { command: 'pnpm install' }),
      toolUse('Bash', { command: 'pnpm install' }),
      toolUse('Bash', { command: 'ls' }),
      toolUse('Bash', { command: 'rm x' }),
      toolUse('Bash', { command: 'rm x' }),
      toolUse('Bash', { command: 'rm x' }),
    ]);
    const s = readSessionSignals(path)!;
    expect(s.bashRetryCount).toBe(2);
  });

  it('computes duration from first and last timestamps', () => {
    const path = writeTranscript([
      { type: 'assistant', timestamp: '2026-04-22T10:00:00.000Z', message: { content: [] } },
      { type: 'assistant', timestamp: '2026-04-22T10:35:00.000Z', message: { content: [] } },
    ]);
    const s = readSessionSignals(path)!;
    expect(s.durationMinutes).toBe(35);
  });

  it('ignores queue-operation / ai-title / other non-message lines', () => {
    const path = writeTranscript([
      { type: 'queue-operation', message: undefined },
      { type: 'ai-title' },
      toolUse('Bash', { command: 'ls' }),
      toolResult(true, 'boom'),
    ]);
    const s = readSessionSignals(path)!;
    expect(s.toolFailureCount).toBe(1);
  });

  it('survives malformed JSON lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caveat-tr-'));
    const path = join(dir, 'session.jsonl');
    writeFileSync(
      path,
      [
        'not json',
        JSON.stringify(toolUse('Bash', { command: 'ls' })),
        '{"broken',
        JSON.stringify(toolResult(true, 'err')),
      ].join('\n'),
      'utf-8',
    );
    try {
      const s = readSessionSignals(path)!;
      expect(s.toolFailureCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hasAnyStruggleSignal', () => {
  const empty: SessionSignals = {
    toolFailureCount: 0,
    fileEditCounts: [],
    webSearchCount: 0,
    webFetchCount: 0,
    bashRetryCount: 0,
    durationMinutes: 0,
    errorSnippets: [],
    searchQueries: [],
  };

  it('is false on zeroed signals', () => {
    expect(hasAnyStruggleSignal(empty)).toBe(false);
  });

  it('fires on any single nonzero signal', () => {
    expect(hasAnyStruggleSignal({ ...empty, toolFailureCount: 1 })).toBe(true);
    expect(
      hasAnyStruggleSignal({ ...empty, fileEditCounts: [{ path: 'a', count: 2 }] }),
    ).toBe(true);
    expect(hasAnyStruggleSignal({ ...empty, webSearchCount: 1 })).toBe(true);
    expect(hasAnyStruggleSignal({ ...empty, webFetchCount: 1 })).toBe(true);
    expect(hasAnyStruggleSignal({ ...empty, bashRetryCount: 1 })).toBe(true);
  });

  it('ignores durationMinutes alone (not a struggle indicator)', () => {
    expect(hasAnyStruggleSignal({ ...empty, durationMinutes: 60 })).toBe(false);
  });
});

describe('struggleSearchText', () => {
  it('joins error snippets and search queries', () => {
    const text = struggleSearchText({
      toolFailureCount: 2,
      fileEditCounts: [],
      webSearchCount: 1,
      webFetchCount: 0,
      bashRetryCount: 0,
      durationMinutes: 0,
      errorSnippets: ['ERR_ERL_PERMISSIVE_TRUST_PROXY'],
      searchQueries: ['express trust proxy'],
    });
    expect(text).toContain('ERR_ERL_PERMISSIVE_TRUST_PROXY');
    expect(text).toContain('express trust proxy');
  });

  it('returns empty string when nothing to search on', () => {
    expect(
      struggleSearchText({
        toolFailureCount: 0,
        fileEditCounts: [],
        webSearchCount: 0,
        webFetchCount: 0,
        bashRetryCount: 0,
        durationMinutes: 0,
        errorSnippets: [],
        searchQueries: [],
      }),
    ).toBe('');
  });
});
