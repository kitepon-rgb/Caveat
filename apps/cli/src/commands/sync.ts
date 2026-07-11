import { spawnSync } from 'node:child_process';
import { readSync } from 'node:fs';
import { syncOwn, initOwnSync } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface GhRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[]) => GhRunResult;

export interface SyncCmdOptions {
  init?: boolean | string;
  repo?: string;
  dryRun: boolean;
  trustRemotePrivate: boolean;
  yes: boolean;
}

export interface SyncCmdDependencies {
  ghRunner?: GhRunner;
  isTty?: () => boolean;
  confirm?: (question: string) => boolean;
}

function runGh(args: string[]): GhRunResult {
  const result = spawnSync('gh', args, { encoding: 'utf-8' });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function commandError(result: GhRunResult, fallback: string): Error {
  return new Error((result.stderr || result.stdout || fallback).trim());
}

function askOnce(question: string): boolean {
  process.stdout.write(`${question} `);
  // Read a single chunk instead of until-EOF: on a TTY in canonical mode this
  // returns after one line, whereas readFileSync(0) would block until Ctrl-D.
  const buf = Buffer.alloc(256);
  const bytes = readSync(0, buf, 0, buf.length, null);
  return /^(?:y|yes)$/i.test(buf.toString('utf-8', 0, bytes).trim());
}

async function defaultPrivateRepoUrl(
  opts: SyncCmdOptions,
  deps: Required<Pick<SyncCmdDependencies, 'ghRunner' | 'isTty' | 'confirm'>>,
): Promise<string> {
  const version = deps.ghRunner(['--version']);
  if (version.status !== 0) {
    throw new Error(
      'gh is not available. create a private repository named Caveat-Private on GitHub, then run:\n' +
      '  caveat sync --init <url>\n' +
      '  # or install gh and run caveat sync --init',
    );
  }
  const user = deps.ghRunner(['api', 'user', '-q', '.login']);
  if (user.status !== 0 || !user.stdout.trim()) {
    throw new Error('gh is not authenticated; run `gh auth login`, then retry `caveat sync --init`');
  }
  const login = user.stdout.trim();
  const name = `${login}/Caveat-Private`;
  const view = deps.ghRunner(['repo', 'view', name]);
  if (view.status !== 0) {
    const question = `create private repo github.com/${name}? [y/N]`;
    if (!opts.yes) {
      if (!deps.isTty()) {
        throw new Error(`${question}; rerun with --yes to approve non-interactively`);
      }
      if (!deps.confirm(question)) throw new Error('private repository creation cancelled');
    }
    const create = deps.ghRunner(['repo', 'create', 'Caveat-Private', '--private']);
    if (create.status !== 0) throw commandError(create, 'gh repo create failed');
  }
  return `https://github.com/${name}.git`;
}

export async function runSync(
  ctx: CliContext,
  opts: SyncCmdOptions,
  dependencies: SyncCmdDependencies = {},
): Promise<void> {
  try {
    const ghRunner = dependencies.ghRunner ?? runGh;
    const isTty = dependencies.isTty ?? (() => Boolean(process.stdin.isTTY));
    const confirm = dependencies.confirm ?? askOnce;
    const initValue = opts.init;
    if (initValue !== undefined && initValue !== false) {
      const url = opts.repo ?? (typeof initValue === 'string' ? initValue : await defaultPrivateRepoUrl(opts, { ghRunner, isTty, confirm }));
      const result = await initOwnSync({
        ownDir: ctx.paths.knowledgeRepo,
        url,
        caveatHome: ctx.caveatHome,
        paths: ctx.paths,
        logger: ctx.logger,
        trustRemotePrivate: opts.trustRemotePrivate,
      });
      ctx.logger.info(
        result.remoteWasEmpty
          ? `initialized private sync remote: ${url}`
          : `checked out existing private remote: ${url} (branch ${result.branch})`,
      );
      return;
    }
    if (opts.repo) throw new Error('--repo requires --init');
    const result = await syncOwn({
      ownDir: ctx.paths.knowledgeRepo,
      caveatHome: ctx.caveatHome,
      paths: ctx.paths,
      logger: ctx.logger,
      trustRemotePrivate: opts.trustRemotePrivate,
      dryRun: opts.dryRun,
    });
    if (result.dryRun) {
      ctx.logger.info(
        `[dry-run] ${result.changedFiles} local change(s) pending; remote ${result.pushUrls.join(', ')} (${result.probe.kind})`,
      );
    } else {
      const rebased = result.pulled ? ', rebased onto remote' : '';
      ctx.logger.info(`synced ${result.branch} → origin (${result.changedFiles} local change(s)${rebased})`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error(message);
    process.exitCode = 1;
  }
}
