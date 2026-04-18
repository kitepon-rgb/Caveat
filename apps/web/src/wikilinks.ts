import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

export interface WikilinksOptions {
  base?: string;
}

export function wikilinksPlugin(md: MarkdownIt, options: WikilinksOptions = {}): void {
  const base = options.base ?? '/g/';

  md.inline.ruler.before('emphasis', 'wikilink', (state: StateInline, silent: boolean) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const close = src.indexOf(']]', pos + 2);
    if (close === -1) return false;
    const inner = src.slice(pos + 2, close);
    if (inner.length === 0 || inner.includes('\n') || inner.includes('[')) return false;

    if (!silent) {
      const pipe = inner.indexOf('|');
      const slug = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
      if (!slug) return false;

      const open = state.push('link_open', 'a', 1);
      open.attrs = [
        ['href', `${base}${encodeURIComponent(slug)}`],
        ['class', 'wikilink'],
      ];
      const text = state.push('text', '', 0);
      text.content = label || slug;
      state.push('link_close', 'a', -1);
    }

    state.pos = close + 2;
    return true;
  });
}
