import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPendingReminder, drainPendingReminders } from '@caveat/core';

function runHook(
  name: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'hook',
      name,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env,
    },
  );
}

describe('Claude hook output', () => {
  it('drains multiple pending reminders as one system-reminder block', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-claude-hook-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    try {
      mkdirSync(caveatHome, { recursive: true });
      mkdirSync(userHome, { recursive: true });
      appendPendingReminder(caveatHome, 'sess-1', 'first reminder');
      appendPendingReminder(caveatHome, 'sess-1', 'second reminder');

      const result = runHook(
        'user-prompt-submit',
        {
          session_id: 'sess-1',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'continue',
        },
        {
          ...process.env,
          CAVEAT_HOME: caveatHome,
          HOME: userHome,
        },
      );

      expect(result.status).toBe(0);
      const reminderBlocks = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('<system-reminder>'));
      expect(reminderBlocks).toHaveLength(1);
      expect(result.stdout).toContain('first reminder');
      expect(result.stdout).toContain('second reminder');
      expect(result.stdout).toContain('\n\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('queues stop reminders without writing stdout immediately', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-claude-stop-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    const transcript = join(root, 'session.jsonl');
    try {
      mkdirSync(caveatHome, { recursive: true });
      mkdirSync(userHome, { recursive: true });
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            timestamp: '2026-05-05T14:36:29.058Z',
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_result',
                  is_error: true,
                  content: 'failed',
                },
              ],
            },
          }),
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = runHook(
        'stop',
        {
          session_id: 'sess-1',
          transcript_path: transcript,
          hook_event_name: 'Stop',
          stop_hook_active: false,
        },
        {
          ...process.env,
          CAVEAT_HOME: caveatHome,
          HOME: userHome,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      const reminders = drainPendingReminders(caveatHome, 'sess-1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain('[caveat]');
      expect(reminders[0]).toContain('tool failure: 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not requeue unchanged stop reminders for the same session', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-claude-stop-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    const transcript = join(root, 'session.jsonl');
    try {
      mkdirSync(caveatHome, { recursive: true });
      mkdirSync(userHome, { recursive: true });
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            timestamp: '2026-05-05T14:36:29.058Z',
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_result',
                  is_error: true,
                  content: 'failed',
                },
              ],
            },
          }),
          '',
        ].join('\n'),
        'utf-8',
      );

      const env = {
        ...process.env,
        CAVEAT_HOME: caveatHome,
        HOME: userHome,
      };
      const input = {
        session_id: 'sess-1',
        transcript_path: transcript,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      };
      const first = runHook('stop', input, env);
      const second = runHook('stop', input, env);

      expect(first.status).toBe(0);
      expect(first.stdout).toBe('');
      expect(second.status).toBe(0);
      expect(second.stdout).toBe('');
      const reminders = drainPendingReminders(caveatHome, 'sess-1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain('tool failure: 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps sidecar unavailable diagnostics compact in stop reminders', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-claude-sidecar-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    const transcript = join(root, 'session.jsonl');
    try {
      mkdirSync(caveatHome, { recursive: true });
      mkdirSync(userHome, { recursive: true });
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            timestamp: '2026-05-05T14:36:29.058Z',
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_result',
                  is_error: true,
                  content: 'failed',
                },
              ],
            },
          }),
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = runHook(
        'stop',
        {
          session_id: 'sess-1',
          transcript_path: transcript,
          hook_event_name: 'Stop',
          stop_hook_active: false,
        },
        {
          ...process.env,
          CAVEAT_HOME: caveatHome,
          CAVEAT_CODEX_SIDECAR_COMMAND: process.execPath,
          CAVEAT_HOOK_CODEX_SIDECAR: 'require',
          HOME: userHome,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      const reminders = drainPendingReminders(caveatHome, 'sess-1');
      expect(reminders).toHaveLength(1);
      const unavailable = reminders[0]
        ?.split('\n')
        .find((line) => line.startsWith('[caveat:codex-sidecar] advisory unavailable:'));
      expect(unavailable).toContain('advisory unavailable:');
      expect(unavailable?.length).toBeLessThan(320);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
