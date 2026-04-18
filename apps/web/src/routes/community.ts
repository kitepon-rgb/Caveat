import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { WebContext } from '../context.js';
import { escapeHtml, layout } from '../layout.js';

interface CommunityHandle {
  handle: string;
  path: string;
  entriesCount: number;
}

function listCommunity(communityDir: string, db: WebContext['db']): CommunityHandle[] {
  if (!existsSync(communityDir)) return [];
  const handles: CommunityHandle[] = [];
  for (const entry of readdirSync(communityDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const handlePath = join(communityDir, entry.name);
    const countRow = db
      .prepare('SELECT COUNT(*) AS n FROM entries WHERE source = ?')
      .get(`community/${entry.name}`) as { n: number } | undefined;
    handles.push({
      handle: entry.name,
      path: handlePath,
      entriesCount: countRow?.n ?? 0,
    });
  }
  return handles;
}

export function createCommunityRoute(ctx: WebContext): Hono {
  const app = new Hono();

  app.get('/community', (c) => {
    const handles = listCommunity(ctx.paths.communityDir, ctx.db);

    const list = handles
      .map((h) => {
        let mtime = '';
        try {
          mtime = statSync(h.path).mtime.toISOString().slice(0, 10);
        } catch {
          mtime = '';
        }
        return `
      <li>
        <a class="title" href="/?source=community/${encodeURIComponent(h.handle)}">${escapeHtml(h.handle)}</a>
        <div class="meta">
          <span class="badge">${h.entriesCount} entries</span>
          ${mtime ? `<span>clone mtime: ${escapeHtml(mtime)}</span>` : ''}
        </div>
      </li>`;
      })
      .join('');

    const body = `
<h2 style="margin-top:0">community repos</h2>
${
  handles.length > 0
    ? `<ul class="entries">${list}</ul>`
    : `<div class="empty">no community repos imported yet. Use <code>caveat community add &lt;github-url&gt;</code>.</div>`
}
<p style="font-size:0.85rem;color:#666">To update: run <code>caveat community pull</code> in a terminal, then <code>caveat index</code>.</p>`;

    return c.html(layout('community · Caveat', body));
  });

  return app;
}
