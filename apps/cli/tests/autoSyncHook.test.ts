import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 3_000;
const GIT_E2E_TEST_TIMEOUT_MS = 30_000;

function entry(id: string, title: string, symptom: string): string {
  return `---
id: ${id}
title: ${title}
visibility: public
confidence: confirmed
tags: [autosync, community]
environment: {}
source_project: null
source_session: test
created_at: 2026-07-12
updated_at: 2026-07-12
---

## Symptom
${symptom}
`;
}

function cli(args: string[], home: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), ...args],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      input: JSON.stringify({ session_id: 'auto-sync', prompt: 'nebula prism sync failure' }),
      encoding: 'utf-8',
      env: {
        ...env,
        CAVEAT_HOME: home,
        HOME: join(home, 'user'),
        GIT_AUTHOR_NAME: 'Caveat Test',
        GIT_AUTHOR_EMAIL: 'caveat@example.com',
        GIT_COMMITTER_NAME: 'Caveat Test',
        GIT_COMMITTER_EMAIL: 'caveat@example.com',
      },
    },
  );
}

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Caveat Test',
      GIT_AUTHOR_EMAIL: 'caveat@example.com',
      GIT_COMMITTER_NAME: 'Caveat Test',
      GIT_COMMITTER_EMAIL: 'caveat@example.com',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function fresh(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-auto-sync-hook-'));
  mkdirSync(join(home, 'own', 'entries'), { recursive: true });
  mkdirSync(join(home, 'community'), { recursive: true });
  mkdirSync(join(home, 'user'), { recursive: true });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function setupCommunityClone(home: string): { source: string; clone: string } {
  const bare = join(home, 'remote.git');
  const source = join(home, 'source');
  const clone = join(home, 'community', 'team');
  git(['init', '--bare', bare], home);
  mkdirSync(join(source, 'entries'), { recursive: true });
  git(['init', '-b', 'main'], source);
  git(['remote', 'add', 'origin', bare], source);
  writeFileSync(
    join(source, 'entries', 'first.md'),
    entry('first', 'Quasar junction boot failure', 'Quasar junction boot failure reports a rare anchor mismatch.'),
  );
  git(['add', '-A'], source);
  git(['commit', '-m', 'initial community entry'], source);
  git(['push', '-u', 'origin', 'main'], source);
  git(['clone', bare, clone], home);
  return { source, clone };
}

describe('auto sync hook', { timeout: GIT_E2E_TEST_TIMEOUT_MS }, () => {
  it('pulls community updates and reindexes them while own sync skips non-repos', async () => {
    const { home, cleanup } = fresh();
    try {
      const { source, clone } = setupCommunityClone(home);
      writeFileSync(
        join(source, 'entries', 'second.md'),
        entry('second', 'Nebula prism sync failure', 'Nebula prism sync failure reports a rare autosync anchor.'),
      );
      git(['add', '-A'], source);
      git(['commit', '-m', 'add second community entry'], source);
      git(['push', 'origin', 'main'], source);

      const result = cli(['hook', 'autosync'], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      await waitFor(join(home, 'sync', '.last-autosync.json'));
      expect(existsSync(join(clone, 'entries', 'second.md'))).toBe(true);

      const prompt = cli(['hook', 'user-prompt-submit'], home);
      expect(prompt.status).toBe(0);
      expect(prompt.stdout).toContain('Nebula prism sync failure');
    } finally {
      cleanup();
    }
  });

  it('honors the autosync kill switch', () => {
    const { home, cleanup } = fresh();
    try {
      setupCommunityClone(home);
      const result = cli(['hook', 'autosync'], home, { ...process.env, CAVEAT_AUTO_SYNC: 'off' });
      expect(result.status).toBe(0);
      expect(existsSync(join(home, 'sync', '.last-autosync.json'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('returns without writing state when a live autosync lock exists', () => {
    const { home, cleanup } = fresh();
    try {
      setupCommunityClone(home);
      mkdirSync(join(home, 'sync'), { recursive: true });
      writeFileSync(join(home, 'sync', '.autosync-lock'), String(process.pid), 'utf-8');
      const result = cli(['hook', 'autosync'], home);
      expect(result.status).toBe(0);
      expect(existsSync(join(home, 'sync', '.last-autosync.json'))).toBe(false);
      expect(readFileSync(join(home, 'sync', '.autosync-lock'), 'utf-8')).toBe(String(process.pid));
    } finally {
      cleanup();
    }
  });
});
