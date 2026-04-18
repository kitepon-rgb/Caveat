import matter from 'gray-matter';
import yaml from 'js-yaml';
import type { Frontmatter } from './types.js';

const yamlEngine = (input: string): object =>
  (yaml.load(input, { schema: yaml.JSON_SCHEMA }) ?? {}) as object;

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  body: string;
  sections: Record<string, string>;
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const parsed = matter(source, { engines: { yaml: yamlEngine } });
  return {
    frontmatter: parsed.data as Frontmatter,
    body: parsed.content,
    sections: extractSections(parsed.content),
  };
}

export function extractSections(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let heading: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (heading !== null) result[heading] = buf.join('\n').trim();
      heading = m[1]!.trim();
      buf = [];
    } else if (heading !== null) {
      buf.push(line);
    }
  }
  if (heading !== null) result[heading] = buf.join('\n').trim();
  return result;
}
