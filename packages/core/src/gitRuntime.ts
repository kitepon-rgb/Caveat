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
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
  const options: Partial<SimpleGitOptions> = {
    timeout: { block: opts?.timeoutMs ?? FOREGROUND_GIT_TIMEOUT_MS },
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
