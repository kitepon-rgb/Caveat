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

  it('writes PowerShell-callable commands for Windows paths with spaces', () => {
    fx.nodePath = 'C:/Program Files/nodejs/node.exe';
    fx.cliScriptPath = 'C:/Users/Kite/App Data/Roaming/npm/node_modules/caveat-cli/dist/caveat.js';
    installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      platform: 'win32',
      dryRun: false,
      logger: silentLogger,
    });
    const hooks = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(hooks.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      '& "C:/Program Files/nodejs/node.exe" "C:/Users/Kite/App Data/Roaming/npm/node_modules/caveat-cli/dist/caveat.js" codex-hook user-prompt-submit',
    );
    expect(hooks.hooks.PostToolUse[0]?.hooks[0]?.command).toContain('& "C:/Program Files/nodejs/node.exe"');
    expect(hooks.hooks.Stop[0]?.hooks[0]?.command).toContain('& "C:/Program Files/nodejs/node.exe"');

    const second = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      platform: 'win32',
      dryRun: false,
      logger: silentLogger,
    });
    expect(second.hooks).toEqual({ userPromptSubmit: 'unchanged', postToolUse: 'unchanged', stop: 'unchanged' });
  });

  it('creates hooks.json and enables the canonical hooks feature', () => {
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
    expect(readFileSync(fx.configPath, 'utf-8')).toContain('hooks = true');
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
    expect(readFileSync(fx.configPath, 'utf-8')).toContain('[features]\nhooks = true\nother = true');
    expect(findBackup(fx.codexHome, 'hooks.json.caveat-backup-')).toBeDefined();
    expect(findBackup(fx.codexHome, 'config.toml.caveat-backup-')).toBeDefined();
  });

  it('respects an explicit false feature as consent and skips all hook writes', () => {
    const original = 'model = "gpt-5.5"\n[features]\nhooks = false\nother = true\n';
    writeFileSync(fx.configPath, original, 'utf-8');

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.feature).toBe('blocked');
    expect(result.hooks.userPromptSubmit).toBe('skipped');
    expect(result.blockedReason).toMatch(/explicitly false/);
    expect(readFileSync(fx.configPath, 'utf-8')).toBe(original);
    expect(existsSync(fx.hooksPath)).toBe(false);
    expect(findBackup(fx.codexHome, 'config.toml.caveat-backup-')).toBeUndefined();
  });

  it('respects false in a whitespace-padded valid TOML features header', () => {
    const original = '[ features ]\nhooks = false\n';
    writeFileSync(fx.configPath, original, 'utf-8');

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.feature).toBe('blocked');
    expect(readFileSync(fx.configPath, 'utf-8')).toBe(original);
    expect(existsSync(fx.hooksPath)).toBe(false);
  });

  it('does not expose an invalid TOML source line in the blocked reason', () => {
    const secret = 'TOPSECRET-CAVEAT-TEST';
    writeFileSync(fx.configPath, `x = { token = "${secret}", } garbage\n`, 'utf-8');

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.feature).toBe('blocked');
    expect(result.blockedReason).toBe('config.toml is invalid TOML; fix it before installing Caveat hooks');
    expect(result.blockedReason).not.toContain(secret);
  });

  it('does not rewrite feature-like text inside a multiline TOML string', () => {
    const original = 'developer_instructions = """\n[features]\ncodex_hooks = true # example\n"""\n';
    writeFileSync(fx.configPath, original, 'utf-8');

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.feature).toBe('enabled');
    expect(readFileSync(fx.configPath, 'utf-8')).toBe(`${original}\n[features]\nhooks = true\n`);
  });

  it('leaves an existing true feature unchanged', () => {
    writeFileSync(fx.configPath, '[features]\nhooks = true\n', 'utf-8');
    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    expect(result.feature).toBe('unchanged');
    expect(readFileSync(fx.configPath, 'utf-8')).toBe('[features]\nhooks = true\n');
    expect(findBackup(fx.codexHome, 'config.toml.caveat-backup-')).toBeUndefined();
  });

  it('blocks dotted feature syntax instead of creating a duplicate TOML definition', () => {
    const original = 'features.hooks = false\n';
    writeFileSync(fx.configPath, original, 'utf-8');
    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    expect(result.feature).toBe('blocked');
    expect(readFileSync(fx.configPath, 'utf-8')).toBe(original);
    expect(existsSync(fx.hooksPath)).toBe(false);
  });

  it('adds a features table without damaging other TOML and backs up config', () => {
    writeFileSync(fx.configPath, 'model = "gpt-5.5"\n[projects."/tmp/x"]\ntrust_level = "trusted"\n', 'utf-8');
    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });
    const config = readFileSync(fx.configPath, 'utf-8');
    expect(result.feature).toBe('enabled');
    expect(config).toContain('[projects."/tmp/x"]\ntrust_level = "trusted"');
    expect(config).toContain('[features]\nhooks = true');
    expect(findBackup(fx.codexHome, 'config.toml.caveat-backup-')).toBeDefined();
  });

  it('migrates the deprecated true alias without leaving a Codex warning', () => {
    writeFileSync(fx.configPath, '[features]\ncodex_hooks = true # old Caveat\nother = true\n', 'utf-8');

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.feature).toBe('enabled');
    expect(readFileSync(fx.configPath, 'utf-8')).toBe('[features]\nhooks = true # old Caveat\nother = true\n');
    expect(findBackup(fx.codexHome, 'config.toml.caveat-backup-')).toBeDefined();
  });

  it('removes a redundant true deprecated alias beside the canonical key', () => {
    writeFileSync(fx.configPath, '[features]\nhooks = true\ncodex_hooks = true#Caveat用の運用メモ\n', 'utf-8');

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.feature).toBe('enabled');
    expect(readFileSync(fx.configPath, 'utf-8')).toBe('[features]\nhooks = true\n#Caveat用の運用メモ\n');
  });

  it('blocks conflicting canonical and deprecated feature values', () => {
    const original = '[features]\nhooks = true\ncodex_hooks = false\n';
    writeFileSync(fx.configPath, original, 'utf-8');

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.feature).toBe('blocked');
    expect(result.blockedReason).toMatch(/conflicts/);
    expect(readFileSync(fx.configPath, 'utf-8')).toBe(original);
    expect(existsSync(fx.hooksPath)).toBe(false);
  });

  it('updates existing Caveat hooks when the installed node path changes', () => {
    writeFileSync(
      fx.hooksPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: '/opt/homebrew/Cellar/node/26.0.0/bin/node /opt/homebrew/bin/caveat codex-hook user-prompt-submit',
                  },
                ],
              },
              { hooks: [{ type: 'command', command: 'node spotter.mjs codex-hook user-prompt-submit' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = installCodexHooks({
      codexHome: fx.codexHome,
      cliScriptPath: '/opt/homebrew/bin/caveat',
      nodePath: '/opt/homebrew/bin/node',
      platform: 'linux',
      dryRun: false,
      logger: silentLogger,
    });
    expect(result.hooks.userPromptSubmit).toBe('added');

    const hooks = JSON.parse(readFileSync(fx.hooksPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      '/opt/homebrew/bin/node /opt/homebrew/bin/caveat codex-hook user-prompt-submit',
    );
    expect(hooks.hooks.UserPromptSubmit[1]?.hooks[0]?.command).toBe(
      'node spotter.mjs codex-hook user-prompt-submit',
    );
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
