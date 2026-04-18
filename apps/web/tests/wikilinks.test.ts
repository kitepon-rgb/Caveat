import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/renderer.js';

describe('wikilinks plugin', () => {
  it('renders [[slug]] as /g/slug link', () => {
    const html = renderMarkdown('see [[rtx-5090-cuda]] for context');
    expect(html).toContain('<a href="/g/rtx-5090-cuda" class="wikilink">rtx-5090-cuda</a>');
  });

  it('renders [[slug|label]] with custom label', () => {
    const html = renderMarkdown('see [[rtx-5090-cuda|RTX issue]]');
    expect(html).toContain('<a href="/g/rtx-5090-cuda" class="wikilink">RTX issue</a>');
  });

  it('does not interfere with standard markdown links', () => {
    const html = renderMarkdown('[external](https://example.com)');
    expect(html).toContain('<a href="https://example.com">external</a>');
  });

  it('leaves [[ ... ]] alone when no closing found on same input', () => {
    const html = renderMarkdown('incomplete [[no close');
    expect(html).toContain('[[no close');
    expect(html).not.toContain('<a ');
  });

  it('URL-encodes slug', () => {
    const html = renderMarkdown('[[hello world]]');
    expect(html).toContain('href="/g/hello%20world"');
  });
});
