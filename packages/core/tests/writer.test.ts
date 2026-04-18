import { describe, it, expect } from 'vitest';
import { buildEntry } from '../src/writer.js';
import { parseMarkdown } from '../src/frontmatter.js';
import type { Frontmatter } from '../src/types.js';

function sampleFrontmatter(): Frontmatter {
  return {
    id: 'sample',
    title: 'Sample',
    visibility: 'public',
    confidence: 'reproduced',
    outcome: 'resolved',
    tags: ['foo', 'bar'],
    environment: { gpu: 'RTX 5090', cuda: '>=12.5' },
    source_project: null,
    source_session: '2026-04-18T00:00:00.000Z/abcdef012345',
    created_at: '2026-04-18',
    updated_at: '2026-04-18',
    last_verified: '2026-04-18',
  };
}

describe('buildEntry', () => {
  it('serializes frontmatter + sections and round-trips via parseMarkdown', () => {
    const fm = sampleFrontmatter();
    const sections = {
      Symptom: 'symptom text',
      Cause: 'cause text',
      Resolution: 'resolution text',
      Evidence: '- https://example.com',
    };
    const { content } = buildEntry(fm, sections);
    expect(content.startsWith('---\n')).toBe(true);

    const parsed = parseMarkdown(content);
    expect(parsed.frontmatter.id).toBe('sample');
    expect(parsed.frontmatter.outcome).toBe('resolved');
    expect(parsed.frontmatter.last_verified).toBe('2026-04-18');
    expect(parsed.sections['Symptom']).toBe('symptom text');
    expect(parsed.sections['Evidence']).toBe('- https://example.com');
  });

  it('preserves section order', () => {
    const fm = sampleFrontmatter();
    const sections = {
      Context: 'ctx',
      Symptom: 'sym',
      Cause: 'c',
      Resolution: 'r',
      Evidence: 'e',
    };
    const { content } = buildEntry(fm, sections);
    const contextIdx = content.indexOf('## Context');
    const symptomIdx = content.indexOf('## Symptom');
    const evidenceIdx = content.indexOf('## Evidence');
    expect(contextIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(symptomIdx);
    expect(symptomIdx).toBeLessThan(evidenceIdx);
  });
});
