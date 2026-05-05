import { existsSync, readFileSync } from 'node:fs';
import type { SessionSignals } from './transcriptSignals.js';

const MAX_ERROR_SNIPPETS = 10;
const MAX_ERROR_SNIPPET_LENGTH = 300;
const MAX_SEARCH_QUERIES = 10;
const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_FILE_EDIT_ENTRIES = 20;

interface CodexTranscriptLine {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  command?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTimestamp(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractExitCode(output: string): number | null {
  const m = /Process exited with code\s+(-?\d+)/.exec(output);
  return m ? Number(m[1]) : null;
}

function extractCommand(name: string, args: Record<string, unknown>): string | undefined {
  if (name !== 'exec_command' && name !== 'Bash') return undefined;
  const cmd = args.cmd ?? args.command;
  return typeof cmd === 'string' && cmd.length > 0 ? cmd : undefined;
}

function addEditPath(editCounts: Map<string, number>, path: unknown): void {
  if (typeof path !== 'string' || path.length === 0) return;
  editCounts.set(path, (editCounts.get(path) ?? 0) + 1);
}

function collectPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (m?.[1]) paths.push(m[1]);
  }
  return paths;
}

function collectSearchQueries(args: Record<string, unknown>): string[] {
  const queries: string[] = [];
  const rawSearch = args.search_query;
  if (Array.isArray(rawSearch)) {
    for (const item of rawSearch) {
      if (isRecord(item) && typeof item.q === 'string') queries.push(item.q);
    }
  }
  if (typeof args.query === 'string') queries.push(args.query);
  if (typeof args.q === 'string') queries.push(args.q);
  return queries;
}

function addQuery(searchQueries: string[], query: string): void {
  if (searchQueries.length >= MAX_SEARCH_QUERIES) return;
  searchQueries.push(query.slice(0, MAX_SEARCH_QUERY_LENGTH));
}

/**
 * Parse a Codex JSONL rollout transcript and extract the same struggle signals
 * Caveat already uses for Claude Stop hooks.
 */
export function readCodexSessionSignals(transcriptPath: string): SessionSignals | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const editCounts = new Map<string, number>();
  const bashCounts = new Map<string, number>();
  const toolCalls = new Map<string, ToolCallInfo>();
  const errorSnippets: string[] = [];
  const searchQueries: string[] = [];
  const failedCallIds = new Set<string>();
  let toolFailureCount = 0;
  let webSearchCount = 0;
  let webFetchCount = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;

    let parsed: CodexTranscriptLine;
    try {
      parsed = JSON.parse(line) as CodexTranscriptLine;
    } catch {
      continue;
    }

    const ts = parseTimestamp(parsed.timestamp);
    if (ts !== undefined) {
      if (firstTs === undefined || ts < firstTs) firstTs = ts;
      if (lastTs === undefined || ts > lastTs) lastTs = ts;
    }

    if (!isRecord(parsed.payload)) continue;
    const payload = parsed.payload;

    if (parsed.type === 'response_item' && payload.type === 'function_call') {
      const name = typeof payload.name === 'string' ? payload.name : '';
      const args = parseArgs(payload.arguments);
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const command = extractCommand(name, args);
      if (callId && name) toolCalls.set(callId, { name, args, command });
      if (command) bashCounts.set(command, (bashCounts.get(command) ?? 0) + 1);

      if (name === 'apply_patch') {
        const patch = typeof args.patch === 'string' ? args.patch : '';
        for (const path of collectPatchPaths(patch)) addEditPath(editCounts, path);
      } else if (name === 'edit' || name === 'write' || name === 'notebook_edit') {
        addEditPath(editCounts, args.path ?? args.file_path);
      } else if (name === 'web.run') {
        const queries = collectSearchQueries(args);
        webSearchCount += queries.length;
        for (const query of queries) addQuery(searchQueries, query);
        if (Array.isArray(args.open)) webFetchCount += args.open.length;
      }
      continue;
    }

    if (parsed.type === 'response_item' && payload.type === 'web_search_call') {
      webSearchCount += 1;
      if (typeof payload.query === 'string') addQuery(searchQueries, payload.query);
      continue;
    }

    if (parsed.type === 'response_item' && payload.type === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const output = typeof payload.output === 'string' ? payload.output : '';
      const exit = extractExitCode(output);
      if (callId && exit !== null && exit !== 0 && !failedCallIds.has(callId)) {
        failedCallIds.add(callId);
        toolFailureCount += 1;
        const text = compactText(output);
        if (text && errorSnippets.length < MAX_ERROR_SNIPPETS) {
          errorSnippets.push(text.slice(0, MAX_ERROR_SNIPPET_LENGTH));
        }
      }
      continue;
    }

    if (parsed.type === 'event_msg' && payload.type === 'exec_command_end') {
      const exit = typeof payload.exit_code === 'number' ? payload.exit_code : null;
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      if (exit !== null && exit !== 0 && (!callId || !failedCallIds.has(callId))) {
        if (callId) failedCallIds.add(callId);
        toolFailureCount += 1;
        const output = typeof payload.output === 'string' ? payload.output : '';
        const text = compactText(output);
        if (text && errorSnippets.length < MAX_ERROR_SNIPPETS) {
          errorSnippets.push(text.slice(0, MAX_ERROR_SNIPPET_LENGTH));
        }
      }
    }
  }

  for (const { command } of toolCalls.values()) {
    if (!command) continue;
    if (!bashCounts.has(command)) bashCounts.set(command, 1);
  }

  const fileEditCounts = [...editCounts.entries()]
    .filter(([, c]) => c > 1)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_FILE_EDIT_ENTRIES);

  const bashRetryCount = [...bashCounts.values()].filter((c) => c > 1).length;
  const durationMinutes =
    firstTs !== undefined && lastTs !== undefined
      ? Math.max(0, Math.round((lastTs - firstTs) / 60000))
      : 0;

  return {
    toolFailureCount,
    fileEditCounts,
    webSearchCount,
    webFetchCount,
    bashRetryCount,
    durationMinutes,
    errorSnippets,
    searchQueries,
  };
}
