import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cwd, exit } from 'node:process';
import type { Stats } from 'node:fs';
import {
  buildCodexSidecarDiagnosticsCommand,
  buildCodexSidecarReadOnlySmokeCommand,
  buildCodexSidecarRunCommand,
  buildHookSignalSidecarContextBlock,
  caveatEntriesToSidecarContextBlocks,
  decideCodexSidecarExecution,
  get,
  markHit,
  openDb,
  search,
  type CodexSidecarCliSpec,
  type CodexSidecarAvailability,
  type CodexSidecarAgentSetting,
  type CodexSidecarWorkflow,
  type CaveatHookSignalSidecarContextBlock,
  type CaveatHostAgent,
  type Logger,
  type SearchFilters,
  type Source,
} from '@caveat/core';
import type { CliContext } from '../context.js';

export interface CodexSidecarCliOptions {
  project?: string;
  preset?: string;
  command?: string;
  nodeCli?: string;
  saveResult?: string;
}

export interface CodexSidecarRunOptions extends CodexSidecarCliOptions {
  query?: string;
  limit?: number;
  source?: 'own' | 'community' | 'all';
  visibility?: 'public' | 'private' | 'all';
  hostAgent?: CaveatHostAgent;
  availability?: CodexSidecarAvailability;
  sidecarAgent?: CodexSidecarAgentSetting;
  requiresIsolation?: boolean;
  structuredResultRequired?: boolean;
  explicitSecondPass?: boolean;
  additionalContextFile?: string;
}

export function runCodexSidecarDiagnostics(
  logger: Logger,
  opts: CodexSidecarCliOptions,
): void {
  const plan = buildCodexSidecarDiagnosticsCommand({
    projectRoot: opts.project ?? cwd(),
    preset: opts.preset ?? 'review',
    cli: cliSpec(opts),
  });
  exit(executePlan(logger, plan.command, plan.args, { saveResult: opts.saveResult }));
}

export function runCodexSidecarSmoke(logger: Logger, opts: CodexSidecarCliOptions): void {
  const plan = buildCodexSidecarReadOnlySmokeCommand({
    projectRoot: opts.project ?? cwd(),
    preset: opts.preset === 'review' || opts.preset === 'opinion' || opts.preset === 'risk'
      ? opts.preset
      : 'explore',
    cli: cliSpec(opts),
  });
  exit(executePlan(logger, plan.command, plan.args, { saveResult: opts.saveResult }));
}

export function runCodexSidecarWithCaveats(
  ctx: CliContext,
  workflow: CodexSidecarWorkflow,
  prompt: string | undefined,
  opts: CodexSidecarRunOptions,
): void {
  const decision = decideCodexSidecarExecution({
    hostAgent: opts.hostAgent ?? 'unknown',
    availability: opts.availability ?? 'operational',
    workflow,
    sidecarAgent: opts.sidecarAgent,
    requiresIsolation: opts.requiresIsolation,
    structuredResultRequired: opts.structuredResultRequired,
    explicitSecondPass: opts.explicitSecondPass,
  });

  if (!decision.useSidecar) {
    process.stdout.write(JSON.stringify({ status: 'skipped', decision }, null, 2) + '\n');
    exit(0);
  }

  const contextDir = mkdtempSync(join(tmpdir(), 'caveat-sidecar-context-'));
  const contextFile = join(contextDir, 'context.json');
  let status = 1;
  try {
    const blocks = collectCaveatContextBlocks(ctx, {
      query: opts.query ?? prompt ?? '',
      limit: opts.limit ?? 5,
      source: opts.source,
      visibility: opts.visibility,
    });
    const additionalBlocks = opts.additionalContextFile
      ? readHookSignalAdditionalContextFile(opts.additionalContextFile)
      : [];
    writeFileSync(contextFile, JSON.stringify({ context: [...blocks, ...additionalBlocks] }, null, 2) + '\n', 'utf-8');

    const plan = buildCodexSidecarRunCommand({
      workflow,
      projectRoot: opts.project ?? cwd(),
      preset: opts.preset ?? defaultPreset(workflow),
      prompt,
      contextFile,
      cli: cliSpec(opts),
    });

    status = executePlan(ctx.logger, plan.command, plan.args, { saveResult: opts.saveResult });
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
  exit(status);
}

const MAX_ADDITIONAL_CONTEXT_BYTES = 4096;

export function readHookSignalAdditionalContextFile(
  path: string,
  testProbe?: { afterLstat?: () => void },
): CaveatHookSignalSidecarContextBlock[] {
  const before = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  assertPrivateRegular(before, uid);
  // Test-only scheduling seam for deterministic inode/FIFO replacement tests.
  // Production callers never pass it; the actual trust decision still binds
  // the opened fd to `before.dev` + `before.ino` below.
  testProbe?.afterLstat?.();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  let raw: string;
  try {
    const opened = fstatSync(fd);
    assertPrivateRegular(opened, uid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('additional context file changed during open');
    const bytes = Buffer.alloc(MAX_ADDITIONAL_CONTEXT_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (read === 0) break;
      count += read;
    }
    if (count > MAX_ADDITIONAL_CONTEXT_BYTES) throw new Error(`additional context file exceeds ${MAX_ADDITIONAL_CONTEXT_BYTES} bytes`);
    const after = fstatSync(fd);
    assertPrivateRegular(after, uid);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.dev !== before.dev || after.ino !== before.ino) throw new Error('additional context file changed during read');
    raw = bytes.subarray(0, count).toString('utf-8');
  } finally { closeSync(fd); }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.context) || parsed.context.length !== 1) {
    throw new Error('additional context file must contain exactly one context block');
  }
  const block = parsed.context[0];
  if (!isHookSignalBlock(block)) {
    throw new Error('additional context file contains an invalid hook signal block');
  }
  return [block];
}

function assertPrivateRegular(stat: Stats, uid: number | undefined): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ADDITIONAL_CONTEXT_BYTES || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) throw new Error('additional context file must be a private owner-only regular file within 4096 bytes');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHookSignalBlock(value: unknown): value is CaveatHookSignalSidecarContextBlock {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'source', 'trust', 'summary', 'data']) || value.kind !== 'manual_note' || value.source !== 'caveat-hook-signal' || value.trust !== 'local' || typeof value.summary !== 'string' || !isRecord(value.data)) return false;
  const data = value.data;
  if (data.type === 'tool-error') {
    if (!hasExactKeys(data, ['type', 'tool', 'failure_kind']) || typeof data.tool !== 'string' || (data.failure_kind !== 'post-tool-use-failure' && data.failure_kind !== 'error-bearing-post-tool-use')) return false;
    const canonical = buildHookSignalFromData(data);
    return canonical !== null && JSON.stringify(value) === JSON.stringify(canonical);
  }
  if (!hasExactKeys(data, ['type', 'tool_failure_count', 'reedited_file_count', 'web_search_count', 'web_fetch_count', 'bash_retry_count', 'duration_minutes'])) return false;
  const canonical = buildHookSignalFromData(data);
  return canonical !== null && JSON.stringify(value) === JSON.stringify(canonical);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys.slice().sort()[index]);
}

function buildHookSignalFromData(data: Record<string, unknown>): CaveatHookSignalSidecarContextBlock | null {
  if (data.type === 'tool-error') {
    const validTools = ['bash', 'edit', 'write', 'read', 'glob', 'grep', 'web-search', 'web-fetch', 'notebook-edit', 'other'];
    if (!validTools.includes(String(data.tool))) return null;
    const toolNames: Record<string, string> = { bash: 'Bash', edit: 'Edit', write: 'Write', read: 'Read', glob: 'Glob', grep: 'Grep', 'web-search': 'WebSearch', 'web-fetch': 'WebFetch', 'notebook-edit': 'NotebookEdit', other: 'other' };
    return buildHookSignalSidecarContextBlock({ type: 'tool-error', toolName: toolNames[String(data.tool)]!, failureKind: data.failure_kind as 'post-tool-use-failure' | 'error-bearing-post-tool-use' });
  }
  if (data.type !== 'stop') return null;
  const keys = ['tool_failure_count', 'reedited_file_count', 'web_search_count', 'web_fetch_count', 'bash_retry_count', 'duration_minutes'] as const;
  if (!keys.every((key) => typeof data[key] === 'number' && Number.isInteger(data[key]) && data[key] >= 0 && data[key] <= 10000)) return null;
  return buildHookSignalSidecarContextBlock({ type: 'stop', toolFailureCount: data.tool_failure_count as number, reeditedFileCount: data.reedited_file_count as number, webSearchCount: data.web_search_count as number, webFetchCount: data.web_fetch_count as number, bashRetryCount: data.bash_retry_count as number, durationMinutes: data.duration_minutes as number });
}

export function runCodexSidecarWorkSmoke(
  ctx: CliContext,
  prompt: string | undefined,
  opts: CodexSidecarCliOptions,
): void {
  const plan = buildCodexSidecarRunCommand({
    workflow: 'work',
    projectRoot: opts.project ?? cwd(),
    preset: opts.preset ?? 'work',
    prompt:
      prompt ??
      [
        'Create docs/codex-sidecar-work-smoke.md with one sentence:',
        '"codex_work smoke succeeded in an isolated worktree."',
        'Do not edit any other file.',
      ].join(' '),
    preserveWorktree: false,
    cli: cliSpec(opts),
  });
  exit(executePlan(ctx.logger, plan.command, plan.args, { saveResult: opts.saveResult }));
}

function cliSpec(opts: CodexSidecarCliOptions): CodexSidecarCliSpec {
  if (opts.nodeCli) {
    return { command: process.execPath, argsPrefix: [opts.nodeCli] };
  }
  return { command: opts.command ?? 'codex-sidecar' };
}

function collectCaveatContextBlocks(
  ctx: CliContext,
  opts: {
    query: string;
    limit: number;
    source?: 'own' | 'community' | 'all';
    visibility?: 'public' | 'private' | 'all';
  },
) {
  const filters: SearchFilters = {};
  if (opts.source) filters.source = opts.source;
  if (opts.visibility) filters.visibility = opts.visibility;

  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const hits = search(db, { query: opts.query, filters, limit: opts.limit });
    if (hits.length > 0) markHit(db, hits);
    const entries = hits
      .map((hit) => get(db, hit.id, hit.source as Source))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return caveatEntriesToSidecarContextBlocks(entries);
  } finally {
    db.close();
  }
}

function defaultPreset(workflow: CodexSidecarWorkflow): string {
  return workflow === 'risk-check' ? 'risk' : workflow;
}

function executePlan(
  logger: Logger,
  command: string,
  args: string[],
  options: { saveResult?: string } = {},
): number {
  logger.info(`[codex-sidecar] ${command} ${args.map(shellDisplayQuote).join(' ')}`);
  const result = spawnSync(command, args, { encoding: 'utf-8', stdio: 'pipe' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (options.saveResult && result.stdout) {
    saveStructuredResult(options.saveResult, result.stdout);
  }
  if (result.error) {
    logger.error(`[codex-sidecar] ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function saveStructuredResult(path: string, stdout: string): void {
  const parsed = JSON.parse(stdout) as unknown;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
}

function shellDisplayQuote(value: string): string {
  return /[\s"'$`]/.test(value) ? JSON.stringify(value) : value;
}
