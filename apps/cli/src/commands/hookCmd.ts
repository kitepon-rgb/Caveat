import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type Logger,
  type SearchResult,
  type SessionSignals,
} from '@caveat/core';
import { buildContext, type CliContext } from '../context.js';
import { maybeTriggerAutoReindex } from '../autoReindexTrigger.js';
import { maybeTriggerAutoSync } from '../autoSyncTrigger.js';

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

function searchCaveatsFromTextSafely(text: string): SearchResult[] {
  if (!text) return [];
  let db: DatabaseSync | undefined;
  try {
    const ctx = buildContextSafely();
    if (!ctx || !existsSync(ctx.paths.dbPath)) return [];
    db = openDb({ path: ctx.paths.dbPath });
    const hits = findCaveatsForPrompt(db, text, {
      selfIdentity: defaultSelfIdentityTokens(),
    });
    if (hits.length > 0) {
      try {
        markHit(db, hits);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[caveat:hook] markHit error: ${msg}\n`);
      }
    }
    return hits;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] search error: ${msg}\n`);
    return [];
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
  return `<system-reminder>${text}</system-reminder>`;
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
  sessionId: string;
  searchText: string;
}

type HookCodexSidecarMode = 'off' | 'auto' | 'require';

function spawnWorker(job: WorkerJob): void {
  const workFile = join(
    tmpdir(),
    `caveat-worker-${Date.now()}-${randomBytes(4).toString('hex')}.json`,
  );
  try {
    writeFileSync(workFile, JSON.stringify(job), 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] worker writefile error: ${msg}\n`);
    return;
  }
  // process.argv[1] is the CLI script path (dist/caveat.js bootstrap).
  // Detached + ignored stdio so parent exits immediately and the worker
  // outlives it without blocking Claude Code.
  const cliScript = process.argv[1];
  if (!cliScript) return;
  try {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', cliScript, 'hook', 'worker', workFile],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:hook] worker spawn error: ${msg}\n`);
    try {
      unlinkSync(workFile);
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
  try {
    unlinkSync(workFile);
  } catch {
    // best-effort
  }
  let job: WorkerJob;
  try {
    job = JSON.parse(raw) as WorkerJob;
  } catch {
    process.exit(0);
  }
  if (!job.searchText || !job.sessionId) process.exit(0);

  const hits = searchCaveatsFromTextSafely(job.searchText);
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
  });
  if (advisory.status === 'ok') {
    return [
      base,
      '',
      '[caveat:codex-sidecar] Codex advisory:',
      advisory.summary,
      advisory.rawEventLogRef ? `rawEventLogRef: ${advisory.rawEventLogRef}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    base,
    '',
    `[caveat:codex-sidecar] advisory unavailable: ${advisory.message}`,
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
      'Use the provided Caveat context and the signal text to advise whether Claude should update an existing caveat or record a new one.',
      'Be concise and preserve Caveat visibility rules.',
    ].join(' '),
  });

  if (advisory.status === 'ok') {
    return [
      base,
      '',
      '[caveat:codex-sidecar] Codex advisory:',
      advisory.summary,
      advisory.rawEventLogRef ? `rawEventLogRef: ${advisory.rawEventLogRef}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    base,
    '',
    `[caveat:codex-sidecar] advisory unavailable: ${advisory.message}`,
  ].join('\n');
}

function compactFailureMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'unknown error';
  return singleLine.length > 220 ? `${singleLine.slice(0, 220)}...` : singleLine;
}

function sidecarFailureDetail(output: string): string {
  const protocol = output.match(/PROTOCOL_ERROR:[^"\r\n]+/);
  if (protocol) return compactFailureMessage(protocol[0]!);

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = lines.find(
    (line) => !line.startsWith('[caveat] [codex-sidecar] codex-sidecar '),
  );
  return compactFailureMessage(diagnostic ?? output);
}

function runCodexSidecarAdvisory(input: {
  searchText: string;
  limit: number;
  projectRoot: string;
  prompt: string;
}): { status: 'ok'; summary: string; rawEventLogRef?: string } | { status: 'failed'; message: string } {
  const cliScript = process.argv[1];
  if (!cliScript) {
    return { status: 'failed', message: 'current Caveat CLI script path is unavailable' };
  }

  const args = [
    ...process.execArgv,
    '--disable-warning=ExperimentalWarning',
    cliScript,
    'codex-sidecar',
    'run',
    'explore',
    input.prompt,
    '--preset',
    'advisory',
    '--query',
    input.searchText,
    '--limit',
    String(Math.max(1, input.limit)),
    '--host-agent',
    'claude',
    '--availability',
    'operational',
  ];
  const resultDir = mkdtempSync(join(tmpdir(), 'caveat-codex-advisory-'));
  const resultFile = join(resultDir, 'result.json');
  args.push('--save-result', resultFile);

  const nodeCli = process.env.CAVEAT_CODEX_SIDECAR_NODE_CLI;
  if (nodeCli) {
    args.push('--node-cli', nodeCli);
  } else {
    const command = process.env.CAVEAT_CODEX_SIDECAR_COMMAND;
    if (command) args.push('--command', command);
  }

  try {
    const result = spawnSync(process.execPath, args, {
      cwd: input.projectRoot,
      encoding: 'utf-8',
      timeout: Number(process.env.CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS ?? 120_000),
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      return { status: 'failed', message: compactFailureMessage(result.error.message) };
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
      return {
        status: 'failed',
        message: `sidecar command failed: ${sidecarFailureDetail(detail)}`,
      };
    }

    const parsed = JSON.parse(readFileSync(resultFile, 'utf-8')) as {
      status?: string;
      summary?: unknown;
      rawEventLogRef?: unknown;
    };
    if (parsed.status !== 'ok' || typeof parsed.summary !== 'string') {
      return {
        status: 'failed',
        message: compactFailureMessage(`unexpected SidecarResult status: ${String(parsed.status)}`),
      };
    }
    return {
      status: 'ok',
      summary: parsed.summary,
      ...(typeof parsed.rawEventLogRef === 'string' ? { rawEventLogRef: parsed.rawEventLogRef } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      message: compactFailureMessage(`invalid SidecarResult JSON: ${msg}`),
    };
  } finally {
    rmSync(resultDir, { recursive: true, force: true });
  }
}

export async function runHook(name: HookName, arg?: string): Promise<void> {
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
    const hits = searchCaveatsFromTextSafely(prompt);
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
      spawnWorker({ sessionId, searchText: errText });
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
    const related = searchCaveatsFromTextSafely(struggleSearchText(signals));
    queueStopForSession(sessionId, signals, related);
    process.exit(0);
  }

  process.stderr.write(`[caveat:hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
