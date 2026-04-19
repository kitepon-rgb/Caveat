import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseMarkdown, validateCommunityUrl } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface PushOptions {
  id: string;
  dryRun: boolean;
}

interface OwnedEntry {
  id: string;
  title: string;
  absPath: string;
  relPath: string;
}

export async function runPush(ctx: CliContext, opts: PushOptions): Promise<void> {
  const ghOk = checkGhAvailable(ctx);
  if (!ghOk) return;

  const sharedValidation = validateCommunityUrl(ctx.config.sharedRepo);
  if (!sharedValidation.valid) {
    ctx.logger.error(
      `sharedRepo is not a valid GitHub URL: ${ctx.config.sharedRepo} (${sharedValidation.reason})`,
    );
    process.exitCode = 1;
    return;
  }
  const [sharedOwner, sharedName] = parseOwnerRepo(ctx.config.sharedRepo);
  if (!sharedOwner || !sharedName) {
    ctx.logger.error(`cannot parse sharedRepo owner/repo: ${ctx.config.sharedRepo}`);
    process.exitCode = 1;
    return;
  }

  const owned = findOwnedEntry(ctx, opts.id);
  if (!owned) {
    ctx.logger.error(
      `entry not found in ${ctx.paths.entriesDir}: id=${opts.id}. ` +
        "List with `caveat list`, or write the md file and index first.",
    );
    process.exitCode = 1;
    return;
  }

  const ghUser = resolveGhUser(ctx);
  if (!ghUser) return;

  if (opts.dryRun) {
    ctx.logger.info(`[dry-run] would push entry ${owned.id} (${owned.title})`);
    ctx.logger.info(`[dry-run]   1. fork ${sharedOwner}/${sharedName} as ${ghUser}/${sharedName}`);
    ctx.logger.info(`[dry-run]   2. clone fork → ${forkStagingDir(ctx)}`);
    ctx.logger.info(`[dry-run]   3. copy entry → entries/${owned.relPath}`);
    ctx.logger.info('[dry-run]   4. commit, push branch, open PR against main');
    return;
  }

  // 1. Ensure the user has a fork
  ensureFork(ctx, sharedOwner, sharedName, ghUser);

  // 2. Ensure local fork clone
  const stagingDir = forkStagingDir(ctx);
  ensureStagingClone(ctx, stagingDir, ghUser, sharedName, sharedOwner);

  // 3. Create feature branch
  const branch = `caveat-push-${owned.id}-${Date.now().toString(36)}`;
  run(ctx, 'git', ['checkout', '-b', branch], { cwd: stagingDir });

  // 4. Copy entry
  const destPath = join(stagingDir, 'entries', owned.relPath);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(owned.absPath, destPath);

  // 5. Commit
  run(ctx, 'git', ['add', join('entries', owned.relPath)], { cwd: stagingDir });
  const verb = existsInUpstream(stagingDir, 'entries/' + owned.relPath) ? 'update' : 'add';
  const commitMsg = `${verb}: ${owned.title}`;
  run(ctx, 'git', ['commit', '-m', commitMsg], { cwd: stagingDir });

  // 6. Push branch to fork
  run(ctx, 'git', ['push', '--set-upstream', 'origin', branch], { cwd: stagingDir });

  // 7. Open PR against upstream
  const prTitle = `${verb}: ${owned.title}`;
  const prBody = [
    `Contribution of caveat \`${owned.id}\` via \`caveat push\`.`,
    '',
    `- entry path: \`entries/${owned.relPath}\``,
    `- action: ${verb}`,
    '',
    'Merged PRs will appear in subscribers\' repos on their next `caveat pull`.',
  ].join('\n');
  const prResult = runClaim(
    ctx,
    'gh',
    [
      'pr',
      'create',
      '--repo',
      `${sharedOwner}/${sharedName}`,
      '--base',
      'main',
      '--head',
      `${ghUser}:${branch}`,
      '--title',
      prTitle,
      '--body',
      prBody,
    ],
    { cwd: stagingDir },
  );
  if (prResult.status === 0) {
    const url = prResult.stdout.trim();
    ctx.logger.info(`PR opened: ${url}`);
    ctx.logger.info(
      'Once merged, other subscribers will see your entry after their next `caveat pull`.',
    );
  } else {
    ctx.logger.error(
      `gh pr create failed: ${(prResult.stderr || prResult.stdout || '').trim()}`,
    );
    process.exitCode = 1;
  }
}

function checkGhAvailable(ctx: CliContext): boolean {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf-8', shell: true });
  if (r.status !== 0) {
    ctx.logger.error(
      'gh (GitHub CLI) is required for `caveat push`. Install: https://cli.github.com/',
    );
    process.exitCode = 1;
    return false;
  }
  const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8', shell: true });
  if (auth.status !== 0) {
    ctx.logger.error('gh is not authenticated. Run `gh auth login` first.');
    process.exitCode = 1;
    return false;
  }
  return true;
}

function resolveGhUser(ctx: CliContext): string | undefined {
  const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf-8',
    shell: true,
  });
  if (r.status !== 0) {
    ctx.logger.error(`gh api user failed: ${(r.stderr || r.stdout).trim()}`);
    process.exitCode = 1;
    return undefined;
  }
  return r.stdout.trim();
}

function parseOwnerRepo(url: string): [string | undefined, string | undefined] {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url);
  if (!m) return [undefined, undefined];
  return [m[1], m[2]];
}

function findOwnedEntry(ctx: CliContext, id: string): OwnedEntry | undefined {
  if (!existsSync(ctx.paths.entriesDir)) return undefined;
  for (const categoryDirent of readdirSync(ctx.paths.entriesDir, { withFileTypes: true })) {
    if (!categoryDirent.isDirectory()) continue;
    const categoryDir = join(ctx.paths.entriesDir, categoryDirent.name);
    for (const fileDirent of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!fileDirent.isFile() || !fileDirent.name.endsWith('.md')) continue;
      const absPath = join(categoryDir, fileDirent.name);
      const raw = readFileSync(absPath, 'utf-8');
      try {
        const parsed = parseMarkdown(raw);
        if (parsed.frontmatter.id === id) {
          const relPath = relative(ctx.paths.entriesDir, absPath).replace(/\\/g, '/');
          return {
            id,
            title: parsed.frontmatter.title,
            absPath,
            relPath,
          };
        }
      } catch {
        // ignore unparseable
      }
    }
  }
  return undefined;
}

function forkStagingDir(ctx: CliContext): string {
  return join(ctx.caveatHome, 'push-fork');
}

function ensureFork(
  ctx: CliContext,
  owner: string,
  repo: string,
  ghUser: string,
): void {
  // `gh repo fork` is idempotent: if the fork already exists, it returns success
  // and prints "already exists". The --clone=false + --remote=false flags keep
  // this purely a GitHub-side action.
  const r = spawnSync(
    'gh',
    ['repo', 'fork', `${owner}/${repo}`, '--clone=false', '--remote=false'],
    { encoding: 'utf-8', shell: true },
  );
  if (r.status !== 0 && !(r.stderr || '').includes('already exists')) {
    ctx.logger.warn(`gh repo fork stderr: ${r.stderr.trim()}`);
  }
  // Don't fail hard; the subsequent clone of ghUser/repo is the real gate.
  void ghUser;
}

function ensureStagingClone(
  ctx: CliContext,
  stagingDir: string,
  ghUser: string,
  sharedName: string,
  upstreamOwner: string,
): void {
  if (!existsSync(stagingDir)) {
    mkdirSync(dirname(stagingDir), { recursive: true });
    const forkUrl = `https://github.com/${ghUser}/${sharedName}.git`;
    run(ctx, 'git', ['clone', '--depth', '30', forkUrl, stagingDir]);
    run(ctx, 'git', ['remote', 'add', 'upstream', `https://github.com/${upstreamOwner}/${sharedName}.git`], {
      cwd: stagingDir,
    });
  } else {
    // Sync fork main with upstream before branching.
    run(ctx, 'git', ['checkout', 'main'], { cwd: stagingDir });
    run(ctx, 'git', ['fetch', 'upstream', 'main'], { cwd: stagingDir });
    run(ctx, 'git', ['reset', '--hard', 'upstream/main'], { cwd: stagingDir });
    run(ctx, 'git', ['push', 'origin', 'main', '--force-with-lease'], { cwd: stagingDir });
  }
}

function existsInUpstream(stagingDir: string, relFromRoot: string): boolean {
  return existsSync(join(stagingDir, relFromRoot));
}

function run(
  ctx: CliContext,
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): void {
  const r = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: opts.cwd,
    shell: true,
  });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || 'unknown').trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${msg}`);
  }
}

function runClaim(
  ctx: CliContext,
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: opts.cwd,
    shell: true,
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
}

// Silence TS unused-param warning for `statSync` (used elsewhere if extended).
void statSync;
