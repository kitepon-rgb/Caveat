import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '@caveat/core';

export interface CodexHookInstallOptions {
  codexHome: string;
  cliScriptPath: string;
  nodePath: string;
  dryRun: boolean;
  logger: Logger;
}

export interface CodexHookInstallResult {
  hooks: {
    userPromptSubmit: 'added' | 'unchanged';
    postToolUse: 'added' | 'unchanged';
    stop: 'added' | 'unchanged';
  };
  feature: 'enabled' | 'unchanged';
  backupPath?: string;
  configBackupPath?: string;
}

export interface CodexHookInstallationStatus {
  installation: 'not-installed' | 'installed' | 'partial';
  hooksPath: string;
  hooks: {
    userPromptSubmit: boolean;
    postToolUse: boolean;
    stop: boolean;
  };
}

type HookEvent = 'UserPromptSubmit' | 'PostToolUse' | 'Stop';
type HookEntry = {
  matcher?: string | null;
  hooks: Array<{
    type: string;
    command: string;
    timeoutSec?: number | null;
    async?: boolean;
    statusMessage?: string | null;
  }>;
};
type HooksJson = {
  hooks?: Partial<Record<HookEvent, HookEntry[]>>;
  [key: string]: unknown;
};

function quote(p: string): string {
  return p.includes(' ') ? `"${p}"` : p;
}

function hookCommand(
  nodePath: string,
  cliScriptPath: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): string {
  return `${quote(nodePath)} ${quote(cliScriptPath)} codex-hook ${event}`;
}

function eventCommandFragment(event: 'user-prompt-submit' | 'post-tool-use' | 'stop'): string {
  return `codex-hook ${event}`;
}

function isSameHookCommand(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(` ${expected}`);
}

function isCaveatCodexHookCommand(
  actual: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): boolean {
  const lower = actual.toLowerCase();
  return lower.includes('caveat') && actual.includes(eventCommandFragment(event));
}

function hasCaveatHook(hooksJson: HooksJson, event: HookEvent, fragment: string): boolean {
  return (
    hooksJson.hooks?.[event]?.some((entry) =>
      entry.hooks?.some((h) => h.command.includes(fragment)),
    ) ?? false
  );
}

function readHooks(path: string): HooksJson {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as HooksJson;
}

function writeJsonWithBackup(path: string, value: unknown): string {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let backupPath = '';
  if (existsSync(path)) {
    backupPath = `${path}.caveat-backup-${Date.now()}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  return backupPath;
}

function upsertHook(
  hooksJson: HooksJson,
  event: HookEvent,
  command: string,
  subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): 'added' | 'unchanged' {
  hooksJson.hooks ??= {};
  const list = (hooksJson.hooks[event] ??= []);
  for (const entry of list) {
    for (const hook of entry.hooks ?? []) {
      if (isSameHookCommand(hook.command, command)) return 'unchanged';
      if (isCaveatCodexHookCommand(hook.command, subcommand)) {
        hook.command = command;
        hook.timeoutSec = 5;
        hook.async = false;
        hook.statusMessage = null;
        return 'added';
      }
    }
  }
  list.push({
    hooks: [
      {
        type: 'command',
        command,
        timeoutSec: 5,
        async: false,
        statusMessage: null,
      },
    ],
  });
  return 'added';
}

function removeHook(
  hooksJson: HooksJson,
  event: HookEvent,
  command: string,
  subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): boolean {
  const list = hooksJson.hooks?.[event];
  if (!list) return false;
  const before = list.length;
  const filtered = list.filter(
    (entry) => !entry.hooks?.some((h) =>
      isSameHookCommand(h.command, command) || isCaveatCodexHookCommand(h.command, subcommand),
    ),
  );
  if (filtered.length === before) return false;
  hooksJson.hooks![event] = filtered;
  return true;
}

function enableCodexHooksFeature(raw: string): { text: string; changed: boolean } {
  if (/^\s*codex_hooks\s*=\s*true\s*$/m.test(raw)) return { text: raw, changed: false };
  const lines = raw.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) => /^\s*\[features]\s*$/.test(line));
  if (featuresStart === -1) {
    const prefix = raw.trimEnd();
    const text = `${prefix}${prefix ? '\n\n' : ''}[features]\ncodex_hooks = true\n`;
    return { text, changed: true };
  }

  let insertAt = featuresStart + 1;
  for (let i = featuresStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+]\s*$/.test(lines[i]!)) {
      break;
    }
    if (/^\s*codex_hooks\s*=/.test(lines[i]!)) {
      lines[i] = 'codex_hooks = true';
      return { text: `${lines.join('\n').trimEnd()}\n`, changed: true };
    }
  }
  lines.splice(insertAt, 0, 'codex_hooks = true');
  return { text: `${lines.join('\n').trimEnd()}\n`, changed: true };
}

function writeConfigWithBackup(path: string, text: string): string {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let backupPath = '';
  if (existsSync(path)) {
    backupPath = `${path}.caveat-backup-${Date.now()}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, text, 'utf-8');
  return backupPath;
}

export function installCodexHooks(opts: CodexHookInstallOptions): CodexHookInstallResult {
  const hooksPath = join(opts.codexHome, 'hooks.json');
  const configPath = join(opts.codexHome, 'config.toml');
  const hooksJson = readHooks(hooksPath);

  const userPromptSubmit = upsertHook(
    hooksJson,
    'UserPromptSubmit',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit'),
    'user-prompt-submit',
  );
  const postToolUse = upsertHook(
    hooksJson,
    'PostToolUse',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use'),
    'post-tool-use',
  );
  const stop = upsertHook(
    hooksJson,
    'Stop',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'stop'),
    'stop',
  );

  const rawConfig = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const enabled = enableCodexHooksFeature(rawConfig);
  const anyHookAdded =
    userPromptSubmit === 'added' || postToolUse === 'added' || stop === 'added';

  let backupPath: string | undefined;
  let configBackupPath: string | undefined;
  if (opts.dryRun) {
    opts.logger.info(`[dry-run] would update ${hooksPath}`);
    opts.logger.info(`[dry-run] would ensure [features].codex_hooks = true in ${configPath}`);
  } else {
    if (anyHookAdded) {
      const backup = writeJsonWithBackup(hooksPath, hooksJson);
      if (backup) backupPath = backup;
    }
    if (enabled.changed) {
      const backup = writeConfigWithBackup(configPath, enabled.text);
      if (backup) configBackupPath = backup;
    }
  }

  return {
    hooks: { userPromptSubmit, postToolUse, stop },
    feature: enabled.changed ? 'enabled' : 'unchanged',
    backupPath,
    configBackupPath,
  };
}

export function uninstallCodexHooks(opts: CodexHookInstallOptions): CodexHookInstallResult {
  const hooksPath = join(opts.codexHome, 'hooks.json');
  const hooksJson = readHooks(hooksPath);
  const userPromptSubmitRemoved = removeHook(
    hooksJson,
    'UserPromptSubmit',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit'),
    'user-prompt-submit',
  );
  const postToolUseRemoved = removeHook(
    hooksJson,
    'PostToolUse',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use'),
    'post-tool-use',
  );
  const stopRemoved = removeHook(
    hooksJson,
    'Stop',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'stop'),
    'stop',
  );

  let backupPath: string | undefined;
  if (opts.dryRun) {
    opts.logger.info(`[dry-run] would remove Caveat Codex hooks from ${hooksPath}`);
  } else if (userPromptSubmitRemoved || postToolUseRemoved || stopRemoved) {
    const backup = writeJsonWithBackup(hooksPath, hooksJson);
    if (backup) backupPath = backup;
  }

  return {
    hooks: {
      userPromptSubmit: userPromptSubmitRemoved ? 'added' : 'unchanged',
      postToolUse: postToolUseRemoved ? 'added' : 'unchanged',
      stop: stopRemoved ? 'added' : 'unchanged',
    },
    feature: 'unchanged',
    backupPath,
  };
}

export function detectCodexHookInstallation(codexHome: string): CodexHookInstallationStatus {
  const hooksPath = join(codexHome, 'hooks.json');
  const hooksJson = readHooks(hooksPath);
  const hooks = {
    userPromptSubmit: hasCaveatHook(
      hooksJson,
      'UserPromptSubmit',
      eventCommandFragment('user-prompt-submit'),
    ),
    postToolUse: hasCaveatHook(hooksJson, 'PostToolUse', eventCommandFragment('post-tool-use')),
    stop: hasCaveatHook(hooksJson, 'Stop', eventCommandFragment('stop')),
  };
  const count = Object.values(hooks).filter(Boolean).length;
  return {
    installation: count === 0 ? 'not-installed' : count === 3 ? 'installed' : 'partial',
    hooksPath,
    hooks,
  };
}
