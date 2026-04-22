import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPendingReminder,
  drainPendingReminders,
  pendingDirFor,
} from '../src/pendingReminders.js';

function freshHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-pending-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('pendingReminders', () => {
  it('drains nothing when no pending dir exists', () => {
    const { home, cleanup } = freshHome();
    try {
      expect(drainPendingReminders(home, 's1')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('append then drain returns the reminder once; second drain is empty', () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 's1', 'hello-world');
      expect(drainPendingReminders(home, 's1')).toEqual(['hello-world']);
      expect(drainPendingReminders(home, 's1')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('preserves timestamp-ordered delivery of multiple reminders', async () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 's1', 'first');
      // tiny delay so the filename ordering is deterministic
      await new Promise((r) => setTimeout(r, 5));
      appendPendingReminder(home, 's1', 'second');
      const drained = drainPendingReminders(home, 's1');
      expect(drained).toEqual(['first', 'second']);
    } finally {
      cleanup();
    }
  });

  it('isolates reminders between sessions', () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 'sess-a', 'for-a');
      appendPendingReminder(home, 'sess-b', 'for-b');
      expect(drainPendingReminders(home, 'sess-a')).toEqual(['for-a']);
      expect(drainPendingReminders(home, 'sess-b')).toEqual(['for-b']);
    } finally {
      cleanup();
    }
  });

  it('sanitizes session id so traversal characters cannot escape pending dir', () => {
    const { home, cleanup } = freshHome();
    try {
      const dirty = '../../etc/passwd';
      appendPendingReminder(home, dirty, 'x');
      const expectedDir = pendingDirFor(home, dirty);
      // Should live under a sanitized leaf under pending/, not in parent dirs
      expect(expectedDir.startsWith(join(home, 'pending'))).toBe(true);
      const files = readdirSync(expectedDir);
      expect(files.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('drain removes files after reading', () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 's1', 'a');
      appendPendingReminder(home, 's1', 'b');
      drainPendingReminders(home, 's1');
      const dir = pendingDirFor(home, 's1');
      expect(readdirSync(dir).filter((f) => f.endsWith('.txt'))).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
