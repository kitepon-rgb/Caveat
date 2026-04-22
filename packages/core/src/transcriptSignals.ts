import { existsSync, readFileSync } from 'node:fs';

const MAX_ERROR_SNIPPETS = 10;
const MAX_ERROR_SNIPPET_LENGTH = 300;
const MAX_SEARCH_QUERIES = 10;
const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_FILE_EDIT_ENTRIES = 20;

export interface FileEditCount {
  path: string;
  count: number;
}

export interface SessionSignals {
  toolFailureCount: number;
  /** Only files edited more than once are listed; single-edit files are dropped. */
  fileEditCounts: FileEditCount[];
  webSearchCount: number;
  webFetchCount: number;
  /** Number of distinct Bash commands that were issued more than once. */
  bashRetryCount: number;
  durationMinutes: number;
  errorSnippets: string[];
  searchQueries: string[];
}

interface RawTranscriptLine {
  type?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (isRecord(c) && typeof c.text === 'string') parts.push(c.text);
    }
    return parts.join(' ');
  }
  return '';
}

function parseTimestamp(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Parse a Claude Code session JSONL transcript and extract objective
 * struggle-fingerprint signals. Returns null when the file is missing /
 * unreadable; returns an empty-ish struct when the file exists but has no
 * usable content. Hook callers should treat both cases as "no struggle
 * detected" via `hasAnyStruggleSignal`.
 */
export function readSessionSignals(transcriptPath: string): SessionSignals | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const editCounts = new Map<string, number>();
  const bashCounts = new Map<string, number>();
  const errorSnippets: string[] = [];
  const searchQueries: string[] = [];
  let toolFailureCount = 0;
  let webSearchCount = 0;
  let webFetchCount = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;

    let parsed: RawTranscriptLine;
    try {
      parsed = JSON.parse(line) as RawTranscriptLine;
    } catch {
      continue;
    }

    const ts = parseTimestamp(parsed.timestamp);
    if (ts !== undefined) {
      if (firstTs === undefined || ts < firstTs) firstTs = ts;
      if (lastTs === undefined || ts > lastTs) lastTs = ts;
    }

    if (parsed.type !== 'assistant' && parsed.type !== 'user') continue;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;

    for (const item of content) {
      if (!isRecord(item)) continue;

      if (item.type === 'tool_use') {
        const name = item.name;
        const input = isRecord(item.input) ? item.input : {};
        if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
          const p = typeof input.file_path === 'string' ? input.file_path : '';
          if (p) editCounts.set(p, (editCounts.get(p) ?? 0) + 1);
        } else if (name === 'WebSearch') {
          webSearchCount += 1;
          if (typeof input.query === 'string' && searchQueries.length < MAX_SEARCH_QUERIES) {
            searchQueries.push(input.query.slice(0, MAX_SEARCH_QUERY_LENGTH));
          }
        } else if (name === 'WebFetch') {
          webFetchCount += 1;
        } else if (name === 'Bash') {
          const cmd = typeof input.command === 'string' ? input.command : '';
          if (cmd) bashCounts.set(cmd, (bashCounts.get(cmd) ?? 0) + 1);
        }
      } else if (item.type === 'tool_result') {
        if (item.is_error === true) {
          toolFailureCount += 1;
          const text = extractResultText(item.content).replace(/\s+/g, ' ').trim();
          if (text && errorSnippets.length < MAX_ERROR_SNIPPETS) {
            errorSnippets.push(text.slice(0, MAX_ERROR_SNIPPET_LENGTH));
          }
        }
      }
    }
  }

  const fileEditCounts: FileEditCount[] = [...editCounts.entries()]
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

/**
 * Gate: any objective fingerprint that this session involved external-spec
 * friction. Uses only structural "did-this-happen" checks (>0 counts, any
 * repeat), never tuned thresholds or hardcoded word lists.
 */
export function hasAnyStruggleSignal(s: SessionSignals): boolean {
  return (
    s.toolFailureCount > 0 ||
    s.fileEditCounts.length > 0 ||
    s.webSearchCount > 0 ||
    s.webFetchCount > 0 ||
    s.bashRetryCount > 0
  );
}

/**
 * Combine struggle evidence (tool error messages + web search queries) into
 * a single text blob suitable for feeding into findCaveatsForPrompt — the
 * same co-occurrence FTS used by the pre-firing hook.
 */
export function struggleSearchText(s: SessionSignals): string {
  return [...s.errorSnippets, ...s.searchQueries].join(' ');
}
