import MarkdownIt from 'markdown-it';
import { wikilinksPlugin } from './wikilinks.js';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
}).use(wikilinksPlugin);

export function renderMarkdown(source: string): string {
  return md.render(source);
}
