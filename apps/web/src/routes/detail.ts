import { Hono } from 'hono';
import { get, type Source } from '@caveat/core';
import type { WebContext } from '../context.js';
import { escapeHtml, layout } from '../layout.js';
import { renderMarkdown } from '../renderer.js';

export function createDetailRoute(ctx: WebContext): Hono {
  const app = new Hono();

  app.get('/g/:id', (c) => {
    const id = c.req.param('id');
    const sourceParam = c.req.query('source') ?? 'own';
    const source = sourceParam as Source;

    const entry = get(ctx.db, id, source);
    if (!entry) {
      c.status(404);
      return c.html(
        layout('not found', `<div class="empty">not found: ${escapeHtml(id)} in ${escapeHtml(sourceParam)}</div>`),
      );
    }

    const fm = entry.frontmatter;
    const envRows = Object.entries(fm.environment ?? {})
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
      .join('');

    const visibilityBadge =
      fm.visibility === 'private'
        ? `<span class="badge private" title="local-only — never pushed to community DB">🔒 private</span>`
        : `<span class="badge public">public</span>`;
    const metaRows: string[] = [
      `<dt>id</dt><dd><code>${escapeHtml(fm.id)}</code></dd>`,
      `<dt>source</dt><dd>${escapeHtml(entry.source)}</dd>`,
      `<dt>visibility</dt><dd>${visibilityBadge}</dd>`,
      `<dt>confidence</dt><dd><span class="badge ${escapeHtml(fm.confidence)}">${escapeHtml(fm.confidence)}</span></dd>`,
    ];
    if (fm.outcome) {
      metaRows.push(
        `<dt>outcome</dt><dd><span class="badge ${escapeHtml(fm.outcome)}">${escapeHtml(fm.outcome)}</span></dd>`,
      );
    }
    if (fm.tags && fm.tags.length > 0) {
      const tagLinks = fm.tags
        .map((t) => `<a href="/?tag=${encodeURIComponent(t)}">${escapeHtml(t)}</a>`)
        .join(', ');
      metaRows.push(`<dt>tags</dt><dd>${tagLinks}</dd>`);
    }
    metaRows.push(`<dt>created</dt><dd>${escapeHtml(fm.created_at)}</dd>`);
    metaRows.push(`<dt>updated</dt><dd>${escapeHtml(fm.updated_at)}</dd>`);
    if (fm.last_verified) {
      metaRows.push(`<dt>last verified</dt><dd>${escapeHtml(fm.last_verified)}</dd>`);
    }
    metaRows.push(`<dt>path</dt><dd><code>${escapeHtml(entry.path)}</code></dd>`);

    const rendered = renderMarkdown(entry.body);
    const body = `
<article>
  <h2 style="margin-top:0">${escapeHtml(fm.title)}</h2>
  <dl class="meta-grid">
    ${metaRows.join('\n    ')}
    ${envRows ? `<dt>environment</dt><dd><dl class="meta-grid" style="margin:0">${envRows}</dl></dd>` : ''}
  </dl>
  ${rendered}
</article>`;

    return c.html(layout(`${fm.title} · Caveat`, body));
  });

  return app;
}
