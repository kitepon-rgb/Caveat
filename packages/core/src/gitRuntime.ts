import { parseEnv } from '@simple-git/argv-parser';
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';

// simple-git timeout.block is an inactivity timeout: the git process is killed
// only after stdout/stderr have been silent for this long. It is not a total
// elapsed-time cap. Foreground CLI work gets enough room for large clone/push.
export const FOREGROUND_GIT_TIMEOUT_MS = 300_000;

// simple-git timeout.block is an inactivity timeout, not a total elapsed-time
// cap. Background hook workers should give up quickly and retry on a later
// opportunity instead of hanging a detached process indefinitely.
export const BACKGROUND_GIT_TIMEOUT_MS = 30_000;

export function createGit(baseDir?: string, opts?: { timeoutMs?: number }): SimpleGit {
  const timeoutMs = opts?.timeoutMs ?? FOREGROUND_GIT_TIMEOUT_MS;
  const lowSpeedTimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    // Git's GIT_HTTP_LOW_SPEED_* environment variables override the matching
    // config keys. Set both after inherited env so a caller cannot silently
    // disable the helper-side no-response bound.
    GIT_HTTP_LOW_SPEED_LIMIT: '1',
    GIT_HTTP_LOW_SPEED_TIME: String(lowSpeedTimeSeconds),
  };
  const options: Partial<SimpleGitOptions> = {
    maxConcurrentProcesses: 1,
    timeout: { block: timeoutMs },
    // On Windows, killing the direct `git` child does not necessarily kill its
    // `git-remote-http` descendant. This HTTP transfer-rate bound is a
    // helper-side supplement for a server that stops responding; it is not a
    // general process-tree or total elapsed-time guarantee.
    config: [
      'http.lowSpeedLimit=1',
      `http.lowSpeedTime=${lowSpeedTimeSeconds}`,
    ],
    unsafe: unsafeAllowancesForInheritedEnv(env),
  };
  const git = baseDir === undefined ? simpleGit(options) : simpleGit(baseDir, options);
  return git.env(env);
}

function unsafeAllowancesForInheritedEnv(env: NodeJS.ProcessEnv): Partial<NonNullable<SimpleGitOptions['unsafe']>> {
  const unsafe: Partial<NonNullable<SimpleGitOptions['unsafe']>> = {};
  // Derive allowances from the same parser used by simple-git's
  // blockUnsafeOperationsPlugin when it spawns git. This keeps presence checks,
  // environment-key normalization, and GIT_CONFIG_KEY_n category detection in
  // sync with simple-git as @simple-git/argv-parser changes.
  for (const vulnerability of parseEnv(env).vulnerabilities) {
    unsafe[vulnerability.category] = true;
  }
  return unsafe;
}
