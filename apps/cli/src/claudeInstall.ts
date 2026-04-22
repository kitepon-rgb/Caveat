import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '@caveat/core';

export interface ClaudeInstallOptions {
  claudeDir: string;
  /** Absolute path to the bundled CLI script (used with process.execPath). */
  cliScriptPath: string;
  /** Absolute path to the `node` binary. */
  nodePath: string;
  dryRun: boolean;
  logger: Logger;
  /** Skip the `claude mcp add/remove` spawn (used by tests to avoid touching real `~/.claude.json`). */
  skipMcpRegistration?: boolean;
}

export interface ClaudeInstallResult {
  mcp: { action: 'registered' | 'skipped' | 'failed'; detail?: string };
  hooks: {
    userPromptSubmit: 'added' | 'unchanged';
    postToolUse: 'added' | 'unchanged';
    stop: 'added' | 'unchanged';
  };
  backupPath?: string;
}

const EVENT_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
const EVENT_POST_TOOL_USE = 'PostToolUse';
const EVENT_STOP = 'Stop';

function quote(p: string): string {
  return p.includes(' ') ? `"${p}"` : p;
}

function mcpArgs(cliScriptPath: string): string[] {
  // `--disable-warning=ExperimentalWarning` silences the node:sqlite warning that
  // otherwise writes a line to stderr; harmless for stderr but keeps the spawn
  // log clean. MCP's stdio channel is JSON-RPC only — warnings must never leak
  // to stdout and this flag guards against future node versions that might.
  return ['--disable-warning=ExperimentalWarning', cliScriptPath, 'mcp-server'];
}

function hookCommand(
  nodePath: string,
  cliScriptPath: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): string {
  return `${quote(nodePath)} ${quote(cliScriptPath)} hook ${event}`;
}

type HookEntry = { hooks: Array<{ type: string; command: string }> };
type HookMap = Record<string, HookEntry[]>;
type Settings = {
  hooks?: HookMap;
  [key: string]: unknown;
};

function upsertHook(
  settings: Settings,
  event: string,
  command: string,
): 'added' | 'unchanged' {
  settings.hooks ??= {};
  const list = (settings.hooks[event] ??= []);
  const alreadyPresent = list.some((entry) =>
    entry.hooks?.some((h) => h.command === command),
  );
  if (alreadyPresent) return 'unchanged';
  list.push({ hooks: [{ type: 'command', command }] });
  return 'added';
}

function removeHook(settings: Settings, event: string, command: string): boolean {
  const list = settings.hooks?.[event];
  if (!list) return false;
  const before = list.length;
  const filtered = list.filter(
    (entry) => !entry.hooks?.some((h) => h.command === command),
  );
  if (filtered.length === before) return false;
  settings.hooks![event] = filtered;
  return true;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Settings;
}

function writeSettings(path: string, settings: Settings): string {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let backupPath = '';
  if (existsSync(path)) {
    backupPath = `${path}.caveat-backup-${Date.now()}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return backupPath;
}

const CLAUDE_BIN = 'claude';

function shellQuote(s: string): string {
  // Cross-platform-safe quoting for shell: true. The inputs are all produced by
  // this installer (no user-supplied strings), so we only need to handle paths
  // containing spaces. Values may contain no `"` chars by construction.
  return /[\s&|<>^()]/.test(s) ? `"${s}"` : s;
}

function runClaude(args: string[]): ReturnType<typeof spawnSync> {
  // Use `shell: true` with a single command string to avoid the
  // Node 24 "shell + args array" deprecation and to let the platform shell
  // resolve claude.cmd on Windows / claude on POSIX.
  const line = [CLAUDE_BIN, ...args].map(shellQuote).join(' ');
  return spawnSync(line, { shell: true, encoding: 'utf-8' });
}

function registerMcp(
  nodePath: string,
  cliScriptPath: string,
  dryRun: boolean,
  logger: Logger,
): ClaudeInstallResult['mcp'] {
  const args = mcpArgs(cliScriptPath);
  if (dryRun) {
    logger.info(
      `[dry-run] claude mcp add --scope user caveat -- ${nodePath} ${args.join(' ')}`,
    );
    return { action: 'skipped', detail: 'dry-run' };
  }

  // Idempotent: remove first (ignore failure), then add.
  runClaude(['mcp', 'remove', '--scope', 'user', 'caveat']);
  const result = runClaude([
    'mcp',
    'add',
    '--scope',
    'user',
    'caveat',
    '--',
    nodePath,
    ...args,
  ]);
  if (result.status === 0) {
    return { action: 'registered' };
  }
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    return {
      action: 'skipped',
      detail: 'claude CLI not found in PATH; install Claude Code to enable MCP',
    };
  }
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return {
    action: 'failed',
    detail: (stderr || stdout || 'unknown error').trim(),
  };
}

function unregisterMcp(dryRun: boolean, logger: Logger): ClaudeInstallResult['mcp'] {
  if (dryRun) {
    logger.info('[dry-run] claude mcp remove --scope user caveat');
    return { action: 'skipped', detail: 'dry-run' };
  }
  const result = runClaude(['mcp', 'remove', '--scope', 'user', 'caveat']);
  if (result.status === 0) return { action: 'registered', detail: 'removed' };
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    return { action: 'skipped', detail: 'claude CLI not found' };
  }
  return { action: 'skipped', detail: 'not registered or removal failed' };
}

export function installClaudeIntegration(
  opts: ClaudeInstallOptions,
): ClaudeInstallResult {
  const settingsPath = join(opts.claudeDir, 'settings.json');
  const settings = readSettings(settingsPath);

  const usCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit');
  const ptCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use');
  const stopCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'stop');

  const userPromptSubmit = upsertHook(settings, EVENT_USER_PROMPT_SUBMIT, usCmd);
  const postToolUse = upsertHook(settings, EVENT_POST_TOOL_USE, ptCmd);
  const stop = upsertHook(settings, EVENT_STOP, stopCmd);

  let backupPath: string | undefined;
  const anyAdded =
    userPromptSubmit === 'added' || postToolUse === 'added' || stop === 'added';
  if (!opts.dryRun && anyAdded) {
    const backup = writeSettings(settingsPath, settings);
    if (backup) backupPath = backup;
  } else if (opts.dryRun) {
    opts.logger.info(
      `[dry-run] would ${userPromptSubmit === 'added' ? 'add' : 'keep'} UserPromptSubmit, ${postToolUse === 'added' ? 'add' : 'keep'} PostToolUse, ${stop === 'added' ? 'add' : 'keep'} Stop hook in ${settingsPath}`,
    );
  }

  const mcp = opts.skipMcpRegistration
    ? ({ action: 'skipped', detail: 'skipped by caller' } as const)
    : registerMcp(opts.nodePath, opts.cliScriptPath, opts.dryRun, opts.logger);

  return { mcp, hooks: { userPromptSubmit, postToolUse, stop }, backupPath };
}

export function uninstallClaudeIntegration(
  opts: ClaudeInstallOptions,
): ClaudeInstallResult {
  const settingsPath = join(opts.claudeDir, 'settings.json');
  const settings = readSettings(settingsPath);

  const usCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit');
  const ptCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use');
  const stopCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'stop');

  const removedUs = removeHook(settings, EVENT_USER_PROMPT_SUBMIT, usCmd);
  const removedPt = removeHook(settings, EVENT_POST_TOOL_USE, ptCmd);
  const removedStop = removeHook(settings, EVENT_STOP, stopCmd);

  let backupPath: string | undefined;
  if (!opts.dryRun && (removedUs || removedPt || removedStop)) {
    const backup = writeSettings(settingsPath, settings);
    if (backup) backupPath = backup;
  }

  const mcp = opts.skipMcpRegistration
    ? ({ action: 'skipped', detail: 'skipped by caller' } as const)
    : unregisterMcp(opts.dryRun, opts.logger);

  return {
    mcp,
    hooks: {
      userPromptSubmit: removedUs ? 'added' : 'unchanged',
      postToolUse: removedPt ? 'added' : 'unchanged',
      stop: removedStop ? 'added' : 'unchanged',
    },
    backupPath,
  };
}
