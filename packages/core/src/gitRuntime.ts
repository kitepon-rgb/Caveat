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
  if (env.PAGER || env.GIT_PAGER) unsafe.allowUnsafePager = true;
  if (env.EDITOR || env.GIT_EDITOR || env.GIT_SEQUENCE_EDITOR) unsafe.allowUnsafeEditor = true;
  if (env.GIT_ASKPASS || env.SSH_ASKPASS) unsafe.allowUnsafeAskPass = true;
  if (env.GIT_CONFIG_COUNT) unsafe.allowUnsafeConfigEnvCount = true;
  if (env.GIT_CONFIG || env.GIT_CONFIG_GLOBAL || env.GIT_CONFIG_SYSTEM || env.GIT_EXEC_PATH || env.PREFIX) {
    unsafe.allowUnsafeConfigPaths = true;
  }
  if (env.GIT_EXTERNAL_DIFF) unsafe.allowUnsafeDiffExternal = true;
  if (env.GIT_PROXY_COMMAND) unsafe.allowUnsafeGitProxy = true;
  if (env.GIT_SSH || env.GIT_SSH_COMMAND) unsafe.allowUnsafeSshCommand = true;
  if (env.GIT_TEMPLATE_DIR) unsafe.allowUnsafeTemplateDir = true;
  return unsafe;
}
