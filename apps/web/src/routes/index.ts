import { Hono } from 'hono';
import { search, listRecent, type SearchFilters, type SearchResult } from '@caveat/core';
import type { WebContext } from '../context.js';
import { escapeHtml, layout } from '../layout.js';

export function createIndexRoute(ctx: WebContext): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    const sourceParam = c.req.query('source');
    const tagParam = c.req.query('tag');

    const filters: SearchFilters = {};
    if (sourceParam === 'own' || sourceParam === 'community' || sourceParam === 'all') {
      filters.source = sourceParam;
    }
    if (tagParam) {
      filters.tags = [tagParam];
    }

    const results: SearchResult[] = q
      ? search(ctx.db, { query: q, filters, limit: 50 })
      : listRecent(ctx.db, 50);

    const rows = results
      .map((r) => {
        const envEntries = Object.entries(r.environment ?? {});
        const envSummary = envEntries
          .slice(0, 3)
          .map(([k, v]) => `${escapeHtml(k)}:${escapeHtml(String(v))}`)
          .join(' ');
        const hrefSource =
          r.source === 'own' ? '' : `?source=${encodeURIComponent(r.source)}`;
        return `
      <li>
        <a class="title" href="/g/${encodeURIComponent(r.id)}${hrefSource}">${escapeHtml(r.title)}</a>
        <div class="meta">
          <span class="badge ${escapeHtml(r.confidence ?? '')}">${escapeHtml(r.confidence ?? '')}</span>
          <span class="badge">${escapeHtml(r.source)}</span>
          ${envSummary ? `<span>${envSummary}</span>` : ''}
        </div>
        ${r.symptomExcerpt ? `<div class="excerpt">${escapeHtml(r.symptomExcerpt)}</div>` : ''}
      </li>`;
      })
      .join('');

    const body = `
<form class="search" method="get" action="/">
  <input type="text" name="q" placeholder="search (3+ chars for CJK)" value="${escapeHtml(q)}">
  <select name="source">
    <option value="" ${!sourceParam ? 'selected' : ''}>all sources</option>
    <option value="own" ${sourceParam === 'own' ? 'selected' : ''}>own</option>
    <option value="community" ${sourceParam === 'community' ? 'selected' : ''}>community</option>
  </select>
  <button type="submit">search</button>
</form>
${
  results.length > 0
    ? `<ul class="entries">${rows}</ul>`
    : `<div class="empty">${q ? `no results for "${escapeHtml(q)}"` : 'no entries yet — run <code>caveat index</code> after adding md files'}</div>`
}`;

    const title = q ? `search: ${q} · Caveat` : 'Caveat';
    return c.html(layout(title, body));
  });

  return app;
}
