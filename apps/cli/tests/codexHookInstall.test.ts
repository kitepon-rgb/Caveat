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
  detectCodexHookInstallation,
  installCodexHooks,
  uninstallCodexHooks,
} from '../src/codexHookInstall.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

interface Fx {
  root: string;
  codexHome: string;
  hooksPath: string;
  configPath: string;
  cliScriptPath: string;
  nodePath: string;
}

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-codex-install-'));
  const codexHome = join(root, '.codex');
  mkdirSync(codexHome, { recursive: true });
  return {
    root,
    codexHome,
    hooksPath: join(codexHome, 'hooks.json'),
    configPath: join(codexHome, 'config.toml'),
    cliScriptPath: 'C:/fake/dist/index.js',
    nodePath: 'C:/fake/node.exe',
  };
}

function cleanup(fx: Fx): void {
  rmSync(fx.root, { recursive: true, force: true });
}

function findBackup(dir: string, prefix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).find((f) => f.startsWith(prefix));
}

describe('installCodexHooks', () => {
  let fx: Fx;
  beforeEach(() => {
    fx = makeFx();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('creates hooks.json and enables codex_hooks', () => {
    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    expect(result.hooks.userPromptSubmit).toBe('added');
    expect(result.hooks.postToolUse).toBe('added');
    expect(result.hooks.stop).toBe('added');
    expect(result.feature).toBe('enabled');

    const hooks = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; async: boolean }> }>>;
    };
    expect(hooks.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain(
      'codex-hook user-prompt-submit',
    );
    expect(hooks.hooks.UserPromptSubmit[0]?.hooks[0]?.async).toBe(false);
    expect(hooks.hooks.PostToolUse[0]?.hooks[0]?.command).toContain(
      'codex-hook post-tool-use',
    );
    expect(hooks.hooks.Stop[0]?.hooks[0]?.command).toContain('codex-hook stop');
    expect(readFileSync(fx.configPath, 'utf-8')).toContain('codex_hooks = true');
  });

  it('preserves unrelated hooks and is idempotent', () => {
    writeFileSync(
      fx.hooksPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'throughline prompt-submit' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(fx.configPath, 'model = "gpt-5.5"\n[features]\nother = true\n', 'utf-8');

    const first = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    const second = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    expect(first.hooks.userPromptSubmit).toBe('added');
    expect(second.hooks.userPromptSubmit).toBe('unchanged');
    expect(second.feature).toBe('unchanged');

    const hooks = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      'throughline prompt-submit',
    );
    expect(readFileSync(fx.configPath, 'utf-8')).toContain('[features]\ncodex_hooks = true\nother = true');
    expect(findBackup(fx.codexHome, 'hooks.json.caveat-backup-')).toBeDefined();
    expect(findBackup(fx.codexHome, 'config.toml.caveat-backup-')).toBeDefined();
  });

  it('uninstall removes only Caveat-owned hooks', () => {
    writeFileSync(
      fx.hooksPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'keep me' }] }],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    const result = uninstallCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    expect(result.hooks.userPromptSubmit).toBe('added');
    expect(result.hooks.postToolUse).toBe('added');
    expect(result.hooks.stop).toBe('added');

    const hooks = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(hooks.hooks.Stop).toHaveLength(1);
    expect(hooks.hooks.Stop[0]?.hooks[0]?.command).toBe('keep me');
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(0);
    expect(hooks.hooks.PostToolUse).toHaveLength(0);
  });

  it('reports installation status separately from availability', () => {
    expect(detectCodexHookInstallation(fx.codexHome).installation).toBe('not-installed');

    writeFileSync(
      fx.hooksPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'node caveat.js codex-hook user-prompt-submit' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    expect(detectCodexHookInstallation(fx.codexHome).installation).toBe('partial');

    installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    expect(detectCodexHookInstallation(fx.codexHome).installation).toBe('installed');
  });
});
