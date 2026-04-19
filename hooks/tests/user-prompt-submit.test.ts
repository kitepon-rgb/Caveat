import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { detectCaveatTrigger } from '../user-prompt-submit.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'user-prompt-submit.mjs');

function run(stdinJson: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [HOOK], {
    input: stdinJson,
    encoding: 'utf-8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('detectCaveatTrigger (unit)', () => {
  it('triggers on GPU / CUDA keywords', () => {
    expect(detectCaveatTrigger('how do I fix CUDA 12.4 error')).toBe(true);
    expect(detectCaveatTrigger('RTX 5090 で動かない')).toBe(true);
    expect(detectCaveatTrigger('nvidia driver update')).toBe(true);
  });

  it('triggers on IDE / Claude Code keywords', () => {
    expect(detectCaveatTrigger('VSCode extension issue')).toBe(true);
    expect(detectCaveatTrigger('Claude Code hook について')).toBe(true);
  });

  it('triggers on reproducibility keywords', () => {
    expect(detectCaveatTrigger('this is flaky, sometimes works')).toBe(true);
    expect(detectCaveatTrigger('なぜか再現しない')).toBe(true);
    expect(detectCaveatTrigger('intermittent test failure')).toBe(true);
  });

  it('triggers on version-specific phrasing', () => {
    expect(detectCaveatTrigger('needs Node 22 or later')).toBe(true);
    expect(detectCaveatTrigger('バージョン依存の挙動が違う')).toBe(true);
    expect(detectCaveatTrigger('native module prebuild missing')).toBe(true);
  });

  it('does NOT trigger on ordinary requests', () => {
    expect(detectCaveatTrigger('add a new button')).toBe(false);
    expect(detectCaveatTrigger('rename this function')).toBe(false);
    expect(detectCaveatTrigger('fix typo')).toBe(false);
    expect(detectCaveatTrigger('refactor user logic')).toBe(false);
  });

  it('handles empty / non-string gracefully', () => {
    expect(detectCaveatTrigger('')).toBe(false);
    expect(detectCaveatTrigger(undefined as unknown as string)).toBe(false);
    expect(detectCaveatTrigger(null as unknown as string)).toBe(false);
  });
});

describe('user-prompt-submit.mjs (spawn)', () => {
  it('emits system-reminder with [caveat] prefix when triggered', () => {
    const { stdout, status } = run(JSON.stringify({ prompt: 'CUDA driver issue' }));
    expect(status).toBe(0);
    expect(stdout).toMatch(/^<system-reminder>\[caveat\][\s\S]*<\/system-reminder>\n$/);
  });

  it('outputs NOTHING on stdout when not triggered', () => {
    const { stdout, status } = run(JSON.stringify({ prompt: 'make a button blue' }));
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 on malformed JSON without stdout noise', () => {
    const { stdout, stderr, status } = run('not-json-at-all');
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('[caveat:hook]');
  });

  it('exits 0 on empty stdin', () => {
    const { stdout, status } = run('');
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });
});
