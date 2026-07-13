#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'caveat-claude-fresh-session-test-'));
try {
  const settings = join(root, 'settings.json');
  const mcp = join(root, 'mcp.json');
  const caveatHome = join(root, 'caveat-home');
  writeFileSync(settings, '{}'); writeFileSync(mcp, '{}'); mkdirSync(caveatHome);
  for (const [mode, expected] of [['happy', 0], ['unauth', 2], ['bad-auth-json', 2], ['hook-failure', 1], ['wrong-model', 1], ['bad-json', 1], ['missing-hook', 1], ['error-text', 1], ['timeout', 1], ['auth-timeout', 2]]) {
    const result = spawnSync(process.execPath, ['scripts/claude-fresh-session-smoke.mjs', '--claude-command', process.execPath, '--claude-command-arg', resolve('scripts/fixtures/fake-claude-fresh-session.mjs'), '--settings', settings, '--mcp-config', mcp, '--caveat-home', caveatHome, '--timeout-ms', '50', '--auth-timeout-ms', '50'], { cwd: resolve('.'), env: { ...process.env, FAKE_CLAUDE_MODE: mode }, encoding: 'utf8', timeout: 15_000 });
    if (result.status !== expected) throw new Error(`${mode}: expected ${expected}, got ${result.status}; ${result.stderr}`);
  }
  process.stdout.write('claude fresh-session fake smoke: ok\n');
} finally { rmSync(root, { recursive: true, force: true }); }
