import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'stop.mjs');

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

describe('stop.mjs', () => {
  it('emits system-reminder with [caveat] prefix', () => {
    const { stdout, status } = run(JSON.stringify({}));
    expect(status).toBe(0);
    expect(stdout).toMatch(/^<system-reminder>\[caveat\][\s\S]*<\/system-reminder>\n$/);
  });

  it('mentions both resolved and impossible outcomes', () => {
    const { stdout } = run(JSON.stringify({}));
    expect(stdout).toContain('caveat_record');
    expect(stdout).toContain('impossible');
  });

  it('is silent when stop_hook_active is true (loop guard)', () => {
    const { stdout, status } = run(JSON.stringify({ stop_hook_active: true }));
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 on malformed JSON without stdout noise', () => {
    const { stdout, stderr, status } = run('garbage');
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('[caveat:hook]');
  });

  it('emits output as a single <system-reminder> block', () => {
    const { stdout } = run(JSON.stringify({}));
    const matches = stdout.match(/<system-reminder>/g);
    expect(matches?.length).toBe(1);
  });
});
