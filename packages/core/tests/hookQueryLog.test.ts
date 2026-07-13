import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAVEAT_HOOK_QUERY_LOG_ENV,
  HOOK_QUERY_LOG_MAX_BYTES,
  logHookQueryMiss,
  type HookQueryLogDependencies,
} from '../src/hookQueryLog.js';

function withQueryLogEnv(value: string | undefined, run: () => void): void {
  const previous = process.env[CAVEAT_HOOK_QUERY_LOG_ENV];
  if (value === undefined) delete process.env[CAVEAT_HOOK_QUERY_LOG_ENV];
  else process.env[CAVEAT_HOOK_QUERY_LOG_ENV] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[CAVEAT_HOOK_QUERY_LOG_ENV];
    else process.env[CAVEAT_HOOK_QUERY_LOG_ENV] = previous;
  }
}

function miss(caveatHome: string, query = 'unmatched query') {
  return { caveatHome, agent: 'claude' as const, surface: 'user_prompt' as const, query };
}

describe('logHookQueryMiss', () => {
  it('does nothing unless the environment value is exactly on', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-query-log-'));
    try {
      for (const value of [undefined, 'ON', 'true', 'on ']) {
        withQueryLogEnv(value, () => logHookQueryMiss(miss(root)));
        expect(() => statSync(join(root, 'metrics', 'hook-search-misses.jsonl'))).toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes only the minimized JSONL record with bounded query and private modes', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-query-log-'));
    try {
      withQueryLogEnv('on', () => {
        logHookQueryMiss({
          ...miss(root, 'x'.repeat(1002)),
          agent: 'codex',
          surface: 'tool_error',
        });
      });
      const metrics = join(root, 'metrics');
      const path = join(metrics, 'hook-search-misses.jsonl');
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual(['agent', 'at', 'query', 'surface']);
      expect(record).toMatchObject({ agent: 'codex', surface: 'tool_error' });
      expect((record.query as string)).toHaveLength(1000);
      if (process.platform !== 'win32') {
        expect(statSync(metrics).mode & 0o777).toBe(0o700);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the exact agent and surface metadata for every hook search surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-query-log-'));
    try {
      const expected = (['claude', 'codex'] as const).flatMap((agent) =>
        (['user_prompt', 'tool_error', 'stop'] as const).map((surface) => ({ agent, surface })),
      );
      withQueryLogEnv('on', () => {
        for (const item of expected) {
          logHookQueryMiss({ caveatHome: root, ...item, query: `${item.agent}-${item.surface}` });
        }
      });
      const path = join(root, 'metrics', 'hook-search-misses.jsonl');
      const actual = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const record = JSON.parse(line) as { agent: string; surface: string };
          return { agent: record.agent, surface: record.surface };
        });
      expect(actual).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rotates one generation before appending a record beyond 1 MiB', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-query-log-'));
    try {
      const metrics = join(root, 'metrics');
      const path = join(metrics, 'hook-search-misses.jsonl');
      // A pre-existing file may have been written by an older process; the writer
      // still applies its permission and bounded one-generation rotation contract.
      withQueryLogEnv('on', () => logHookQueryMiss(miss(root)));
      writeFileSync(path, 'a'.repeat(HOOK_QUERY_LOG_MAX_BYTES), 'utf8');
      withQueryLogEnv('on', () => logHookQueryMiss(miss(root, 'after rotation')));
      expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(HOOK_QUERY_LOG_MAX_BYTES);
      expect(readFileSync(path, 'utf8')).toContain('after rotation');
      if (process.platform !== 'win32') {
        expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const itWithPosixModes = process.platform === 'win32' ? it.skip : it;

  itWithPosixModes('does not append when pre-chmod of an existing small active file fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-query-log-'));
    const metrics = join(root, 'metrics');
    const activePath = join(metrics, 'hook-search-misses.jsonl');
    let appendCalled = false;
    const dependencies: HookQueryLogDependencies = {
      appendFileSync: () => { appendCalled = true; },
      chmodSync: (path) => {
        if (String(path) === activePath) {
          throw Object.assign(new Error('chmod denied'), { code: 'EACCES' });
        }
      },
      mkdirSync: () => undefined,
      renameSync: () => undefined,
      statSync: (path) => {
        if (String(path) === activePath) return { size: 4 } as ReturnType<typeof statSync>;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      unlinkSync: () => undefined,
    };
    try {
      // Characterize the security-sensitive starting state explicitly: a
      // pre-existing, below-rotation-limit active file with permissive mode.
      mkdirSync(metrics, { recursive: true });
      writeFileSync(activePath, 'old\n', { encoding: 'utf8', flag: 'w' });
      chmodSync(activePath, 0o644);
      expect(statSync(activePath).mode & 0o777).toBe(0o644);

      withQueryLogEnv('on', () => {
        expect(() => logHookQueryMiss(miss(root, 'must not append'), dependencies)).toThrow(
          'chmod denied',
        );
      });
      expect(appendCalled).toBe(false);
      expect(readFileSync(activePath, 'utf8')).toBe('old\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates writer failures for the hook adapter to report', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-query-log-'));
    const failing: HookQueryLogDependencies = {
      appendFileSync: () => { throw new Error('disk full'); },
      chmodSync: () => {},
      mkdirSync: () => undefined,
      renameSync: () => undefined,
      statSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      unlinkSync: () => undefined,
    };
    try {
      withQueryLogEnv('on', () => {
        expect(() => logHookQueryMiss(miss(root), failing)).toThrow('disk full');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
