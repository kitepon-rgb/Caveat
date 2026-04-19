import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Logger } from './db.js';
import { parseMarkdown } from './frontmatter.js';
import { validateCommunityUrl } from './community.js';

export interface PushEntryOptions {
  /** Absolute path to the user's `entries/` dir (source = 'own'). */
  entriesDir: string;
  /** Absolute path to a directory where the fork clone can be staged. */
  caveatHome: string;
  /** URL of the shared knowledge repo (from config.sharedRepo). */
  sharedRepoUrl: string;
  /** Entry id (from frontmatter) — must match a file under entriesDir. */
  id: string;
  /** If true, compute the plan but make no GitHub or git changes. */
  dryRun?: boolean;
  logger: Logger;
}

export interface PushEntryResult {
  status: 'ok' | 'dry-run' | 'not-found' | 'gh-missing' | 'gh-unauthed' | 'failed';
  detail?: string;
  prUrl?: string;
  plannedSteps?: string[];
}

interface OwnedEntry {
  id: string;
  title: string;
  absPath: string;
  relPath: string;
}

export async function pushEntry(opts: PushEntryOptions): Promise<PushEntryResult> {
  if (!checkGhAvailable()) {
    return {
      status: 'gh-missing',
      detail: 'gh (GitHub CLI) is required. Install: https://cli.github.com/',
    };
  }
  if (!checkGhAuthed()) {
    return {
      status: 'gh-unauthed',
      detail: 'gh is not authenticated. Run `gh auth login`.',
    };
  }

  const validation = validateCommunityUrl(opts.sharedRepoUrl);
  if (!validation.valid) {
    return { status: 'failed', detail: `sharedRepo URL invalid: ${validation.reason}` };
  }
  const [sharedOwner, sharedName] = parseOwnerRepo(opts.sharedRepoUrl);
  if (!sharedOwner || !sharedName) {
    return { status: 'failed', detail: `cannot parse owner/repo from ${opts.sharedRepoUrl}` };
  }

  const owned = findOwnedEntry(opts.entriesDir, opts.id);
  if (!owned) {
    return {
      status: 'not-found',
      detail: `entry id=${opts.id} not found under ${opts.entriesDir}`,
    };
  }

  const ghUser = resolveGhUser();
  if (!ghUser) {
    return { status: 'failed', detail: 'gh api user failed' };
  }

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      plannedSteps: [
        `fork ${sharedOwner}/${sharedName} as ${ghUser}/${sharedName}`,
        `clone fork → ${forkStagingDir(opts.caveatHome)}`,
        `copy entry → entries/${owned.relPath}`,
        'commit, push branch, open PR against main',
      ],
    };
  }

  try {
    ensureFork(sharedOwner, sharedName);
    const stagingDir = forkStagingDir(opts.caveatHome);
    ensureStagingClone(stagingDir, ghUser, sharedName, sharedOwner);

    const branch = `caveat-push-${owned.id}-${Date.now().toString(36)}`;
    run('git', ['checkout', '-b', branch], { cwd: stagingDir });

    const destPath = join(stagingDir, 'entries', owned.relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(owned.absPath, destPath);

    run('git', ['add', join('entries', owned.relPath)], { cwd: stagingDir });

    const isUpdate = upstreamAlreadyHas(stagingDir, 'entries/' + owned.relPath);
    const verb = isUpdate ? 'update' : 'add';
    const commitMsg = `${verb}: ${owned.title}`;
    run('git', ['commit', '-m', commitMsg], { cwd: stagingDir });
    run('git', ['push', '--set-upstream', 'origin', branch], { cwd: stagingDir });

    const prTitle = `${verb}: ${owned.title}`;
    const prBody = [
      `Contribution of caveat \`${owned.id}\` via \`caveat push\`.`,
      '',
      `- entry path: \`entries/${owned.relPath}\``,
      `- action: ${verb}`,
      '',
      "Merged PRs will appear in subscribers' repos on their next `caveat pull`.",
    ].join('\n');

    const pr = spawnSync(
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
      { cwd: stagingDir, encoding: 'utf-8', shell: true },
    );
    if (pr.status !== 0) {
      return {
        status: 'failed',
        detail: (typeof pr.stderr === 'string' ? pr.stderr : String(pr.stderr ?? ''))
          .trim() || 'gh pr create failed',
      };
    }
    const prUrl = (typeof pr.stdout === 'string' ? pr.stdout : String(pr.stdout ?? ''))
      .trim();
    return { status: 'ok', prUrl };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkGhAvailable(): boolean {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf-8', shell: true });
  return r.status === 0;
}

function checkGhAuthed(): boolean {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8', shell: true });
  return r.status === 0;
}

function resolveGhUser(): string | undefined {
  const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf-8',
    shell: true,
  });
  if (r.status !== 0) return undefined;
  return typeof r.stdout === 'string' ? r.stdout.trim() : '';
}

function parseOwnerRepo(url: string): [string | undefined, string | undefined] {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url);
  if (!m) return [undefined, undefined];
  return [m[1], m[2]];
}

function findOwnedEntry(entriesDir: string, id: string): OwnedEntry | undefined {
  if (!existsSync(entriesDir)) return undefined;
  for (const categoryDirent of readdirSync(entriesDir, { withFileTypes: true })) {
    if (!categoryDirent.isDirectory()) continue;
    const categoryDir = join(entriesDir, categoryDirent.name);
    for (const fileDirent of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!fileDirent.isFile() || !fileDirent.name.endsWith('.md')) continue;
      const absPath = join(categoryDir, fileDirent.name);
      const raw = readFileSync(absPath, 'utf-8');
      try {
        const parsed = parseMarkdown(raw);
        if (parsed.frontmatter.id === id) {
          const relPath = relative(entriesDir, absPath).replace(/\\/g, '/');
          return { id, title: parsed.frontmatter.title, absPath, relPath };
        }
      } catch {
        // ignore unparseable
      }
    }
  }
  return undefined;
}

function forkStagingDir(caveatHome: string): string {
  return join(caveatHome, 'push-fork');
}

function ensureFork(owner: string, repo: string): void {
  // Idempotent via gh: "already exists" message on stderr if the fork exists.
  spawnSync(
    'gh',
    ['repo', 'fork', `${owner}/${repo}`, '--clone=false', '--remote=false'],
    { encoding: 'utf-8', shell: true },
  );
}

function ensureStagingClone(
  stagingDir: string,
  ghUser: string,
  sharedName: string,
  upstreamOwner: string,
): void {
  if (!existsSync(stagingDir)) {
    mkdirSync(dirname(stagingDir), { recursive: true });
    const forkUrl = `https://github.com/${ghUser}/${sharedName}.git`;
    run('git', ['clone', '--depth', '30', forkUrl, stagingDir]);
    run(
      'git',
      ['remote', 'add', 'upstream', `https://github.com/${upstreamOwner}/${sharedName}.git`],
      { cwd: stagingDir },
    );
  } else {
    run('git', ['checkout', 'main'], { cwd: stagingDir });
    run('git', ['fetch', 'upstream', 'main'], { cwd: stagingDir });
    run('git', ['reset', '--hard', 'upstream/main'], { cwd: stagingDir });
    run('git', ['push', 'origin', 'main', '--force-with-lease'], { cwd: stagingDir });
  }
}

function upstreamAlreadyHas(stagingDir: string, relFromRoot: string): boolean {
  return existsSync(join(stagingDir, relFromRoot));
}

function run(command: string, args: string[], opts: { cwd?: string } = {}): void {
  const r = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: opts.cwd,
    shell: true,
  });
  if (r.status !== 0) {
    const stderr = typeof r.stderr === 'string' ? r.stderr : String(r.stderr ?? '');
    const stdout = typeof r.stdout === 'string' ? r.stdout : String(r.stdout ?? '');
    throw new Error(`${command} ${args.join(' ')} failed: ${(stderr || stdout || 'unknown').trim()}`);
  }
}
