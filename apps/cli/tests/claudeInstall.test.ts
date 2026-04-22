import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@caveat/core';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
} from '../src/claudeInstall.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

interface Fx {
  root: string;
  claudeDir: string;
  settingsPath: string;
  cliScriptPath: string;
  nodePath: string;
}

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-install-'));
  const claudeDir = join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  return {
    root,
    claudeDir,
    settingsPath: join(claudeDir, 'settings.json'),
    cliScriptPath: 'C:/fake/dist/index.js',
    nodePath: 'C:/fake/node.exe',
  };
}

function cleanup(fx: Fx): void {
  rmSync(fx.root, { recursive: true, force: true });
}

function findBackup(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).find((f) => f.startsWith('settings.json.caveat-backup-'));
}

describe('installClaudeIntegration (hooks only — MCP spawn tolerated)', () => {
  let fx: Fx;
  beforeEach(() => {
    fx = makeFx();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('creates settings.json with all three hooks when none exists', () => {
    const result = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(result.hooks.userPromptSubmit).toBe('added');
    expect(result.hooks.postToolUse).toBe('added');
    expect(result.hooks.stop).toBe('added');

    const raw = readFileSync(fx.settingsPath, 'utf-8');
    const settings = JSON.parse(raw) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain(
      'hook user-prompt-submit',
    );
    expect(settings.hooks.PostToolUse[0]?.hooks[0]?.command).toContain(
      'hook post-tool-use',
    );
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain('hook stop');
  });

  it('preserves existing hooks when adding caveat hooks', () => {
    writeFileSync(
      fx.settingsPath,
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

    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      'throughline prompt-submit',
    );
    expect(settings.hooks.UserPromptSubmit[1]?.hooks[0]?.command).toContain(
      'hook user-prompt-submit',
    );
    expect(findBackup(fx.claudeDir)).toBeDefined();
  });

  it('is idempotent — second install does not duplicate hooks', () => {
    const first = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(first.hooks.userPromptSubmit).toBe('added');

    const second = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(second.hooks.userPromptSubmit).toBe('unchanged');
    expect(second.hooks.stop).toBe('unchanged');

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('dry-run leaves settings.json untouched', () => {
    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: true,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(existsSync(fx.settingsPath)).toBe(false);
  });

  it('uninstall removes hooks that install added', () => {
    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    const result = uninstallClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(result.hooks.userPromptSubmit).toBe('added'); // marker: was removed
    expect(result.hooks.postToolUse).toBe('added');
    expect(result.hooks.stop).toBe('added');

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(0);
    expect(settings.hooks.PostToolUse).toHaveLength(0);
    expect(settings.hooks.Stop).toHaveLength(0);
  });

  it('uninstall leaves unrelated hooks intact', () => {
    writeFileSync(
      fx.settingsPath,
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
    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    uninstallClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      'throughline prompt-submit',
    );
  });
});
