import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@caveat/core';
import { constants } from 'node:fs';
import {
  commandTokens,
  isCanonicalAsset,
  quoteCommandPath,
  writeJsonWithBackup,
} from './installShared.js';

export interface CursorInstallOptions {
  cursorDir: string;
  cliScriptPath: string;
  nodePath: string;
  dryRun: boolean;
  logger: Logger;
}

export interface CursorInstallResult {
  hooks: {
    beforeSubmitPrompt: 'added' | 'unchanged';
    postToolUse: 'added' | 'unchanged';
    postToolUseFailure: 'added' | 'unchanged';
    stop: 'added' | 'unchanged';
  };
  backupPath?: string;
}

export interface CursorInstallStatus {
  installation: 'not-installed' | 'installed' | 'partial';
  hooksPath: string;
  hooks: {
    beforeSubmitPrompt: boolean;
    postToolUse: boolean;
    postToolUseFailure: boolean;
    stop: boolean;
  };
}

type CursorHookEvent =
  | 'beforeSubmitPrompt'
  | 'postToolUse'
  | 'postToolUseFailure'
  | 'stop';

type CursorHookEntry = {
  command?: unknown;
  timeout?: unknown;
  [key: string]: unknown;
};

type CursorHooksFile = {
  version?: unknown;
  hooks?: Partial<Record<string, unknown>>;
  [key: string]: unknown;
};

const TIMEOUT_SEC = 10;

function hookCommand(
  nodePath: string,
  cliScriptPath: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): string {
  return `${quoteCommandPath(nodePath)} ${quoteCommandPath(cliScriptPath)} cursor-hook ${event}`;
}

function eventCommandFragment(event: 'user-prompt-submit' | 'post-tool-use' | 'stop'): string {
  return `cursor-hook ${event}`;
}

function isCaveatCursorHookCommand(
  actual: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): boolean {
  const lower = actual.toLowerCase();
  return lower.includes('caveat') && actual.includes(eventCommandFragment(event));
}

export function isCanonicalCaveatCursorHookCommand(
  actual: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
  nodePath: string,
  cliScriptPath: string,
): boolean {
  const tokens = commandTokens(actual);
  return tokens?.length === 4
    && isCanonicalAsset(tokens[0], nodePath, constants.X_OK)
    && isCanonicalAsset(tokens[1], cliScriptPath, constants.R_OK)
    && tokens[2] === 'cursor-hook'
    && tokens[3] === event;
}

export function isCanonicalCaveatCursorHookEntry(
  value: unknown,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
  nodePath: string,
  cliScriptPath: string,
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as CursorHookEntry;
  return typeof entry.command === 'string'
    && isCanonicalCaveatCursorHookCommand(entry.command, event, nodePath, cliScriptPath)
    && entry.timeout === TIMEOUT_SEC;
}

function readHooks(path: string): CursorHooksFile {
  if (!existsSync(path)) return { version: 1, hooks: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} は object である必要があります`);
  }
  const file = parsed as CursorHooksFile;
  if (file.hooks == null) file.hooks = {};
  if (typeof file.hooks !== 'object' || Array.isArray(file.hooks)) {
    throw new Error(`${path} の hooks は object である必要があります`);
  }
  return file;
}

function listFor(file: CursorHooksFile, event: CursorHookEvent): CursorHookEntry[] {
  const current = file.hooks?.[event];
  if (Array.isArray(current)) return current as CursorHookEntry[];
  return [];
}

function isSameCommand(actual: string, expected: string): boolean {
  const left = commandTokens(actual);
  const right = commandTokens(expected);
  return left !== null
    && right !== null
    && left.length === right.length
    && left.every((token, index) => token === right[index]);
}

function upsertHook(
  file: CursorHooksFile,
  event: CursorHookEvent,
  command: string,
  subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): 'added' | 'unchanged' {
  file.hooks ??= {};
  const list = listFor(file, event);
  for (const entry of list) {
    if (typeof entry.command !== 'string') continue;
    if (isSameCommand(entry.command, command) && entry.timeout === TIMEOUT_SEC) {
      return 'unchanged';
    }
    if (isSameCommand(entry.command, command) || isCaveatCursorHookCommand(entry.command, subcommand)) {
      entry.command = command;
      entry.timeout = TIMEOUT_SEC;
      file.hooks[event] = list;
      return 'added';
    }
  }
  list.push({ command, timeout: TIMEOUT_SEC });
  file.hooks[event] = list;
  return 'added';
}

function removeHook(
  file: CursorHooksFile,
  event: CursorHookEvent,
  command: string,
  subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): boolean {
  const list = listFor(file, event);
  if (list.length === 0) return false;
  const kept = list.filter((entry) => {
    if (typeof entry.command !== 'string') return true;
    return !(isSameCommand(entry.command, command) || isCaveatCursorHookCommand(entry.command, subcommand));
  });
  if (kept.length === list.length) return false;
  if (!file.hooks) return true;
  if (kept.length > 0) file.hooks[event] = kept;
  else delete file.hooks[event];
  return true;
}

function hasCaveatHook(
  file: CursorHooksFile,
  event: CursorHookEvent,
  fragment: string,
): boolean {
  return listFor(file, event).some(
    (entry) => typeof entry.command === 'string' && entry.command.includes(fragment),
  );
}

function persist(opts: CursorInstallOptions, file: CursorHooksFile, changed: boolean): string | undefined {
  const hooksPath = join(opts.cursorDir, 'hooks.json');
  if (opts.dryRun) {
    opts.logger.info(`[dry-run] would write Cursor hooks to ${hooksPath}`);
    return undefined;
  }
  if (!changed) return undefined;
  mkdirSync(opts.cursorDir, { recursive: true });
  file.version = 1;
  const backup = writeJsonWithBackup(hooksPath, file);
  return backup || undefined;
}

export function installCursorHooks(opts: CursorInstallOptions): CursorInstallResult {
  const hooksPath = join(opts.cursorDir, 'hooks.json');
  const file = readHooks(hooksPath);
  const promptCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit');
  const toolCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use');
  const stopCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'stop');
  const hooks = {
    beforeSubmitPrompt: upsertHook(file, 'beforeSubmitPrompt', promptCmd, 'user-prompt-submit'),
    postToolUse: upsertHook(file, 'postToolUse', toolCmd, 'post-tool-use'),
    postToolUseFailure: upsertHook(file, 'postToolUseFailure', toolCmd, 'post-tool-use'),
    stop: upsertHook(file, 'stop', stopCmd, 'stop'),
  };
  const changed = Object.values(hooks).some((status) => status === 'added');
  const backupPath = persist(opts, file, changed);
  return { hooks, backupPath };
}

export function uninstallCursorHooks(opts: CursorInstallOptions): CursorInstallResult {
  const hooksPath = join(opts.cursorDir, 'hooks.json');
  const file = readHooks(hooksPath);
  const promptCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit');
  const toolCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use');
  const stopCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'stop');
  const removed = {
    beforeSubmitPrompt: removeHook(file, 'beforeSubmitPrompt', promptCmd, 'user-prompt-submit'),
    postToolUse: removeHook(file, 'postToolUse', toolCmd, 'post-tool-use'),
    postToolUseFailure: removeHook(file, 'postToolUseFailure', toolCmd, 'post-tool-use'),
    stop: removeHook(file, 'stop', stopCmd, 'stop'),
  };
  const changed = Object.values(removed).some(Boolean);
  const backupPath = persist(opts, file, changed);
  return {
    hooks: {
      beforeSubmitPrompt: removed.beforeSubmitPrompt ? 'added' : 'unchanged',
      postToolUse: removed.postToolUse ? 'added' : 'unchanged',
      postToolUseFailure: removed.postToolUseFailure ? 'added' : 'unchanged',
      stop: removed.stop ? 'added' : 'unchanged',
    },
    backupPath,
  };
}

export function detectCursorHookInstallation(cursorDir: string): CursorInstallStatus {
  const hooksPath = join(cursorDir, 'hooks.json');
  const file = existsSync(hooksPath) ? readHooks(hooksPath) : { version: 1, hooks: {} };
  const hooks = {
    beforeSubmitPrompt: hasCaveatHook(file, 'beforeSubmitPrompt', eventCommandFragment('user-prompt-submit')),
    postToolUse: hasCaveatHook(file, 'postToolUse', eventCommandFragment('post-tool-use')),
    postToolUseFailure: hasCaveatHook(file, 'postToolUseFailure', eventCommandFragment('post-tool-use')),
    stop: hasCaveatHook(file, 'stop', eventCommandFragment('stop')),
  };
  const count = Object.values(hooks).filter(Boolean).length;
  return {
    installation: count === 0 ? 'not-installed' : count === 4 ? 'installed' : 'partial',
    hooksPath,
    hooks,
  };
}
