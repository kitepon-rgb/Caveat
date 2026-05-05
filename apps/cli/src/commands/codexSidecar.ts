import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cwd, exit } from 'node:process';
import {
  buildCodexSidecarDiagnosticsCommand,
  buildCodexSidecarReadOnlySmokeCommand,
  buildCodexSidecarRunCommand,
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
    writeFileSync(contextFile, JSON.stringify({ context: blocks }, null, 2) + '\n', 'utf-8');

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
