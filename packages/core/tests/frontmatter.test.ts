import { describe, it, expect } from 'vitest';
import { parseMarkdown, extractSections } from '../src/frontmatter.js';

const validMd = `---
id: foo
title: Foo
visibility: public
confidence: reproduced
tags: [a, b]
environment:
  gpu: RTX 5090
  cuda: "<12.5"
source_project: p
source_session: "2026-04-18T00:00:00Z/deadbeef1234"
created_at: 2026-04-18
updated_at: 2026-04-18
---

## Symptom
sym-text

## Cause
cau-text
`;

describe('parseMarkdown', () => {
  it('parses frontmatter and body', () => {
    const p = parseMarkdown(validMd);
    expect(p.frontmatter.id).toBe('foo');
    expect(p.frontmatter.tags).toEqual(['a', 'b']);
    expect(p.frontmatter.environment.cuda).toBe('<12.5');
    expect(p.sections.Symptom).toBe('sym-text');
    expect(p.sections.Cause).toBe('cau-text');
  });

  it('rejects unsafe YAML tags via JSON_SCHEMA', () => {
    const src = `---
id: foo
bad: !!js/function "function () { return 1 }"
---
body
`;
    expect(() => parseMarkdown(src)).toThrow();
  });
});

describe('extractSections', () => {
  it('splits by H2 headings', () => {
    const body = `intro

## One
first

## Two
second
`;
    const s = extractSections(body);
    expect(s.One).toBe('first');
    expect(s.Two).toBe('second');
  });

  it('returns empty object when no H2', () => {
    expect(extractSections('plain text')).toEqual({});
  });
});
