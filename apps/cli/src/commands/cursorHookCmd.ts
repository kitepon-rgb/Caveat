import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  hasAnyStruggleSignal,
  maybeSweepPendingDirs,
  readSessionSignals,
  stopReminderText,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  type SessionSignals,
} from '@caveat/core';
import { maybeTriggerAutoReindex } from '../autoReindexTrigger.js';
import { maybeTriggerAutoSync } from '../autoSyncTrigger.js';
import { detectCursorHookInstallation } from '../cursorInstall.js';
import {
  buildContextSafely,
  compactContexts,
  drainForSession,
  errorMessage,
  extractToolResponseText,
  parsePayload,
  queueStopForSession,
  readStdin,
  searchCaveatsSafely,
  type HookHost,
} from '../hookShared.js';

export type CursorHookName =
  | 'user-prompt-submit'
  | 'post-tool-use'
  | 'stop'
  | 'diagnostics';

const CURSOR_HOST: HookHost = {
  agent: 'cursor',
  stderrTag: 'caveat:cursor-hook',
  errorCode: 'CAVEAT.CURSOR_HOOK_FAILED',
  stopStateDir: 'cursor-stop-state',
  stopDedupeKey: 'cursor-stop-reminder',
};

export function cursorContextOutput(text: string): string {
  return JSON.stringify({ additional_context: text });
}

function cursorSessionId(payload: Record<string, unknown>): string {
  for (const key of ['conversation_id', 'session_id', 'sessionId']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '_unknown';
}

function cursorPrompt(payload: Record<string, unknown>): string {
  return typeof payload.prompt === 'string' ? payload.prompt : '';
}

function isCursorToolError(payload: Record<string, unknown>): boolean {
  if (payload.hook_event_name === 'postToolUseFailure') return true;
  if (payload.is_error === true) return true;
  if (typeof payload.error === 'string' && payload.error.length > 0) return true;
  const resp = payload.tool_response ?? payload.toolResponse;
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    if ((resp as Record<string, unknown>).is_error === true) return true;
  }
  return false;
}

function loadSignalsSafely(path: string): SessionSignals | null {
  try {
    return readSessionSignals(path);
  } catch (err: unknown) {
    process.stderr.write(`[caveat:cursor-hook] transcript read error: ${errorMessage(err)}\n`);
    return null;
  }
}

function runDiagnostics(cursorDir = join(homedir(), '.cursor')): void {
  const installation = detectCursorHookInstallation(cursorDir);
  process.stdout.write(`${JSON.stringify({
    installation: installation.installation,
    cursorDir,
    hooksPath: installation.hooksPath,
    installedHooks: installation.hooks,
  }, null, 2)}\n`);
}

export async function runCursorHook(name: CursorHookName, arg?: string): Promise<void> {
  if (name === 'diagnostics') {
    runDiagnostics(arg);
    return;
  }

  let raw = '';
  try {
    raw = await readStdin();
  } catch (err: unknown) {
    process.stderr.write(`[caveat:cursor-hook] stdin read error: ${errorMessage(err)}\n`);
    process.exit(0);
  }
  const payload = parsePayload(CURSOR_HOST, raw);
  const sessionId = cursorSessionId(payload);
  const contexts = name === 'stop' ? [] : drainForSession(CURSOR_HOST, sessionId);

  if (name === 'user-prompt-submit') {
    const prompt = cursorPrompt(payload);
    const hits = searchCaveatsSafely(CURSOR_HOST, {
      topicText: prompt,
      failureText: prompt,
      surface: 'user_prompt',
    });
    if (hits.length > 0) contexts.push(userPromptSubmitReminderText(hits, 'native-cli'));
    const compacted = compactContexts(CURSOR_HOST, contexts);
    if (compacted.length > 0) {
      process.stdout.write(`${cursorContextOutput(compacted.join('\n\n'))}\n`);
    }
    process.exit(0);
  }

  if (name === 'post-tool-use') {
    if (isCursorToolError(payload)) {
      const errText = extractToolResponseText(
        payload.tool_response ?? payload.toolResponse ?? payload.error ?? payload,
      );
      const hits = searchCaveatsSafely(CURSOR_HOST, {
        topicText: errText,
        failureText: errText,
        surface: 'tool_error',
      });
      if (hits.length > 0) contexts.push(toolErrorReminderText(hits, 'native-cli'));
    }
    const compacted = compactContexts(CURSOR_HOST, contexts);
    if (compacted.length > 0) {
      process.stdout.write(`${cursorContextOutput(compacted.join('\n\n'))}\n`);
    }
    process.exit(0);
  }

  if (name === 'stop') {
    const ctx = buildContextSafely(CURSOR_HOST);
    if (ctx) {
      try {
        maybeSweepPendingDirs(ctx.caveatHome);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:cursor-hook] pending sweep error: ${errorMessage(err)}\n`);
      }
      try {
        maybeTriggerAutoReindex(ctx);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:cursor-hook] auto reindex trigger error: ${errorMessage(err)}\n`);
      }
      try {
        maybeTriggerAutoSync(ctx);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:cursor-hook] auto sync trigger error: ${errorMessage(err)}\n`);
      }
    }
    if (payload.stop_hook_active === true) process.exit(0);
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const signals = transcriptPath ? loadSignalsSafely(transcriptPath) : null;
    if (!signals || !hasAnyStruggleSignal(signals)) process.exit(0);
    const related = searchCaveatsSafely(CURSOR_HOST, signals.errorSnippets.map((failureText) => ({
      topicText: '',
      failureText,
      surface: 'stop' as const,
    })));
    queueStopForSession(CURSOR_HOST, sessionId, signals, related, () => stopReminderText(signals, related, 'native-cli'));
    process.exit(0);
  }

  process.stderr.write(`[caveat:cursor-hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
