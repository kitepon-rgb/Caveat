import { describe, expect, it } from 'vitest';
import {
  evaluateHookProvenance,
  HookProvenanceArtifactError,
  HOOK_PROVENANCE_SCHEMA_VERSION,
  parseHookProvenanceGoldenJsonl,
  validateHookProvenanceCases,
  type HookProvenanceCase,
} from '../src/hookProvenanceEval.js';

const a = { id: 'entry-a', source: 'own' };
const b = { id: 'entry-b', source: 'community/team' };
const cases = (): HookProvenanceCase[] => [
  { schemaVersion: HOOK_PROVENANCE_SCHEMA_VERSION, caseId: 'prompt-positive', surface: 'user_prompt', topicText: 'alpha failed', failureText: 'alpha failed', expectedRefs: [a], kind: 'positive' },
  { schemaVersion: HOOK_PROVENANCE_SCHEMA_VERSION, caseId: 'error-negative', surface: 'tool_error', topicText: 'status', failureText: 'request failed', expectedRefs: [], kind: 'negative' },
  { schemaVersion: HOOK_PROVENANCE_SCHEMA_VERSION, caseId: 'stop-positive', surface: 'stop', topicText: 'beta', failureText: 'beta failed', expectedRefs: [b], kind: 'positive' },
  { schemaVersion: HOOK_PROVENANCE_SCHEMA_VERSION, caseId: 'stop-query-only', surface: 'stop', topicText: 'generic status', failureText: '', expectedRefs: [], kind: 'negative' },
];

describe('hook provenance golden parser', () => {
  it('strictly parses versioned cases', () => expect(parseHookProvenanceGoldenJsonl(`${cases().map(JSON.stringify).join('\n')}\n`)).toEqual(cases()));
  it.each([
    ['unknown key', (item: any) => { item.extra = true; }],
    ['duplicate case', (item: any, all: any[]) => { item.caseId = all[0].caseId; }],
    ['invalid source', (item: any) => { item.expectedRefs = [{ id: 'entry-a', source: 'bad source' }]; }],
    ['invalid id', (item: any) => { item.expectedRefs = [{ id: '../entry', source: 'own' }]; }],
    ['invalid case id', (item: any) => { item.caseId = '../case'; }],
  ])('rejects %s', (_name, mutate) => {
    const all: any[] = cases().map((item) => structuredClone(item)); mutate(all[1], all);
    expect(() => parseHookProvenanceGoldenJsonl(all.map(JSON.stringify).join('\n'))).toThrow(HookProvenanceArtifactError);
  });
  it('does not echo private text in parser errors', () => {
    const secret = 'PRIVATE-RAW-TEXT-MUST-NOT-LEAK';
    try { parseHookProvenanceGoldenJsonl(`{"caseId":"${secret}"}`); } catch (error) { expect(String(error)).not.toContain(secret); }
  });
  it('fails closed when expected refs are absent from the corpus', () => expect(() => validateHookProvenanceCases(cases(), [a])).toThrow(/does not exist/));
});

describe('hook provenance metrics', () => {
  it('reports aggregate and surface precision, recall, and negative hit rate', () => {
    const metrics = evaluateHookProvenance(cases(), [
      { caseId: 'prompt-positive', returned: [a] },
      { caseId: 'error-negative', returned: [a] },
      { caseId: 'stop-positive', returned: [] },
      { caseId: 'stop-query-only', returned: [] },
    ]);
    expect(metrics.precision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.positiveRecall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.negativeHitRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.bySurface.user_prompt.positiveRecall.value).toBe(1);
    expect(metrics.bySurface.stop.positiveRecall.value).toBe(0);
  });
});
