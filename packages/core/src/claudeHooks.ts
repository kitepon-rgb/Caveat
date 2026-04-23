import type { DatabaseSync } from 'node:sqlite';
import type { SearchResult, Source, Confidence, Visibility } from './types.js';
import { extractSections } from './frontmatter.js';
import type { SessionSignals } from './transcriptSignals.js';

const PROMPT_TOKEN_MIN_LENGTH = 3;
const PROMPT_MAX_CANDIDATE_TOKENS = 50;
const DEFAULT_REMINDER_HIT_LIMIT = 5;
const SYMPTOM_EXCERPT_LENGTH = 200;
const SYMPTOM_LINE_MAX = 120;
// Minimum number of distinct prompt tokens that must co-occur in an entry for
// it to count as a hit. A prompt with only 1 candidate token falls back to 1
// (plain OR). With ≥ 2 tokens we require co-occurrence, which naturally
// suppresses matches driven by single common words like `make` / `new` /
// `script` without needing a hand-curated stopword list.
const MIN_DISTINCT_TOKEN_MATCHES_CEILING = 2;

// Hiragana / Katakana / CJK unified ideographs / halfwidth-katakana. Japanese
// prompts often run together without spaces, so CJK tokens get sliding-window
// split into 3-char pieces to align with the trigram tokenizer used on the
// stored side (see CLAUDE.md "FTS5 trigram は 3 文字以上のクエリが必要").
const CJK_CHAR = /[぀-ゟ゠-ヿ一-鿿ｦ-ﾟ]/;

function isCjkDominated(token: string): boolean {
  return CJK_CHAR.test(token);
}

function expandToken(token: string, out: string[]): void {
  if (isCjkDominated(token)) {
    if (token.length < PROMPT_TOKEN_MIN_LENGTH) return;
    for (let i = 0; i <= token.length - PROMPT_TOKEN_MIN_LENGTH; i++) {
      out.push(token.slice(i, i + PROMPT_TOKEN_MIN_LENGTH));
    }
  } else if (token.length >= PROMPT_TOKEN_MIN_LENGTH) {
    out.push(token);
  }
}

/**
 * Extract candidate search tokens from a prompt. Returns an ordered,
 * case-insensitively deduped list. ASCII words shorter than 3 chars are
 * dropped; CJK runs are expanded into overlapping 3-char windows so that
 * prompts like `なぜか初期化失敗する` can hit stored entries containing
 * `初期化失敗`. No semantic filtering (stopwords, etc.) happens here — the
 * caller reaches signal via co-occurrence (findCaveatsForPrompt).
 */
export function extractPromptCandidates(prompt: unknown): string[] {
  if (typeof prompt !== 'string' || prompt.length === 0) return [];
  const cleaned = prompt.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const rawTokens = cleaned.split(/\s+/).filter((t) => t.length > 0);

  const expanded: string[] = [];
  for (const t of rawTokens) expandToken(t, expanded);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of expanded) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }

  return unique.slice(0, PROMPT_MAX_CANDIDATE_TOKENS);
}

interface EntryRow {
  rowid: number;
  id: string;
  source: string;
  path: string;
  title: string;
  body: string;
  frontmatter_json: string;
  tags: string;
  confidence: string;
  visibility: string;
  file_mtime: string;
  indexed_at: string;
}

function toSearchResult(row: EntryRow): SearchResult {
  const fm = JSON.parse(row.frontmatter_json);
  const symptomMatch = /##\s+Symptom\s*\n([\s\S]*?)(?=\n##|\n*$)/.exec(row.body);
  const symptom = symptomMatch?.[1]?.trim() ?? row.body;
  return {
    id: row.id,
    source: row.source as Source,
    title: row.title,
    symptomExcerpt: symptom.slice(0, SYMPTOM_EXCERPT_LENGTH),
    confidence: row.confidence as Confidence,
    visibility: (row.visibility as Visibility) ?? 'public',
    environment: fm.environment ?? {},
  };
}

/**
 * Search the caveat DB for entries that share ≥ N distinct prompt tokens,
 * where N = min(2, total candidate tokens). This co-occurrence requirement
 * is what replaces the keyword-allowlist and stopword-list approaches — a
 * single common word like `make` can't fire a match by itself, but a
 * prompt that shares two or more distinct technical tokens with an entry
 * will. No hand-maintained lists, no magic thresholds.
 */
export function findCaveatsForPrompt(
  db: DatabaseSync,
  prompt: unknown,
  opts: { limit?: number } = {},
): SearchResult[] {
  const tokens = extractPromptCandidates(prompt);
  if (tokens.length === 0) return [];

  const minMatches = Math.min(MIN_DISTINCT_TOKEN_MATCHES_CEILING, tokens.length);
  const perEntry = new Map<number, { count: number; row: EntryRow }>();

  const stmt = db.prepare(
    'SELECT e.* FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?',
  );

  for (const tok of tokens) {
    let rows: EntryRow[] = [];
    try {
      rows = stmt.all(`"${tok}"`) as unknown as EntryRow[];
    } catch {
      // Malformed FTS phrase for this token — skip it. Remaining tokens
      // still contribute to co-occurrence counts.
      continue;
    }
    for (const row of rows) {
      const existing = perEntry.get(row.rowid);
      if (existing) existing.count += 1;
      else perEntry.set(row.rowid, { count: 1, row });
    }
  }

  const limit = opts.limit ?? DEFAULT_REMINDER_HIT_LIMIT;
  return [...perEntry.values()]
    .filter(({ count }) => count >= minMatches)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(({ row }) => toSearchResult(row));
}

export function toolErrorReminderText(hits: SearchResult[]): string {
  const lines: string[] = [];
  lines.push(
    `[caveat] 直前のエラーに一致する可能性のある既知の罠が ${hits.length} 件あります:`,
  );
  lines.push('');
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.id} (${h.source}) — ${h.title}`);
    const excerpt = h.symptomExcerpt.replace(/\s+/g, ' ').trim().slice(0, SYMPTOM_LINE_MAX);
    if (excerpt) lines.push(`   症状: ${excerpt}`);
  });
  lines.push('');
  lines.push(
    'mcp__caveat__caveat_get で詳細を確認し、documented な対処があれば適用してください。無関係と判断したら無視して続行で OK。',
  );
  return lines.join('\n');
}

export function userPromptSubmitReminderText(hits: SearchResult[]): string {
  const lines: string[] = [];
  lines.push(
    `[caveat] このプロンプトに関連する可能性のある既知の罠が ${hits.length} 件あります:`,
  );
  lines.push('');
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${h.id} (${h.source}) — ${h.title}`);
    const excerpt = h.symptomExcerpt.replace(/\s+/g, ' ').trim().slice(0, SYMPTOM_LINE_MAX);
    if (excerpt) lines.push(`   症状: ${excerpt}`);
  });
  lines.push('');
  lines.push(
    '詳細は mcp__caveat__caveat_get に id + source を渡して取得。environment が一致するか確認してから適用判断してください。無関係と判断したら無視して続行で OK。',
  );
  return lines.join('\n');
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Build the Stop-hook reminder from objective session signals and any
 * caveat DB entries whose content co-occurs with the session's error /
 * search text. The reminder stays silent elsewhere — the caller is
 * expected to gate via hasAnyStruggleSignal.
 */
export function stopReminderText(
  signals: SessionSignals,
  related: SearchResult[],
): string {
  const lines: string[] = [];
  lines.push('[caveat] このセッションで外部仕様の罠に当たった可能性を示すシグナル:');

  if (signals.toolFailureCount > 0) {
    lines.push(`- tool failure: ${signals.toolFailureCount} 件`);
  }
  if (signals.fileEditCounts.length > 0) {
    const top = signals.fileEditCounts
      .slice(0, 3)
      .map((e) => `${shortPath(e.path)} × ${e.count}`)
      .join(', ');
    lines.push(`- 同一ファイル複数編集: ${top}`);
  }
  if (signals.webSearchCount > 0) {
    const sample = signals.searchQueries[0];
    const note = sample ? ` (例: "${sample.slice(0, 60)}")` : '';
    lines.push(`- WebSearch: ${signals.webSearchCount} 回${note}`);
  }
  if (signals.webFetchCount > 0) {
    lines.push(`- WebFetch: ${signals.webFetchCount} 回`);
  }
  if (signals.bashRetryCount > 0) {
    lines.push(`- 同一 Bash コマンドの再実行: ${signals.bashRetryCount} 種`);
  }
  if (signals.durationMinutes > 0) {
    lines.push(`- 経過時間: ${signals.durationMinutes} 分`);
  }

  const externalLookup = signals.webSearchCount + signals.webFetchCount > 0;
  lines.push(
    `- 分類ヒント: ${
      externalLookup
        ? '外部仕様調査あり → public 寄り'
        : '外部調査なし → private 寄り'
    }`,
  );

  lines.push('');

  if (related.length > 0) {
    lines.push(
      `セッション内容と共起する既存罠 ${related.length} 件（関連があれば mcp__caveat__caveat_update で last_verified を更新 or 追記）:`,
    );
    related.forEach((h, i) => {
      lines.push(`${i + 1}. ${h.id} (${h.source}) — ${h.title}`);
    });
    lines.push('');
    lines.push(
      '上記と異なる新規の罠を踏んでいたら mcp__caveat__caveat_record で登録してください。outcome: impossible（現状の制約では不可能と判定した結論）も記録対象。',
    );
  } else {
    lines.push(
      '既存罠に該当なし。外部仕様の罠に苦戦していたなら mcp__caveat__caveat_record で登録してください。outcome: impossible も記録対象。',
    );
  }
  lines.push(
    '記録時は tool 説明の二項基準で visibility を選ぶ（public = 第三者再現可能 / private = repo 固有）。迷ったら private。',
  );

  return lines.join('\n');
}
