import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexSessionSignals } from '../src/codexTranscriptSignals.js';

type JsonLine = Record<string, unknown>;

function writeTranscript(lines: JsonLine[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'caveat-codex-tr-'));
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return path;
}

function functionCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  timestamp = '2026-05-05T14:36:28.897Z',
): JsonLine {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  };
}

function functionOutput(callId: string, output: string): JsonLine {
  return {
    timestamp: '2026-05-05T14:36:29.058Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output,
    },
  };
}

describe('readCodexSessionSignals', () => {
  it('returns null when file does not exist', () => {
    expect(readCodexSessionSignals('/nonexistent/path.jsonl')).toBeNull();
  });

  it('counts Codex command failures from function_call_output exit codes', () => {
    const path = writeTranscript([
      functionCall('call_1', 'exec_command', { cmd: 'pnpm test', workdir: '/repo' }),
      functionOutput(
        'call_1',
        'Chunk ID: fd566f\nWall time: 0.0000 seconds\nProcess exited with code 127\nOutput:\ncommand not found\n',
      ),
      functionCall('call_2', 'exec_command', { cmd: 'pwd' }),
      functionOutput('call_2', 'Process exited with code 0\nOutput:\n/repo\n'),
    ]);
    try {
      const s = readCodexSessionSignals(path)!;
      expect(s.toolFailureCount).toBe(1);
      expect(s.errorSnippets[0]).toContain('command not found');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('counts retried Codex shell commands', () => {
    const path = writeTranscript([
      functionCall('call_1', 'exec_command', { cmd: 'corepack pnpm test' }),
      functionCall('call_2', 'exec_command', { cmd: 'corepack pnpm test' }),
      functionCall('call_3', 'exec_command', { cmd: 'corepack pnpm typecheck' }),
    ]);
    try {
      const s = readCodexSessionSignals(path)!;
      expect(s.bashRetryCount).toBe(1);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('reports files patched more than once', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: apps/cli/src/index.ts',
      '@@',
      '-old',
      '+new',
      '*** Update File: apps/cli/src/index.ts',
      '@@',
      '-old2',
      '+new2',
      '*** Add File: apps/cli/src/codexHookInstall.ts',
      '+export {};',
      '*** End Patch',
    ].join('\n');
    const path = writeTranscript([functionCall('call_1', 'apply_patch', { patch })]);
    try {
      const s = readCodexSessionSignals(path)!;
      expect(s.fileEditCounts).toEqual([{ path: 'apps/cli/src/index.ts', count: 2 }]);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('captures web search queries and open calls from web.run arguments', () => {
    const path = writeTranscript([
      functionCall('call_1', 'web.run', {
        search_query: [{ q: 'codex hooks UserPromptSubmit' }, { q: 'codex PostToolUse' }],
        open: [{ ref_id: 'turn0search0' }],
      }),
    ]);
    try {
      const s = readCodexSessionSignals(path)!;
      expect(s.webSearchCount).toBe(2);
      expect(s.webFetchCount).toBe(1);
      expect(s.searchQueries).toContain('codex hooks UserPromptSubmit');
      expect(s.searchQueries).toContain('codex PostToolUse');
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('computes duration from first and last timestamps', () => {
    const path = writeTranscript([
      { timestamp: '2026-05-05T14:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: '2026-05-05T14:42:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ]);
    try {
      const s = readCodexSessionSignals(path)!;
      expect(s.durationMinutes).toBe(42);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });
});
