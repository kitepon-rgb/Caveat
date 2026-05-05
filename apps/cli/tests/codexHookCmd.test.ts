import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexPostToolUseWorkerJob,
  codexContextOutput,
  codexStopOutput,
  isCodexToolError,
} from '../src/commands/codexHookCmd.js';

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/codex-hooks/${name}.json`, import.meta.url), 'utf-8'),
  ) as Record<string, unknown>;
}

describe('Codex hook output formatting', () => {
  it('formats user prompt context as hookSpecificOutput.additionalContext', () => {
    expect(JSON.parse(codexContextOutput('hello'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
  });

  it('formats stop reminder as a block decision', () => {
    expect(JSON.parse(codexStopOutput('record this'))).toEqual({
      decision: 'block',
      reason: 'record this',
    });
  });
});

describe('isCodexToolError', () => {
  it('keeps captured successful hook payloads non-error without transcript evidence', () => {
    const payload = readFixture('user-prompt-submit');
    expect(payload.hook_event_name).toBe('UserPromptSubmit');
    expect(isCodexToolError(payload)).toBe(false);
  });

  it('recognizes the captured PostToolUse failure shape needs transcript evidence', () => {
    const payload = readFixture('post-tool-use-bash-failure');
    expect(payload.hook_event_name).toBe('PostToolUse');
    expect(payload.tool_response).toContain('command not found');
    expect(isCodexToolError(payload)).toBe(false);
  });

  it('defers captured Codex Bash payloads for transcript-backed classification', () => {
    const payload = readFixture('post-tool-use-bash-failure');
    const job = buildCodexPostToolUseWorkerJob(payload);
    expect(job).toMatchObject({
      sessionId: '019df891-9566-7223-8e9d-3d093a63b166',
      knownError: false,
      allowSymptomOnly: true,
      transcriptPath: '/tmp/caveat-codex-capture/sessions/rollout.jsonl',
      toolUseId: 'call_dASy1j0HCKmwNgfdBT7Zkh2K',
    });
    expect(job?.searchText).toContain('__caveat_missing_command_12345');
    expect(job?.searchText).toContain('command not found');
  });

  it('detects explicit exit_code fields', () => {
    expect(isCodexToolError({ exit_code: 1 })).toBe(true);
    expect(isCodexToolError({ exit_code: 0 })).toBe(false);
    expect(isCodexToolError({ tool_response: { exitCode: 2 } })).toBe(true);
  });

  it('detects process exit markers when Codex includes them in tool_response text', () => {
    expect(
      isCodexToolError({
        tool_response: 'Chunk ID: 7062ff\nProcess exited with code 9\nOutput:\nfailed\n',
      }),
    ).toBe(true);
    expect(isCodexToolError({ tool_response: 'Process exited with code 0\n' })).toBe(false);
  });

  it('detects Codex Bash failure from transcript output', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-transcript-'));
    const transcript = join(root, 'session.jsonl');
    try {
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            timestamp: '2026-05-05T14:36:29.058Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_123',
              output:
                'Chunk ID: fd566f\nProcess exited with code 127\nOutput:\ncommand not found\n',
            },
          }),
          '',
        ].join('\n'),
        'utf-8',
      );
      expect(
        isCodexToolError({
          transcript_path: transcript,
          tool_use_id: 'call_123',
          tool_name: 'Bash',
          tool_response: 'command not found\n',
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
