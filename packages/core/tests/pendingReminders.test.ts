import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPendingReminder,
  cleanupStalePendingDirs,
  drainPendingReminders,
  maybeSweepPendingDirs,
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

describe('cleanupStalePendingDirs', () => {
  function ageDir(path: string, daysAgo: number): void {
    const t = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, t, t);
  }

  it('returns no-op when pending root does not exist', () => {
    const { home, cleanup } = freshHome();
    try {
      const result = cleanupStalePendingDirs(home);
      expect(result).toEqual({ removed: [], kept: 0 });
    } finally {
      cleanup();
    }
  });

  it('removes empty session dirs that are older than the threshold', () => {
    const { home, cleanup } = freshHome();
    try {
      const oldDir = pendingDirFor(home, 'old-empty');
      const recentDir = pendingDirFor(home, 'recent-empty');
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(recentDir, { recursive: true });
      ageDir(oldDir, 30);
      // recentDir keeps "now" mtime
      const result = cleanupStalePendingDirs(home, { staleDays: 7 });
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]).toBe(oldDir);
      expect(result.kept).toBe(1);
      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(recentDir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('removes session dirs with stranded files when ALL contents are stale', () => {
    const { home, cleanup } = freshHome();
    try {
      const stranded = pendingDirFor(home, 'stranded');
      mkdirSync(stranded, { recursive: true });
      const file = join(stranded, '1700000000-aaaa.txt');
      writeFileSync(file, 'leftover', 'utf-8');
      ageDir(file, 30);
      ageDir(stranded, 30);
      const result = cleanupStalePendingDirs(home, { staleDays: 7 });
      expect(result.removed).toEqual([stranded]);
      expect(existsSync(stranded)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('keeps a session dir whose newest file is fresher than the threshold', () => {
    const { home, cleanup } = freshHome();
    try {
      const dir = pendingDirFor(home, 'half-active');
      mkdirSync(dir, { recursive: true });
      const oldFile = join(dir, 'old.txt');
      const freshFile = join(dir, 'fresh.txt');
      writeFileSync(oldFile, 'x', 'utf-8');
      writeFileSync(freshFile, 'y', 'utf-8');
      ageDir(oldFile, 30);
      ageDir(dir, 30);
      // freshFile keeps "now" mtime
      const result = cleanupStalePendingDirs(home, { staleDays: 7 });
      expect(result.removed).toEqual([]);
      expect(result.kept).toBe(1);
      expect(existsSync(dir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('rejects negative staleDays', () => {
    const { home, cleanup } = freshHome();
    try {
      expect(() => cleanupStalePendingDirs(home, { staleDays: -1 })).toThrow();
    } finally {
      cleanup();
    }
  });

  it('staleDays=0 collects every dir whose mtime is strictly in the past', async () => {
    const { home, cleanup } = freshHome();
    try {
      const dir = pendingDirFor(home, 'just-now');
      mkdirSync(dir, { recursive: true });
      // age by 1 second so mtime is strictly < now
      ageDir(dir, 1 / 86400);
      const result = cleanupStalePendingDirs(home, { staleDays: 0 });
      expect(result.removed).toEqual([dir]);
    } finally {
      cleanup();
    }
  });
});

describe('maybeSweepPendingDirs', () => {
  function ageDir(path: string, daysAgo: number): void {
    const t = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, t, t);
  }

  function withoutSweepEnv<T>(fn: () => T): T {
    const prev = process.env.CAVEAT_PENDING_SWEEP;
    delete process.env.CAVEAT_PENDING_SWEEP;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CAVEAT_PENDING_SWEEP;
      else process.env.CAVEAT_PENDING_SWEEP = prev;
    }
  }

  it('returns env_off without filesystem effects when CAVEAT_PENDING_SWEEP=off', () => {
    const { home, cleanup } = freshHome();
    const prev = process.env.CAVEAT_PENDING_SWEEP;
    process.env.CAVEAT_PENDING_SWEEP = 'off';
    try {
      const stale = pendingDirFor(home, 'should-survive');
      mkdirSync(stale, { recursive: true });
      ageDir(stale, 30);
      const result = maybeSweepPendingDirs(home);
      expect(result).toEqual({ skipped: 'env_off' });
      expect(existsSync(stale)).toBe(true);
      // Marker must NOT have been written either (would let a later
      // env=on call skip via debounce, which is wrong).
      expect(existsSync(join(home, 'pending', '.last-sweep'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CAVEAT_PENDING_SWEEP;
      else process.env.CAVEAT_PENDING_SWEEP = prev;
      cleanup();
    }
  });

  it('returns no_pending_dir when the pending root does not exist', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        expect(maybeSweepPendingDirs(home)).toEqual({ skipped: 'no_pending_dir' });
      });
    } finally {
      cleanup();
    }
  });

  it('first call sweeps and creates the marker', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        const stale = pendingDirFor(home, 'old');
        mkdirSync(stale, { recursive: true });
        ageDir(stale, 30);
        const result = maybeSweepPendingDirs(home, { staleDays: 7 });
        expect(result.swept?.removed).toHaveLength(1);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(join(home, 'pending', '.last-sweep'))).toBe(true);
      });
    } finally {
      cleanup();
    }
  });

  it('subsequent call within debounce window is skipped', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        // Put a fresh marker in place.
        mkdirSync(join(home, 'pending'), { recursive: true });
        writeFileSync(join(home, 'pending', '.last-sweep'), '', 'utf-8');
        // And a stale dir that WOULD be removed if we swept.
        const stale = pendingDirFor(home, 'old');
        mkdirSync(stale, { recursive: true });
        ageDir(stale, 30);
        const result = maybeSweepPendingDirs(home, { debounceDays: 1 });
        expect(result).toEqual({ skipped: 'debounced' });
        expect(existsSync(stale)).toBe(true);
      });
    } finally {
      cleanup();
    }
  });

  it('subsequent call after debounce window sweeps again', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        const markerDir = join(home, 'pending');
        mkdirSync(markerDir, { recursive: true });
        const marker = join(markerDir, '.last-sweep');
        writeFileSync(marker, '', 'utf-8');
        // Age the marker beyond the debounce window.
        const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
        utimesSync(marker, tenDaysAgo, tenDaysAgo);
        // Stale dir that should be collected.
        const stale = pendingDirFor(home, 'old');
        mkdirSync(stale, { recursive: true });
        ageDir(stale, 30);
        const result = maybeSweepPendingDirs(home, { debounceDays: 1, staleDays: 7 });
        expect(result.swept?.removed).toEqual([stale]);
      });
    } finally {
      cleanup();
    }
  });

  it('rejects negative debounceDays', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        mkdirSync(join(home, 'pending'), { recursive: true });
        expect(() => maybeSweepPendingDirs(home, { debounceDays: -1 })).toThrow();
      });
    } finally {
      cleanup();
    }
  });
});
