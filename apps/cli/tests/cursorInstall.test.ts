import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@caveat/core';
import {
  detectCursorHookInstallation,
  installCursorHooks,
  uninstallCursorHooks,
} from '../src/cursorInstall.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

interface Fx {
  root: string;
  cursorDir: string;
  hooksPath: string;
  cliScriptPath: string;
  nodePath: string;
}

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-cursor-install-'));
  const cursorDir = join(root, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  return {
    root,
    cursorDir,
    hooksPath: join(cursorDir, 'hooks.json'),
    cliScriptPath: '/fake/dist/caveat.js',
    nodePath: '/fake/bin/node',
  };
}

function cleanup(fx: Fx): void {
  rmSync(fx.root, { recursive: true, force: true });
}

describe('installCursorHooks', () => {
  let fx: Fx;
  beforeEach(() => {
    fx = makeFx();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('creates Cursor hooks.json with flat command entries and keeps factory hooks', () => {
    writeFileSync(fx.hooksPath, `${JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: '/Users/kite/.local/bin/cursor-constitution-hook', timeout: 10 }],
      },
    }, null, 2)}\n`);

    const result = installCursorHooks({
      cursorDir: fx.cursorDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.hooks.beforeSubmitPrompt).toBe('added');
    expect(result.hooks.postToolUse).toBe('added');
    expect(result.hooks.postToolUseFailure).toBe('added');
    expect(result.hooks.stop).toBe('added');

    const file = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      version: number;
      hooks: Record<string, Array<{ command: string; timeout: number }>>;
    };
    expect(file.version).toBe(1);
    expect(file.hooks.sessionStart[0]?.command).toContain('cursor-constitution-hook');
    expect(file.hooks.beforeSubmitPrompt[0]?.command).toContain('cursor-hook user-prompt-submit');
    expect(file.hooks.postToolUse[0]?.command).toContain('cursor-hook post-tool-use');
    expect(file.hooks.postToolUseFailure[0]?.command).toContain('cursor-hook post-tool-use');
    expect(file.hooks.stop[0]?.command).toContain('cursor-hook stop');
    expect(file.hooks.beforeSubmitPrompt[0]?.timeout).toBe(10);
    expect(file.hooks.beforeSubmitPrompt[0]).not.toHaveProperty('type');
    expect(detectCursorHookInstallation(fx.cursorDir).installation).toBe('installed');
  });

  it('is idempotent and does not duplicate Caveat entries', () => {
    const opts = {
      cursorDir: fx.cursorDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    };
    installCursorHooks(opts);
    const second = installCursorHooks(opts);
    expect(second.hooks.beforeSubmitPrompt).toBe('unchanged');
    const file = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(file.hooks.beforeSubmitPrompt).toHaveLength(1);
  });

  it('uninstall removes only Caveat cursor-hook commands', () => {
    writeFileSync(fx.hooksPath, `${JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: '/factory/cursor-constitution-hook', timeout: 10 }],
      },
    }, null, 2)}\n`);
    installCursorHooks({
      cursorDir: fx.cursorDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    uninstallCursorHooks({
      cursorDir: fx.cursorDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    const file = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(file.hooks.beforeSubmitPrompt).toEqual([
      { command: '/factory/cursor-constitution-hook', timeout: 10 },
    ]);
    expect(file.hooks.postToolUse).toBeUndefined();
    expect(detectCursorHookInstallation(fx.cursorDir).installation).toBe('not-installed');
  });

  it('dry-run does not write', () => {
    installCursorHooks({
      cursorDir: fx.cursorDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: true,
      logger: silentLogger,
    });
    expect(existsSync(fx.hooksPath)).toBe(false);
  });

  it('backs up an existing hooks.json', () => {
    writeFileSync(fx.hooksPath, `${JSON.stringify({ version: 1, hooks: {} }, null, 2)}\n`);
    installCursorHooks({
      cursorDir: fx.cursorDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    const backup = readdirSync(fx.cursorDir).find((name) => name.startsWith('hooks.json.caveat-backup-'));
    expect(backup).toBeDefined();
  });
});
