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
  status:
    | 'ok'
    | 'dry-run'
    | 'not-found'
    | 'gh-missing'
    | 'gh-unauthed'
    | 'visibility-private'
    | 'failed';
  detail?: string;
  prUrl?: string;
  plannedSteps?: string[];
}

interface OwnedEntry {
  id: string;
  title: string;
  absPath: string;
  relPath: string;
  visibility: string;
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

  if (owned.visibility === 'private') {
    return {
      status: 'visibility-private',
      detail: `entry id=${opts.id} has visibility: private and cannot be pushed to the public community DB. Update the entry to visibility: public first (the user declared this entry local-only).`,
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
    runOrThrow('git', ['checkout', '-b', branch], { cwd: stagingDir });

    const destPath = join(stagingDir, 'entries', owned.relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(owned.absPath, destPath);

    runOrThrow('git', ['add', join('entries', owned.relPath)], { cwd: stagingDir });

    const isUpdate = upstreamAlreadyHas(stagingDir, 'entries/' + owned.relPath);
    const verb = isUpdate ? 'update' : 'add';
    const commitMsg = `${verb}: ${owned.title}`;
    runOrThrow('git', ['commit', '-m', commitMsg], { cwd: stagingDir });
    runOrThrow('git', ['push', '--set-upstream', 'origin', branch], { cwd: stagingDir });

    const prTitle = `${verb}: ${owned.title}`;
    const prBody = [
      `Contribution of caveat \`${owned.id}\` via \`caveat push\`.`,
      '',
      `- entry path: \`entries/${owned.relPath}\``,
      `- action: ${verb}`,
      '',
      "Merged PRs will appear in subscribers' repos on their next `caveat pull`.",
    ].join('\n');

    const pr = runCapture(
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
    if (pr.status !== 0) {
      return {
        status: 'failed',
        detail: (pr.stderr || 'gh pr create failed').trim(),
      };
    }
    return { status: 'ok', prUrl: pr.stdout.trim() };
  } catch (err) {
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Cross-platform quoting for shell: true single-string invocation. We control
 * every input (no user-supplied values), so only whitespace and shell
 * metacharacters need wrapping. Double-quote embedded `"` by doubling for cmd
 * compatibility — not needed for our fixed inputs but keeps the helper honest.
 */
function shellQuote(s: string): string {
  if (!/[\s&|<>^()"`$!*?\[\]{}\\]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Invoke a command via the platform shell, passing a single command string so
 * Node 24's "shell: true + args array" deprecation does not fire. Also lets
 * Windows resolve `.cmd` shims (gh.cmd, git.cmd) without explicit extensions.
 */
function runCapture(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): SpawnResult {
  const line = [command, ...args].map(shellQuote).join(' ');
  const r = spawnSync(line, {
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

function runOrThrow(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): void {
  const r = runCapture(command, args, opts);
  if (r.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(r.stderr || r.stdout || 'unknown').trim()}`,
    );
  }
}

function checkGhAvailable(): boolean {
  return runCapture('gh', ['--version']).status === 0;
}

function checkGhAuthed(): boolean {
  return runCapture('gh', ['auth', 'status']).status === 0;
}

function resolveGhUser(): string | undefined {
  const r = runCapture('gh', ['api', 'user', '--jq', '.login']);
  if (r.status !== 0) return undefined;
  return r.stdout.trim() || undefined;
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
          return {
            id,
            title: parsed.frontmatter.title,
            absPath,
            relPath,
            visibility: parsed.frontmatter.visibility,
          };
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
  runCapture('gh', ['repo', 'fork', `${owner}/${repo}`, '--clone=false', '--remote=false']);
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
    runOrThrow('git', ['clone', '--depth', '30', forkUrl, stagingDir]);
    runOrThrow(
      'git',
      ['remote', 'add', 'upstream', `https://github.com/${upstreamOwner}/${sharedName}.git`],
      { cwd: stagingDir },
    );
  } else {
    runOrThrow('git', ['checkout', 'main'], { cwd: stagingDir });
    runOrThrow('git', ['fetch', 'upstream', 'main'], { cwd: stagingDir });
    runOrThrow('git', ['reset', '--hard', 'upstream/main'], { cwd: stagingDir });
    runOrThrow('git', ['push', 'origin', 'main', '--force-with-lease'], { cwd: stagingDir });
  }
}

function upstreamAlreadyHas(stagingDir: string, relFromRoot: string): boolean {
  return existsSync(join(stagingDir, relFromRoot));
}
