import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from './context.js';
import { handleSearch, searchInputShape, type SearchArgs } from './tools/search.js';
import { handleGet, getInputShape, type GetArgs } from './tools/get.js';
import { handleRecord, recordInputShape, type RecordArgs } from './tools/record.js';
import { handleUpdate, updateInputShape, type UpdateArgs } from './tools/update.js';
import { handleListRecent, listRecentInputShape, type ListRecentArgs } from './tools/listRecent.js';
import { handleNlmBriefFor, nlmBriefForInputShape, type NlmBriefForArgs } from './tools/nlmBriefFor.js';
import {
  handleIngestResearch,
  ingestResearchInputShape,
  type IngestResearchArgs,
} from './tools/ingestResearch.js';
import { handlePull, pullInputShape, type PullArgs } from './tools/pull.js';
import { handlePush, pushInputShape, type PushArgs } from './tools/push.js';

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
        'Full-text search across caveats (external spec gotchas). Returns summary; use caveat_get for body.',
      inputSchema: searchInputShape,
    },
    async (args) => jsonResult(handleSearch(ctx, args as SearchArgs)),
  );

  server.registerTool(
    'caveat_get',
    {
      title: 'caveat_get',
      description: 'Fetch full caveat by id (frontmatter + sections + body).',
      inputSchema: getInputShape,
    },
    async (args) => jsonResult(handleGet(ctx, args as GetArgs)),
  );

  server.registerTool(
    'caveat_record',
    {
      title: 'caveat_record',
      description:
        'Create a new caveat markdown file. Auto-fills source_session and environment fingerprint for unspecified keys. source_project is left null by design (publicly-shared knowledge should not leak per-user project names).',
      inputSchema: recordInputShape,
    },
    async (args) => jsonResult(handleRecord(ctx, args as RecordArgs)),
  );

  server.registerTool(
    'caveat_update',
    {
      title: 'caveat_update',
      description:
        'Patch an existing caveat. Frontmatter shallow-merges (arrays replace). Sections matched by case-insensitive H2 heading. Immutable keys: id, created_at, source_session, source_project, brief_id.',
      inputSchema: updateInputShape,
    },
    async (args) => jsonResult(handleUpdate(ctx, args as UpdateArgs)),
  );

  server.registerTool(
    'caveat_list_recent',
    {
      title: 'caveat_list_recent',
      description: 'List caveats by updated_at DESC.',
      inputSchema: listRecentInputShape,
    },
    async (args) => jsonResult(handleListRecent(ctx, args as ListRecentArgs)),
  );

  server.registerTool(
    'nlm_brief_for',
    {
      title: 'nlm_brief_for',
      description:
        'Generate a NotebookLM research brief for a topic. Returns {brief_id, text}. brief_id can be passed to ingest_research when the NLM output is ready. Stateless — brief_id is not persisted until ingest_research fires.',
      inputSchema: nlmBriefForInputShape,
    },
    async (args) => jsonResult(handleNlmBriefFor(ctx, args as NlmBriefForArgs)),
  );

  server.registerTool(
    'ingest_research',
    {
      title: 'ingest_research',
      description:
        'Create a caveat from NotebookLM research output. Always records with confidence: tentative. Pass brief_id to link back to the originating brief.',
      inputSchema: ingestResearchInputShape,
    },
    async (args) => jsonResult(handleIngestResearch(ctx, args as IngestResearchArgs)),
  );

  server.registerTool(
    'caveat_pull',
    {
      title: 'caveat_pull',
      description:
        'git-pull all subscribed community caveat repos (incl. the shared DB) and re-index. Call this when the user asks if others have documented a similar trap, or at the start of a session that might benefit from fresh external knowledge. Safe and idempotent — re-running is cheap.',
      inputSchema: pullInputShape,
    },
    async (args) => jsonResult(await handlePull(ctx, args as PullArgs)),
  );

  server.registerTool(
    'caveat_push',
    {
      title: 'caveat_push',
      description:
        "Contribute a user-owned caveat to the shared community DB via fork + PR. Call this after caveat_record when the entry looks genuinely reusable by others (not a one-off project tie-in, not duplicated by existing community entries). Requires the `gh` CLI on the user's machine; returns status=gh-missing or gh-unauthed when unavailable. Use dry_run=true to preview without touching GitHub.",
      inputSchema: pushInputShape,
    },
    async (args) => jsonResult(await handlePush(ctx, args as PushArgs)),
  );
}
