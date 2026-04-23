import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import {
  appendPendingReminder,
  drainPendingReminders,
  findCaveatsForPrompt,
  hasAnyStruggleSignal,
  markHit,
  openDb,
  readSessionSignals,
  stopReminderText,
  struggleSearchText,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  type Logger,
  type SearchResult,
  type SessionSignals,
} from '@caveat/core';
import { buildContext, type CliContext } from '../context.js';

export type HookName = 'user-prompt-submit' | 'post-tool-use' | 'stop' | 'worker';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: (m) => process.stderr.write(`[caveat:hook] ${m}\n`),
};

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
    const hits = findCaveatsForPrompt(db, text);
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

/**
 * Flush any reminders that a previous async worker queued for this session.
 * Called at the start of every hook so deferred results surface on the next
 * Claude turn. Keeps stdout order: drained reminders first, then any
 * synchronous reminder this hook produces.
 */
function drainForSession(sessionId: string): void {
  const ctx = buildContextSafely();
  if (!ctx) return;
  const reminders = drainPendingReminders(ctx.caveatHome, sessionId);
  for (const text of reminders) {
    process.stdout.write(`<system-reminder>${text}</system-reminder>\n`);
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
  const resp = payload.tool_response ?? (payload as Record<string, unknown>).toolResponse;
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    if ((resp as Record<string, unknown>).is_error === true) return true;
  }
  // Some transcripts surface the flag at top level
  if (payload.is_error === true) return true;
  return false;
}

interface WorkerJob {
  sessionId: string;
  searchText: string;
}

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
    appendPendingReminder(ctx.caveatHome, job.sessionId, toolErrorReminderText(hits));
  } catch {
    // best-effort; next hook will not drain anything but session continues
  }
  process.exit(0);
}

export async function runHook(name: HookName, arg?: string): Promise<void> {
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

  // Every hook drains queued async reminders first so they show up on the
  // next Claude turn even if no further PostToolUse fires.
  drainForSession(sessionId);

  if (name === 'user-prompt-submit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const hits = searchCaveatsFromTextSafely(prompt);
    if (hits.length > 0) {
      process.stdout.write(
        `<system-reminder>${userPromptSubmitReminderText(hits)}</system-reminder>\n`,
      );
    }
    process.exit(0);
  }

  if (name === 'post-tool-use') {
    // Fast path: we only enqueue on errors. Everything else is just drain.
    if (!isToolError(payload)) process.exit(0);
    const errText = extractToolResponseText(payload.tool_response ?? payload);
    if (errText) {
      spawnWorker({ sessionId, searchText: errText });
    }
    process.exit(0);
  }

  if (name === 'stop') {
    if (payload.stop_hook_active === true) process.exit(0);
    const transcriptPath =
      typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const signals = transcriptPath ? loadSignalsSafely(transcriptPath) : null;
    if (!signals || !hasAnyStruggleSignal(signals)) process.exit(0);
    const related = searchCaveatsFromTextSafely(struggleSearchText(signals));
    process.stdout.write(
      `<system-reminder>${stopReminderText(signals, related)}</system-reminder>\n`,
    );
    process.exit(0);
  }

  process.stderr.write(`[caveat:hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
