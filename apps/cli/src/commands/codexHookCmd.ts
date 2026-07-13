import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  buildAndPublishPendingReminder,
  buildPendingSemanticKey,
  defaultSelfIdentityTokens,
  drainPendingRemindersDetailed,
  findCaveatsForHook,
  findCaveatsForHookSegments,
  hasAnyStruggleSignal,
  logHookQueryMiss,
  markHit,
  maybeSweepPendingDirs,
  openDb,
  readCodexSessionSignals,
  stopReminderText,
  struggleSearchText,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  type Logger,
  type HookSearchInput,
  type SearchResult,
  type SessionSignals,
  observeRuntimeError,
} from '@caveat/core';
import { buildContext, type CliContext } from '../context.js';
import { CAVEAT_VERSION } from '../version.js';
import { maybeTriggerAutoReindex } from '../autoReindexTrigger.js';
import { maybeTriggerAutoSync } from '../autoSyncTrigger.js';
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

const CODEX_MAX_CONTEXT_BLOCKS = 3;
const CODEX_STOP_REMINDER_PREFIX =
  '[caveat] このセッションで外部仕様の罠に当たった可能性を示すシグナル:';
const CODEX_STOP_STATE_DIR = 'codex-stop-state';

interface CodexWorkerJob {
  sessionId: string;
  topicText: string;
  failureText: string;
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
    observeRuntimeError('CAVEAT.CODEX_HOOK_FAILED', { version: CAVEAT_VERSION });
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] json parse error: ${msg}\n`);
    return {};
  }
}

function buildContextSafely(): CliContext | null {
  try {
    return buildContext(silentLogger);
  } catch (err: unknown) {
    observeRuntimeError('CAVEAT.CODEX_HOOK_FAILED', { version: CAVEAT_VERSION });
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] context error: ${msg}\n`);
    return null;
  }
}

function searchCaveatsSafely(input: HookSearchInput | readonly HookSearchInput[]): SearchResult[] {
  const inputs: readonly HookSearchInput[] = Array.isArray(input) ? input : [input as HookSearchInput];
  const queryForLog = inputs.map((item) => item.surface === 'user_prompt'
    ? (item.topicText || item.failureText)
    : item.failureText).filter(Boolean).join('\n');
  if (inputs.length === 0 || inputs.every((item) => !item.topicText && !item.failureText)) return [];
  let db: DatabaseSync | undefined;
  let caveatHome: string | undefined;
  let hits: SearchResult[];
  try {
    const ctx = buildContextSafely();
    if (!ctx || !existsSync(ctx.paths.dbPath)) return [];
    caveatHome = ctx.caveatHome;
    db = openDb({ path: ctx.paths.dbPath });
    const searchOptions = {
      selfIdentity: defaultSelfIdentityTokens(),
    };
    hits = inputs.length === 1
      ? findCaveatsForHook(db, inputs[0]!, searchOptions)
      : findCaveatsForHookSegments(db, inputs, searchOptions);
  } catch (err: unknown) {
    observeRuntimeError('CAVEAT.CODEX_HOOK_FAILED', { version: CAVEAT_VERSION });
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] search error: ${msg}\n`);
    return [];
  }
  if (hits.length > 0) {
    try {
      markHit(db!, hits);
    } catch (err: unknown) {
      observeRuntimeError('CAVEAT.CODEX_HOOK_FAILED', { version: CAVEAT_VERSION });
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[caveat:codex-hook] markHit error: ${msg}\n`);
    }
  } else {
    try {
      logHookQueryMiss({ caveatHome: caveatHome!, agent: 'codex', surface: inputs[0]!.surface, query: queryForLog });
    } catch (err: unknown) {
      observeRuntimeError('CAVEAT.CODEX_HOOK_FAILED', { version: CAVEAT_VERSION });
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[caveat:codex-hook] query log error: ${msg}\n`);
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
  const topicText = inputText.trim();
  const failureText = [responseText, transcriptOutput ?? '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');

  const knownError = isCodexToolError(payload);
  if (knownError) {
    return { sessionId, topicText, failureText, knownError: true, transcriptPath, toolUseId };
  }

  if (transcriptPath && toolUseId && isShellLikeTool(payload) && (topicText || failureText)) {
    return {
      sessionId,
      topicText,
      failureText,
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

export function codexPendingCleanupFailureText(): string {
  return '[caveat:codex-hook] pending reminder cleanup failed';
}

function drainForSession(sessionId: string): string[] {
  const ctx = buildContextSafely();
  if (!ctx) return [];
  const local = drainPendingRemindersDetailed(ctx.caveatHome, sessionId);
  const global = drainPendingRemindersDetailed(ctx.caveatHome, '_global');
  for (const _failure of [...local.cleanupFailures, ...global.cleanupFailures]) {
    process.stderr.write(`${codexPendingCleanupFailureText()}\n`);
  }
  return [...local.reminders, ...global.reminders];
}

function codexContextDedupeKey(text: string): string {
  if (text.startsWith(CODEX_STOP_REMINDER_PREFIX)) return 'codex-stop-reminder';
  return text.trim();
}

function compactCodexContexts(contexts: string[]): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    const text = contexts[i]?.trim();
    if (!text) continue;
    const key = codexContextDedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(text);
  }
  selected.reverse();
  const limited = selected.slice(-CODEX_MAX_CONTEXT_BLOCKS);
  const omitted = selected.length - limited.length;
  if (omitted > 0) {
    limited.push(`[caveat] pending reminder ${omitted} 件を重複または上限により省略しました。`);
  }
  return limited;
}

function sanitizeCodexStateId(raw: string): string {
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
  return join(caveatHome, CODEX_STOP_STATE_DIR, `${sanitizeCodexStateId(sessionId)}.txt`);
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
  mkdirSync(join(caveatHome, CODEX_STOP_STATE_DIR), { recursive: true });
  writeFileSync(path, key, 'utf-8');
}

function queueStopForSession(sessionId: string, signals: SessionSignals, related: SearchResult[]): void {
  const ctx = buildContextSafely();
  if (!ctx) return;
  const key = stopSignalKey(signals, related);
  if (wasStopReminderQueued(ctx.caveatHome, sessionId, key)) return;
  let result: ReturnType<typeof buildAndPublishPendingReminder>;
  try {
    result = buildAndPublishPendingReminder(ctx.caveatHome, sessionId, buildPendingSemanticKey({
      agent: 'codex', surface: 'stop', refs: related, stopSignalDigest: key,
    }), () => stopReminderText(signals, related));
  } catch {
    process.stderr.write('[caveat:codex-hook] pending reminder build or publish failed\n');
    return;
  }
  if (!result.ran) return;
  try {
    markStopReminderQueued(ctx.caveatHome, sessionId, key);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:codex-hook] pending reminder write error: ${msg}\n`);
  }
}

function spawnCodexWorker(job: CodexWorkerJob): void {
  const workFile = join(
    tmpdir(),
    `caveat-codex-worker-${Date.now()}-${randomBytes(4).toString('hex')}.json`,
  );
  try {
    writeFileSync(workFile, JSON.stringify(job), {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
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
  if ((!job.topicText && !job.failureText) || !job.sessionId) return;
  let failureText = job.failureText;
  let knownError = job.knownError === true;
  if (opts.waitForTranscript && job.transcriptPath && job.toolUseId) {
    const transcriptOutput = await waitForTranscriptOutput(job.transcriptPath, job.toolUseId);
    if (transcriptOutput) {
      const exit = processExitCodeFromText(transcriptOutput);
      if (exit !== null) {
        if (exit === 0) return;
        knownError = true;
      }
      failureText = [failureText, transcriptOutput].filter(Boolean).join('\n');
    }
  }

  if (!knownError && job.allowSymptomOnly !== true) return;

  const hits = searchCaveatsSafely({
    topicText: job.topicText,
    failureText,
    surface: 'tool_error',
  });
  if (hits.length === 0) return;

  const ctx = buildContextSafely();
  if (!ctx) return;
  let result: ReturnType<typeof buildAndPublishPendingReminder>;
  try {
    result = buildAndPublishPendingReminder(ctx.caveatHome, job.sessionId, buildPendingSemanticKey({
      agent: 'codex', surface: 'tool_error', refs: hits,
    }), () => toolErrorReminderText(hits));
  } catch {
    process.stderr.write('[caveat:codex-hook] pending reminder build or publish failed\n');
    return;
  }
  if (!result.ran) return;
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
    env: codexFeatureListEnv(codexHome),
  });
  const featureOutput = [features.stdout, features.stderr].filter(Boolean).join('\n');
  const hasHooks = /^hooks\s+\S+\s+true\b/m.test(featureOutput);
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
      .find((line) => line.trim().startsWith('hooks')) ?? null,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function codexFeatureListEnv(
  codexHome: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...inherited, CODEX_HOME: codexHome };
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
  if (!sessionId) process.stderr.write('[caveat:codex-hook] missing session_id; pending drain disabled\n');

  if (name === 'user-prompt-submit') {
    const contexts = sessionId ? drainForSession(sessionId) : [];
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const hits = searchCaveatsSafely({ topicText: prompt, failureText: prompt, surface: 'user_prompt' });
    if (hits.length > 0) {
      contexts.push(userPromptSubmitReminderText(hits));
    }
    const compacted = compactCodexContexts(contexts);
    if (compacted.length > 0) {
      process.stdout.write(`${codexContextOutput(compacted.join('\n\n'))}\n`);
    }
    process.exit(0);
  }

  if (name === 'post-tool-use') {
    const job = buildCodexPostToolUseWorkerJob(payload);
    if (job) await processCodexWorkerJob(job, { waitForTranscript: false });
    process.exit(0);
  }

  if (name === 'stop') {
    try {
      const ctx = buildContextSafely();
      if (ctx) {
        try {
          maybeSweepPendingDirs(ctx.caveatHome);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[caveat:codex-hook] pending sweep error: ${msg}\n`);
        }
        maybeTriggerAutoReindex(ctx);
        try {
          maybeTriggerAutoSync(ctx);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[caveat:codex-hook] auto sync trigger error: ${msg}\n`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[caveat:codex-hook] auto reindex trigger error: ${msg}\n`);
    }
    if (payload.stop_hook_active === true) process.exit(0);
    const transcriptPath =
      typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const signals = transcriptPath ? loadSignalsSafely(transcriptPath) : null;
    if (!signals || !hasAnyStruggleSignal(signals)) process.exit(0);
    const related = searchCaveatsSafely(signals.errorSnippets.map((failureText) => ({
      topicText: '',
      failureText,
      surface: 'stop' as const,
    })));
    if (sessionId) queueStopForSession(sessionId, signals, related);
    process.exit(0);
  }

  process.stderr.write(`[caveat:codex-hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
