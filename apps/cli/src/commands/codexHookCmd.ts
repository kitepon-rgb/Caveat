import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  appendPendingReminder,
  defaultSelfIdentityTokens,
  drainPendingReminders,
  findCaveatsForPrompt,
  hasAnyStruggleSignal,
  markHit,
  openDb,
  readCodexSessionSignals,
  stopReminderText,
  struggleSearchText,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  type Logger,
  type SearchResult,
  type SessionSignals,
} from '@caveat/core';
import { buildContext, type CliContext } from '../context.js';
import { detectCodexHookInstallation } from '../codexHookInstall.js';

export type CodexHookName =
  | 'user-prompt-submit'
  | 'post-tool-use'
  | 'stop'
  | 'worker'
  | 'diagnostics';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: (m) => process.stderr.write(`[caveat:codex-hook] ${m}\n`),
};

interface CodexWorkerJob {
  sessionId: string;
  searchText: string;
  knownError?: boolean;
  allowSymptomOnly?: boolean;
  transcriptPath?: string;
  toolUseId?: string;
}

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
    process.stderr.write(`[caveat:codex-hook] json parse error: ${msg}\n`);
    return {};
  }
}

function buildContextSafely(): CliContext | null {
  try {
    return buildContext(silentLogger);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] context error: ${msg}\n`);
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
        process.stderr.write(`[caveat:codex-hook] markHit error: ${msg}\n`);
      }
    }
    return hits;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] search error: ${msg}\n`);
    return [];
  } finally {
    db?.close();
  }
}

function loadSignalsSafely(path: string): SessionSignals | null {
  try {
    return readCodexSessionSignals(path);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] transcript read error: ${msg}\n`);
    return null;
  }
}

function codexSessionId(payload: Record<string, unknown>): string | null {
  const v = payload.session_id ?? payload.sessionId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function extractToolResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    return response
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item !== null && typeof item === 'object') {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
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

function numericExitCode(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function processExitCodeFromText(text: string): number | null {
  const m = /Process exited with code\s+(-?\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

function transcriptToolOutput(transcriptPath: string, toolUseId: string): string | null {
  if (!transcriptPath || !toolUseId || !existsSync(transcriptPath)) return null;

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  for (const line of raw.split('\n')) {
    if (!line.includes(toolUseId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const payloadObj = (parsed as { payload?: unknown }).payload;
    if (payloadObj === null || typeof payloadObj !== 'object') continue;
    const p = payloadObj as Record<string, unknown>;
    if (p.type !== 'function_call_output' || p.call_id !== toolUseId) continue;
    return typeof p.output === 'string' ? p.output : '';
  }
  return null;
}

function transcriptExitCode(payload: Record<string, unknown>): number | null {
  const transcriptPath =
    typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '';
  const output = transcriptToolOutput(transcriptPath, toolUseId);
  return output === null ? null : processExitCodeFromText(output);
}

function isShellLikeTool(payload: Record<string, unknown>): boolean {
  const name = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (name === 'Bash' || name === 'exec_command') return true;
  const input = payload.tool_input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const r = input as Record<string, unknown>;
    return typeof r.command === 'string' || typeof r.cmd === 'string';
  }
  return false;
}

function toolInputText(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '';
  const r = input as Record<string, unknown>;
  const command = r.command ?? r.cmd;
  return typeof command === 'string' ? command : '';
}

export function isCodexToolError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  const topExit = numericExitCode(payload.exit_code ?? payload.exitCode);
  if (topExit !== null) return topExit !== 0;
  const resp = payload.tool_response ?? payload.toolResponse;
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    const r = resp as Record<string, unknown>;
    if (r.is_error === true) return true;
    const exit = numericExitCode(r.exit_code ?? r.exitCode);
    if (exit !== null) return exit !== 0;
  }
  const responseExit = processExitCodeFromText(extractToolResponseText(resp));
  if (responseExit !== null) return responseExit !== 0;
  const transcriptExit = transcriptExitCode(payload);
  if (transcriptExit !== null) return transcriptExit !== 0;
  return false;
}

export function buildCodexPostToolUseWorkerJob(
  payload: Record<string, unknown>,
): CodexWorkerJob | null {
  const sessionId = codexSessionId(payload);
  if (!sessionId) return null;

  const transcriptPath =
    typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined;
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined;
  const responseText = extractToolResponseText(payload.tool_response ?? payload.toolResponse);
  const inputText = toolInputText(payload.tool_input);
  const transcriptOutput =
    transcriptPath && toolUseId ? transcriptToolOutput(transcriptPath, toolUseId) : null;
  const searchText = [inputText, responseText, transcriptOutput ?? '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');

  const knownError = isCodexToolError(payload);
  if (knownError) {
    return { sessionId, searchText, knownError: true, transcriptPath, toolUseId };
  }

  if (transcriptPath && toolUseId && isShellLikeTool(payload) && searchText) {
    return {
      sessionId,
      searchText,
      knownError: false,
      allowSymptomOnly: true,
      transcriptPath,
      toolUseId,
    };
  }

  return null;
}

export function codexContextOutput(text: string, eventName = 'UserPromptSubmit'): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  });
}

export function codexStopOutput(text: string): string {
  return JSON.stringify({
    decision: 'block',
    reason: text,
  });
}

function drainForSession(sessionId: string, eventName = 'UserPromptSubmit'): void {
  const ctx = buildContextSafely();
  if (!ctx) return;
  const reminders = drainPendingReminders(ctx.caveatHome, sessionId);
  for (const text of reminders) {
    process.stdout.write(`${codexContextOutput(text, eventName)}\n`);
  }
}

function spawnCodexWorker(job: CodexWorkerJob): void {
  const workFile = join(
    tmpdir(),
    `caveat-codex-worker-${Date.now()}-${randomBytes(4).toString('hex')}.json`,
  );
  try {
    writeFileSync(workFile, JSON.stringify(job), 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] worker writefile error: ${msg}\n`);
    return;
  }

  const cliScript = process.argv[1];
  if (!cliScript) return;
  try {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', cliScript, 'codex-hook', 'worker', workFile],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] worker spawn error: ${msg}\n`);
    try {
      unlinkSync(workFile);
    } catch {
      // ignore
    }
  }
}

async function waitForTranscriptOutput(
  transcriptPath: string,
  toolUseId: string,
): Promise<string | null> {
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    const output = transcriptToolOutput(transcriptPath, toolUseId);
    if (output !== null) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function processCodexWorkerJob(
  job: CodexWorkerJob,
  opts: { waitForTranscript: boolean } = { waitForTranscript: true },
): Promise<void> {
  if (!job.searchText || !job.sessionId) return;
  let searchText = job.searchText;
  let knownError = job.knownError === true;
  if (opts.waitForTranscript && job.transcriptPath && job.toolUseId) {
    const transcriptOutput = await waitForTranscriptOutput(job.transcriptPath, job.toolUseId);
    if (transcriptOutput) {
      const exit = processExitCodeFromText(transcriptOutput);
      if (exit !== null) {
        if (exit === 0) return;
        knownError = true;
      }
      searchText = [searchText, transcriptOutput].filter(Boolean).join('\n');
    }
  }

  if (!knownError && job.allowSymptomOnly !== true) return;

  const hits = searchCaveatsFromTextSafely(searchText);
  if (hits.length === 0) return;

  const ctx = buildContextSafely();
  if (!ctx) return;

  try {
    appendPendingReminder(ctx.caveatHome, job.sessionId, toolErrorReminderText(hits));
  } catch {
    // best-effort
  }
}

async function runCodexWorker(workFile: string): Promise<void> {
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
  let job: CodexWorkerJob;
  try {
    job = JSON.parse(raw) as CodexWorkerJob;
  } catch {
    process.exit(0);
  }
  await processCodexWorkerJob(job);
  process.exit(0);
}

function runDiagnostics(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): void {
  const features = spawnSync('codex', ['features', 'list'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  const featureOutput = [features.stdout, features.stderr].filter(Boolean).join('\n');
  const hasHooks = /^codex_hooks\s+\S+\s+true\b/m.test(featureOutput);
  const installation = detectCodexHookInstallation(codexHome);
  const result = {
    availability:
      features.error || features.status !== 0 || !hasHooks ? 'unavailable' : 'available',
    codexBinary: features.error ? 'missing' : 'present',
    codexHooksFeature: hasHooks ? 'enabled' : 'not-enabled',
    installation: installation.installation,
    codexHome,
    hooksPath: installation.hooksPath,
    installedHooks: installation.hooks,
    evidence: featureOutput
      .split('\n')
      .find((line) => line.trim().startsWith('codex_hooks')) ?? null,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function runCodexHook(name: CodexHookName, arg?: string): Promise<void> {
  if (name === 'diagnostics') {
    runDiagnostics(arg);
    return;
  }
  if (name === 'worker') {
    if (!arg) process.exit(0);
    await runCodexWorker(arg);
    return;
  }

  let raw = '';
  try {
    raw = await readStdin();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] stdin read error: ${msg}\n`);
    process.exit(0);
  }
  const payload = parsePayload(raw);
  const sessionId = codexSessionId(payload);
  if (sessionId && name === 'user-prompt-submit') drainForSession(sessionId);
  else if (!sessionId) process.stderr.write('[caveat:codex-hook] missing session_id; pending drain disabled\n');

  if (name === 'user-prompt-submit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const hits = searchCaveatsFromTextSafely(prompt);
    if (hits.length > 0) {
      process.stdout.write(`${codexContextOutput(userPromptSubmitReminderText(hits))}\n`);
    }
    process.exit(0);
  }

  if (name === 'post-tool-use') {
    const job = buildCodexPostToolUseWorkerJob(payload);
    if (job) await processCodexWorkerJob(job, { waitForTranscript: false });
    process.exit(0);
  }

  if (name === 'stop') {
    if (payload.stop_hook_active === true) process.exit(0);
    const transcriptPath =
      typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const signals = transcriptPath ? loadSignalsSafely(transcriptPath) : null;
    if (!signals || !hasAnyStruggleSignal(signals)) process.exit(0);
    const related = searchCaveatsFromTextSafely(struggleSearchText(signals));
    process.stdout.write(`${codexStopOutput(stopReminderText(signals, related))}\n`);
    process.exit(0);
  }

  process.stderr.write(`[caveat:codex-hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
