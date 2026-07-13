import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendPendingReminder,
  CAVEAT_AUTO_SYNC_ENV,
  defaultSelfIdentityTokens,
  drainGlobalPendingReminders,
  drainPendingReminders,
  findCaveatsForPrompt,
  hasAnyStruggleSignal,
  logHookQueryMiss,
  markHit,
  maybeSweepPendingDirs,
  openDb,
  acquireReindexLock,
  computeEntriesDigest,
  createKeyserverKeyProvider,
  reindexAllSources,
  releaseReindexLock,
  prewarmSealedKeys,
  writeDigestMarker,
  readSessionSignals,
  runAutoSync,
  stopReminderText,
  struggleSearchText,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  buildHookSignalSidecarContextBlock,
  type CaveatHookSignalSidecarContextBlock,
  type Logger,
  type HookQuerySurface,
  type SearchResult,
  type SessionSignals,
} from '@caveat/core';
import { buildContext, type CliContext } from '../context.js';
import { maybeTriggerAutoReindex } from '../autoReindexTrigger.js';
import { maybeTriggerAutoSync } from '../autoSyncTrigger.js';
import { formatCodexSidecarAdvisory, runCodexSidecarAdvisory } from './codexSidecarAdvisory.js';

export type HookName = 'user-prompt-submit' | 'post-tool-use' | 'stop' | 'worker' | 'reindex' | 'autosync';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: (m) => process.stderr.write(`[caveat:hook] ${m}\n`),
};

const CLAUDE_MAX_CONTEXT_BLOCKS = 3;
const CLAUDE_STOP_REMINDER_PREFIX =
  '[caveat] このセッションで外部仕様の罠に当たった可能性を示すシグナル:';
const CLAUDE_STOP_STATE_DIR = 'claude-stop-state';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parsePayload(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] json parse error: ${msg}\n`);
    return {};
  }
}

function getSessionId(payload: Record<string, unknown>): string {
  const v = payload.session_id ?? payload.sessionId;
  return typeof v === 'string' && v.length > 0 ? v : '_unknown';
}

function buildContextSafely(): CliContext | null {
  try {
    return buildContext(silentLogger);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] context error: ${msg}\n`);
    return null;
  }
}

function searchCaveatsFromTextSafely(text: string, surface: HookQuerySurface): SearchResult[] {
  if (!text) return [];
  let db: DatabaseSync | undefined;
  let caveatHome: string | undefined;
  let hits: SearchResult[];
  try {
    const ctx = buildContextSafely();
    if (!ctx || !existsSync(ctx.paths.dbPath)) return [];
    caveatHome = ctx.caveatHome;
    db = openDb({ path: ctx.paths.dbPath });
    hits = findCaveatsForPrompt(db, text, {
      selfIdentity: defaultSelfIdentityTokens(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] search error: ${msg}\n`);
    return [];
  }
  if (hits.length > 0) {
    try {
      markHit(db!, hits);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[caveat:hook] markHit error: ${msg}\n`);
    }
  } else {
    try {
      logHookQueryMiss({ caveatHome: caveatHome!, agent: 'claude', surface, query: text });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[caveat:hook] query log error: ${msg}\n`);
    }
  }
  try {
    return hits;
  } finally {
    db?.close();
  }
}

function loadSignalsSafely(path: string): SessionSignals | null {
  try {
    return readSessionSignals(path);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] transcript read error: ${msg}\n`);
    return null;
  }
}

function systemReminderOutput(text: string): string {
  return `<system-reminder>${text.replace(/</g, '‹').replace(/>/g, '›')}</system-reminder>`;
}

function drainForSession(sessionId: string): string[] {
  const ctx = buildContextSafely();
  if (!ctx) return [];
  return [
    ...drainPendingReminders(ctx.caveatHome, sessionId),
    ...drainGlobalPendingReminders(ctx.caveatHome),
  ];
}

function claudeContextDedupeKey(text: string): string {
  if (text.startsWith(CLAUDE_STOP_REMINDER_PREFIX)) return 'claude-stop-reminder';
  return text.trim();
}

function compactClaudeContexts(contexts: string[]): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    const text = contexts[i]?.trim();
    if (!text) continue;
    const key = claudeContextDedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(text);
  }
  selected.reverse();
  const limited = selected.slice(-CLAUDE_MAX_CONTEXT_BLOCKS);
  const omitted =
    contexts.filter((t) => t.trim().length > 0).length - limited.length;
  if (omitted > 0) {
    limited.push(
      `[caveat] pending reminder ${omitted} 件を重複または上限により省略しました。`,
    );
  }
  return limited;
}

function sanitizeClaudeStateId(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.length > 0 ? clean : '_unknown';
}

function stopSignalKey(signals: SessionSignals, related: SearchResult[]): string {
  const body = JSON.stringify({
    toolFailureCount: signals.toolFailureCount,
    fileEditCounts: signals.fileEditCounts.map((e) => [e.path, e.count]),
    webSearchCount: signals.webSearchCount,
    webFetchCount: signals.webFetchCount,
    bashRetryCount: signals.bashRetryCount,
    searchQueries: signals.searchQueries,
    related: related.map((h) => [h.source, h.id]),
  });
  return createHash('sha256').update(body).digest('hex');
}

function stopStatePath(caveatHome: string, sessionId: string): string {
  return join(caveatHome, CLAUDE_STOP_STATE_DIR, `${sanitizeClaudeStateId(sessionId)}.txt`);
}

function wasStopReminderQueued(caveatHome: string, sessionId: string, key: string): boolean {
  const path = stopStatePath(caveatHome, sessionId);
  try {
    return readFileSync(path, 'utf-8') === key;
  } catch {
    return false;
  }
}

function markStopReminderQueued(caveatHome: string, sessionId: string, key: string): void {
  const path = stopStatePath(caveatHome, sessionId);
  mkdirSync(join(caveatHome, CLAUDE_STOP_STATE_DIR), { recursive: true });
  writeFileSync(path, key, 'utf-8');
}

function queueStopForSession(
  sessionId: string,
  signals: SessionSignals,
  related: SearchResult[],
): void {
  const ctx = buildContextSafely();
  if (!ctx) return;
  const key = stopSignalKey(signals, related);
  if (wasStopReminderQueued(ctx.caveatHome, sessionId, key)) return;
  try {
    appendPendingReminder(ctx.caveatHome, sessionId, buildStopReminder(signals, related));
    markStopReminderQueued(ctx.caveatHome, sessionId, key);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] pending reminder write error: ${msg}\n`);
  }
}

/**
 * Extract the text portion of a PostToolUse `tool_response` field. Claude
 * Code passes either a string, an object with content/output-like fields,
 * or an array of content blocks. Unknown shapes → empty string.
 */
function extractToolResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    const parts: string[] = [];
    for (const item of response) {
      if (typeof item === 'string') parts.push(item);
      else if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        parts.push((item as { text: string }).text);
      }
    }
    return parts.join(' ');
  }
  if (response !== null && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (typeof r.content === 'string') return r.content;
    if (Array.isArray(r.content)) return extractToolResponseText(r.content);
    if (typeof r.output === 'string') return r.output;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      return [r.stdout, r.stderr].filter((x) => typeof x === 'string').join(' ');
    }
  }
  return '';
}

function isToolError(payload: Record<string, unknown>): boolean {
  if (payload.hook_event_name === 'PostToolUseFailure') return true;
  const resp = payload.tool_response ?? (payload as Record<string, unknown>).toolResponse;
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    if ((resp as Record<string, unknown>).is_error === true) return true;
  }
  // Some transcripts surface the flag at top level
  if (payload.is_error === true) return true;
  if (typeof payload.error === 'string' && payload.error.length > 0) return true;
  return false;
}

interface WorkerJob {
  schemaVersion: 'caveat-worker-job/v1';
  sessionId: string;
  searchText: string;
  additionalContext?: CaveatHookSignalSidecarContextBlock;
}

type HookCodexSidecarMode = 'off' | 'auto' | 'require';
const WORKER_STALE_MS = 24 * 60 * 60 * 1000;
const WORKER_ROOT = 'caveat-worker-v1';
const WORKER_MARKER = '.caveat-worker-schema-v1';

function spawnWorker(job: Omit<WorkerJob, 'schemaVersion'>): void {
  let root: string | undefined;
  let workDir: string | undefined;
  let workFile: string | undefined;
  try {
    root = workerRoot();
    sweepStaleWorkerDirs(Date.now(), root);
    workDir = mkdtempSync(join(root, 'job-'));
    chmodSync(workDir, 0o700);
    workFile = join(workDir, `${randomBytes(4).toString('hex')}.json`);
    writeFileSync(workFile, JSON.stringify({ ...job, schemaVersion: 'caveat-worker-job/v1' }), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] worker writefile error: ${msg}\n`);
    cleanupWorkerDir(workDir, workDir ? dirname(workDir) : undefined);
    return;
  }
  // process.argv[1] is the CLI script path (dist/caveat.js bootstrap).
  // Detached + ignored stdio so parent exits immediately and the worker
  // outlives it without blocking Claude Code.
  const cliScript = process.argv[1];
  if (!cliScript) {
    cleanupWorkerDir(workDir, root);
    return;
  }
  try {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', cliScript, 'hook', 'worker', workFile!],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] worker spawn error: ${msg}\n`);
    try {
      cleanupWorkerDir(workDir, root);
    } catch {
      // ignore
    }
  }
}

async function runWorker(workFile: string): Promise<void> {
  // Worker runs detached — stdout/stderr go nowhere. Silent failures are OK;
  // the main hook process never waits on us.
  let raw: string;
  try {
    raw = readFileSync(workFile, 'utf-8');
  } catch {
    process.exit(0);
  }
  cleanupWorkerDir(dirname(workFile), dirname(dirname(workFile)));
  let job: WorkerJob;
  try {
    job = JSON.parse(raw) as WorkerJob;
  } catch {
    process.exit(0);
  }
  if (!job.searchText || !job.sessionId) process.exit(0);

  const hits = searchCaveatsFromTextSafely(job.searchText, 'tool_error');
  if (hits.length === 0) process.exit(0);

  const ctx = buildContextSafely();
  if (!ctx) process.exit(0);

  try {
    appendPendingReminder(ctx.caveatHome, job.sessionId, buildToolErrorReminder(job, hits));
  } catch {
    // best-effort; next hook will not drain anything but session continues
  }
  process.exit(0);
}

function cleanupWorkerDir(workDir: string | undefined, root: string | undefined): void {
  if (!workDir || !root || !isOwnedWorkerDir(workDir, root)) return;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // The hook still must not fail when its detached-worker cleanup fails.
  }
}

function isOwnedWorkerDir(path: string, root = workerRoot()): boolean {
  try {
    const inputStat = lstatSync(path);
    if (inputStat.isSymbolicLink()) return false;
    const tmpRoot = realpathSync(root);
    const resolved = realpathSync(path);
    const stat = lstatSync(resolved);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    return dirname(resolved) === tmpRoot
      && basename(resolved).startsWith('job-')
      && stat.isDirectory()
      && !stat.isSymbolicLink()
      && (stat.mode & 0o077) === 0
      && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
}

export function sweepStaleWorkerDirs(now = Date.now(), root = workerRoot()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    process.stderr.write('[caveat:hook] worker stale cleanup failed\n');
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('job-')) continue;
    const path = join(root, entry);
    try {
      if (!isOwnedWorkerDir(path, root)) continue;
      const stat = lstatSync(path);
      if (now - stat.mtimeMs <= WORKER_STALE_MS || !isStaleWorkerJobDir(path)) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      process.stderr.write('[caveat:hook] worker stale cleanup failed\n');
    }
  }
}

export function workerRoot(base = tmpdir()): string {
  const root = join(base, WORKER_ROOT);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) throw new Error('worker root is unsafe');
  const marker = join(root, WORKER_MARKER);
  try { writeFileSync(marker, 'caveat-worker/v1\n', { mode: 0o600, flag: 'wx' }); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
  const markerStat = lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0 || (uid !== undefined && markerStat.uid !== uid) || readFileSync(marker, 'utf-8') !== 'caveat-worker/v1\n') throw new Error('worker root marker is invalid');
  return root;
}

function isStaleWorkerJobDir(path: string): boolean {
  const entries = readdirSync(path);
  if (entries.length !== 1 || !entries[0]!.endsWith('.json')) return false;
  const file = join(path, entries[0]!);
  const stat = lstatSync(file);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) return false;
  return isWorkerJob(JSON.parse(readFileSync(file, 'utf-8')) as unknown);
}

function isWorkerJob(value: unknown): value is WorkerJob {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const keys = Object.keys(job).sort();
  if (!(keys.length === 3 && keys.join(',') === 'schemaVersion,searchText,sessionId') && !(keys.length === 4 && keys.join(',') === 'additionalContext,schemaVersion,searchText,sessionId')) return false;
  return job.schemaVersion === 'caveat-worker-job/v1' && typeof job.sessionId === 'string' && typeof job.searchText === 'string' && (job.additionalContext === undefined || (job.additionalContext !== null && typeof job.additionalContext === 'object' && !Array.isArray(job.additionalContext)));
}

function writeLastReindex(caveatHome: string, value: Record<string, unknown>): void {
  try {
    writeFileSync(join(caveatHome, 'index', '.last-reindex.json'), JSON.stringify(value), 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] reindex status write error: ${msg}\n`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runReindexWorker(): Promise<void> {
  if (process.env.CAVEAT_INDEX_AUTOSYNC === 'off') {
    process.stderr.write('[caveat:hook] auto reindex disabled by CAVEAT_INDEX_AUTOSYNC=off\n');
    return;
  }
  const ctx = buildContextSafely();
  if (!ctx || !existsSync(ctx.paths.dbPath)) {
    process.stderr.write('[caveat:hook] auto reindex skipped: index database does not exist\n');
    return;
  }
  const lock = acquireReindexLock(ctx.caveatHome);
  if (!lock) return;
  const startedAt = new Date().toISOString();
  let db: DatabaseSync | undefined;
  try {
    const digest = computeEntriesDigest(ctx.paths);
    const keyProvider = createKeyserverKeyProvider({ caveatHome: ctx.caveatHome });
    const failures = await prewarmSealedKeys({ paths: ctx.paths, keyProvider });
    for (const failure of failures) {
      process.stderr.write(`[caveat:hook] ${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}\n`);
    }
    db = openDb({ path: ctx.paths.dbPath, logger: silentLogger });
    const result = reindexAllSources({ db, paths: ctx.paths, logger: silentLogger, keyProvider });
    writeDigestMarker(ctx.caveatHome, digest);
    writeLastReindex(ctx.caveatHome, {
      startedAt,
      finishedAt: new Date().toISOString(),
      perSource: result.perSource,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] reindex error: ${msg}\n`);
    writeLastReindex(ctx.caveatHome, {
      startedAt,
      finishedAt: new Date().toISOString(),
      error: msg,
    });
  } finally {
    db?.close();
    try {
      releaseReindexLock(lock);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[caveat:hook] reindex lock release error: ${msg}\n`);
    }
  }
}

async function runAutoSyncWorker(): Promise<void> {
  if (process.env[CAVEAT_AUTO_SYNC_ENV] === 'off') {
    process.stderr.write('[caveat:hook] auto sync disabled by CAVEAT_AUTO_SYNC=off\n');
    return;
  }
  const ctx = buildContextSafely();
  if (!ctx) return;
  try {
    await runAutoSync({
      caveatHome: ctx.caveatHome,
      ownDir: ctx.paths.knowledgeRepo,
      paths: ctx.paths,
      logger: silentLogger,
    });
  } catch (err: unknown) {
    process.stderr.write(`[caveat:hook] auto sync error: ${errorMessage(err)}\n`);
  }
}

function buildToolErrorReminder(job: WorkerJob, hits: SearchResult[]): string {
  const base = toolErrorReminderText(hits);
  const mode = hookCodexSidecarMode();
  if (mode === 'off') return base;

  const projectRoot = process.cwd();
  const hasSidecarConfig = existsSync(join(projectRoot, '.codex-sidecar.yml'));
  if (mode === 'auto' && !hasSidecarConfig) return base;

  const advisory = runCodexSidecarAdvisory({
    searchText: job.searchText,
    limit: hits.length,
    projectRoot,
    prompt: [
      'A Claude Code tool just returned an error.',
      'Use the provided Caveat context to give concise next-step advice.',
      'Do not tell Claude to search Caveat again unless the context is insufficient.',
    ].join(' '),
    additionalContext: job.additionalContext,
  });
  if (advisory.status === 'ok') {
    return [
      base,
      '',
      formatCodexSidecarAdvisory(advisory),
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    base,
    '',
    formatCodexSidecarAdvisory(advisory),
  ].join('\n');
}

function hookCodexSidecarMode(): HookCodexSidecarMode {
  const raw = process.env.CAVEAT_HOOK_CODEX_SIDECAR;
  if (raw === 'off' || raw === 'auto' || raw === 'require') return raw;
  return 'auto';
}

function buildStopReminder(
  signals: SessionSignals,
  related: SearchResult[],
): string {
  const base = stopReminderText(signals, related);
  const mode = hookCodexSidecarMode();
  if (mode === 'off') return base;

  const projectRoot = process.cwd();
  const hasSidecarConfig = existsSync(join(projectRoot, '.codex-sidecar.yml'));
  if (mode === 'auto' && !hasSidecarConfig) return base;

  const advisory = runCodexSidecarAdvisory({
    searchText: struggleSearchText(signals),
    limit: Math.max(related.length, 1),
    projectRoot,
    prompt: [
      'A Claude Code session is ending after objective struggle signals.',
      'Use the provided Caveat context and structured hook signal context to advise whether Claude should update an existing caveat or record a new one.',
      'Be concise and preserve Caveat visibility rules.',
    ].join(' '),
    additionalContext: buildHookSignalSidecarContextBlock({
      type: 'stop',
      toolFailureCount: signals.toolFailureCount,
      reeditedFileCount: signals.fileEditCounts.length,
      webSearchCount: signals.webSearchCount,
      webFetchCount: signals.webFetchCount,
      bashRetryCount: signals.bashRetryCount,
      durationMinutes: signals.durationMinutes,
    }),
  });

  if (advisory.status === 'ok') {
    return [
      base,
      '',
      formatCodexSidecarAdvisory(advisory),
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    base,
    '',
    formatCodexSidecarAdvisory(advisory),
  ].join('\n');
}

export async function runHook(name: HookName, arg?: string): Promise<void> {
  try { sweepStaleWorkerDirs(); } catch { process.stderr.write('[caveat:hook] worker stale cleanup failed\n'); }
  if (name === 'reindex') {
    await runReindexWorker();
    process.exit(0);
  }
  if (name === 'autosync') {
    await runAutoSyncWorker();
    process.exit(0);
  }
  if (name === 'worker') {
    if (!arg) process.exit(0);
    await runWorker(arg);
    return;
  }

  let raw = '';
  try {
    raw = await readStdin();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] stdin read error: ${msg}\n`);
    process.exit(0);
  }
  const payload = parsePayload(raw);
  const sessionId = getSessionId(payload);

  const contexts = name === 'stop' ? [] : drainForSession(sessionId);

  if (name === 'user-prompt-submit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const hits = searchCaveatsFromTextSafely(prompt, 'user_prompt');
    if (hits.length > 0) {
      contexts.push(userPromptSubmitReminderText(hits));
    }
    const compacted = compactClaudeContexts(contexts);
    if (compacted.length > 0) {
      process.stdout.write(`${systemReminderOutput(compacted.join('\n\n'))}\n`);
    }
    process.exit(0);
  }

  if (name === 'post-tool-use') {
    const compacted = compactClaudeContexts(contexts);
    if (compacted.length > 0) {
      process.stdout.write(`${systemReminderOutput(compacted.join('\n\n'))}\n`);
    }
    // Fast path: we only enqueue on errors. Everything else is just drain.
    if (!isToolError(payload)) process.exit(0);
    const errText = extractToolResponseText(
      payload.tool_response ?? payload.toolResponse ?? payload.error ?? payload,
    );
    if (errText) {
      const failureKind = payload.hook_event_name === 'PostToolUseFailure'
        ? 'post-tool-use-failure'
        : 'error-bearing-post-tool-use';
      const additionalContext = buildHookSignalSidecarContextBlock({
        type: 'tool-error',
        toolName: payload.tool_name ?? payload.toolName,
        failureKind,
      });
      spawnWorker({ sessionId, searchText: errText, ...(additionalContext ? { additionalContext } : {}) });
    }
    process.exit(0);
  }

  if (name === 'stop') {
    // Periodic, debounced housekeeping: sweep stale per-session pending
    // dirs at most once per debounce window. Best-effort — never block the
    // hook contract on cleanup failures.
    const ctx = buildContextSafely();
    if (ctx) {
      try {
        maybeSweepPendingDirs(ctx.caveatHome);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[caveat:hook] pending sweep error: ${msg}\n`);
      }
      try {
        maybeTriggerAutoReindex(ctx);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[caveat:hook] auto reindex trigger error: ${msg}\n`);
      }
      try {
        maybeTriggerAutoSync(ctx);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[caveat:hook] auto sync trigger error: ${msg}\n`);
      }
    }
    if (payload.stop_hook_active === true) process.exit(0);
    const transcriptPath =
      typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const signals = transcriptPath ? loadSignalsSafely(transcriptPath) : null;
    if (!signals || !hasAnyStruggleSignal(signals)) process.exit(0);
    const related = searchCaveatsFromTextSafely(struggleSearchText(signals), 'stop');
    queueStopForSession(sessionId, signals, related);
    process.exit(0);
  }

  process.stderr.write(`[caveat:hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
