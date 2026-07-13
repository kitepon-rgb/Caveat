import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHookSignalSidecarContextBlock } from '@caveat/core';
import { readHookSignalAdditionalContextFile } from '../src/commands/codexSidecar.js';

describe('hook signal additional context file', () => {
  it('accepts only an owner-only canonical hook signal block', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-sidecar-context-test-'));
    const path = join(root, 'signal.json');
    try {
      const block = buildHookSignalSidecarContextBlock({
        type: 'tool-error', toolName: 'unknown-secret-tool', failureKind: 'post-tool-use-failure',
      });
      writeFileSync(path, JSON.stringify({ context: [block] }), { encoding: 'utf-8', mode: 0o600 });
      expect(readHookSignalAdditionalContextFile(path)).toEqual([block]);

      writeFileSync(path, JSON.stringify({ context: [{ ...block, summary: 'SECRET_ERROR /private/path' }] }), 'utf-8');
      chmodSync(path, 0o600);
      expect(() => readHookSignalAdditionalContextFile(path)).toThrow('invalid hook signal block');

      writeFileSync(path, JSON.stringify({ context: [{ ...block, data: { ...block.data, secret: 'SECRET_ERROR' } }] }), 'utf-8');
      chmodSync(path, 0o600);
      expect(() => readHookSignalAdditionalContextFile(path)).toThrow('invalid hook signal block');

      if (process.platform !== 'win32') {
        chmodSync(path, 0o644);
        expect(() => readHookSignalAdditionalContextFile(path)).toThrow('owner-only');
        chmodSync(path, 0o600);
      }
      const link = join(root, 'signal-link.json');
      symlinkSync(path, link);
      expect(() => readHookSignalAdditionalContextFile(link)).toThrow('owner-only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds reads and binds validation to the opened inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-sidecar-context-race-'));
    const path = join(root, 'signal.json');
    const replacement = join(root, 'replacement.json');
    try {
      const block = buildHookSignalSidecarContextBlock({
        type: 'tool-error', toolName: 'Bash', failureKind: 'post-tool-use-failure',
      });
      const bytes = JSON.stringify({ context: [block] });
      writeFileSync(path, bytes, { encoding: 'utf-8', mode: 0o600 });
      writeFileSync(replacement, bytes, { encoding: 'utf-8', mode: 0o600 });
      expect(() => readHookSignalAdditionalContextFile(path, {
        afterLstat: () => {
          unlinkSync(path);
          renameSync(replacement, path);
        },
      })).toThrow('changed during open');

      writeFileSync(path, 'x'.repeat(4097), { encoding: 'utf-8', mode: 0o600 });
      expect(() => readHookSignalAdditionalContextFile(path)).toThrow('within 4096 bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses a reserved per-user temp container for the Windows ACL boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-sidecar-context-windows-'));
    const path = join(root, 'signal.json');
    const outsideDir = join(root, 'nested');
    const outside = join(outsideDir, 'signal.json');
    try {
      const block = buildHookSignalSidecarContextBlock({
        type: 'tool-error', toolName: 'Bash', failureKind: 'post-tool-use-failure',
      });
      writeFileSync(path, JSON.stringify({ context: [block] }), { encoding: 'utf-8', mode: 0o644 });
      expect(readHookSignalAdditionalContextFile(path, { platform: 'win32' })).toEqual([block]);

      mkdirSync(outsideDir);
      writeFileSync(outside, JSON.stringify({ context: [block] }), { encoding: 'utf-8', mode: 0o600 });
      expect(() => readHookSignalAdditionalContextFile(outside, { platform: 'win32' }))
        .toThrow('reserved per-user Caveat temporary directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a FIFO replacement without blocking', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-sidecar-context-fifo-'));
    const path = join(root, 'signal.json');
    try {
      const block = buildHookSignalSidecarContextBlock({
        type: 'tool-error', toolName: 'Bash', failureKind: 'post-tool-use-failure',
      });
      writeFileSync(path, JSON.stringify({ context: [block] }), { encoding: 'utf-8', mode: 0o600 });
      expect(() => readHookSignalAdditionalContextFile(path, {
        afterLstat: () => {
          unlinkSync(path);
          execFileSync('mkfifo', [path]);
          chmodSync(path, 0o600);
        },
      })).toThrow('regular file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
