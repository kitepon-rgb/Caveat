import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from './context.js';
import { handleSearch, searchInputShape, type SearchArgs } from './tools/search.js';
import { handleGet, getInputShape, type GetArgs } from './tools/get.js';
import { handleRecord, recordInputShape, type RecordArgs } from './tools/record.js';
import { handleUpdate, updateInputShape, type UpdateArgs } from './tools/update.js';
import { handleListRecent, listRecentInputShape, type ListRecentArgs } from './tools/listRecent.js';
import { handlePull, pullInputShape, type PullArgs } from './tools/pull.js';

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function registerAllTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'caveat_search',
    {
      title: 'caveat_search',
      description:
        'Search the "caveats" knowledge base — records of time-wasting traps in EXTERNAL specs (GPU/driver/CUDA versions, native-module builds, IDE/shell quirks, platform-specific behavior, library version incompatibilities) that someone already diagnosed. Call this FIRST when a problem smells environmental rather than a logic bug — before reading stack traces top-to-bottom or trying fixes. Query: 3+ chars, plain tokens only (no OR/NEAR/other FTS5 operators). Returns summary rows including `{id, source}` — pass BOTH to caveat_get for the full body.',
      inputSchema: searchInputShape,
    },
    async (args) => jsonResult(handleSearch(ctx, args as SearchArgs)),
  );

  server.registerTool(
    'caveat_get',
    {
      title: 'caveat_get',
      description:
        'Fetch the full body (frontmatter + H2 sections + text) of a caveat by id. IMPORTANT: when the id came from caveat_search, you MUST pass the `source` field from that same result (e.g., "community/Caveat"). The default source is "own" only; omitting source for a community entry returns not-found.',
      inputSchema: getInputShape,
    },
    async (args) => jsonResult(handleGet(ctx, args as GetArgs)),
  );

  server.registerTool(
    'caveat_record',
    {
      title: 'caveat_record',
      description:
        'Create a new caveat: a record of an external-spec trap that wasted real time (wrong driver, version mismatch, platform bug, IDE quirk, native-module issue, etc.) so future sessions can find it via caveat_search. REQUIRED BEFORE CALLING: (1) run caveat_search first to avoid duplicates, (2) ASK THE USER whether this should be `public` (shareable to the community DB) or `private` (kept local only) — never auto-classify visibility; the user owns the knowledge and decides its reach. Qualifies: specific symptom + diagnosed cause (or `outcome: impossible` verdict) + environment fingerprint. Does NOT qualify: project-internal bugs, user preferences, session summaries, ephemeral task notes. Auto-fills source_session and environment defaults; source_project is left null by design (shared knowledge must not leak per-user project names).',
      inputSchema: recordInputShape,
    },
    async (args) => jsonResult(handleRecord(ctx, args as RecordArgs)),
  );

  server.registerTool(
    'caveat_update',
    {
      title: 'caveat_update',
      description:
        'Patch an existing caveat — use when newer evidence extends or corrects one that already exists. Frontmatter shallow-merges, but array fields (tags etc.) REPLACE rather than append — to add one tag, read the current list first, then patch with the full new array. Sections match by case-insensitive H2 heading. Immutable keys: id, created_at, source_session, source_project. Common uses: bump `last_verified` after re-confirming, add a resolution when it was `tentative`, flip `outcome` to `impossible`.',
      inputSchema: updateInputShape,
    },
    async (args) => jsonResult(handleUpdate(ctx, args as UpdateArgs)),
  );

  server.registerTool(
    'caveat_list_recent',
    {
      title: 'caveat_list_recent',
      description:
        'List caveats ordered by updated_at DESC. Use for browsing recent additions — e.g., showing the user what is new after caveat_pull. Not for search; use caveat_search when you have a query.',
      inputSchema: listRecentInputShape,
    },
    async (args) => jsonResult(handleListRecent(ctx, args as ListRecentArgs)),
  );

  server.registerTool(
    'caveat_pull',
    {
      title: 'caveat_pull',
      description:
        "git-pull every subscribed community caveat repo (added via `caveat community add`) and re-index. Call when: (a) the user explicitly asks about others' knowledge on a topic, or (b) caveat_search returned empty for a query that feels like it should have hits and a subscribed repo might be stale. Do NOT call reflexively at session start — it is cheap but not free, and stale-by-minutes is acceptable. Safe and idempotent.",
      inputSchema: pullInputShape,
    },
    async (args) => jsonResult(await handlePull(ctx, args as PullArgs)),
  );
}
