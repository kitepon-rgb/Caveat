import { describe, expect, it } from 'vitest';
import {
  assertStableHookSearchResults,
  evaluateHookSearch,
  HookSearchArtifactError,
  parseHookSearchGoldenJsonl,
  validateHookSearchCases,
  type HookSearchCase,
  type HookSearchCaseResult,
  type HookSearchRef,
} from '../src/hookSearchEval.js';

const a = { id: 'entry-a', source: 'own' };
const b = { id: 'entry-b', source: 'own' };
const c = { id: 'entry-c', source: 'own' };
const corpus = [a, b, c];

function cases(): HookSearchCase[] {
  return [
    { caseId: 'c1', subject: a, kind: 'error', query: 'alpha failure', expected: [a], irrelevant: [c] },
    { caseId: 'c2', subject: a, kind: 'paraphrase', query: 'alpha broke', expected: [a, b], irrelevant: [] },
    { caseId: 'c3', subject: b, kind: 'cross-language', query: 'beta failed', expected: [b], irrelevant: [] },
    { caseId: 'c4', subject: b, kind: 'negative', query: 'healthy beta', expected: [], irrelevant: [c] },
  ];
}

function results(): HookSearchCaseResult[] {
  return [
    { caseId: 'c1', returned: [a, c] },
    { caseId: 'c2', returned: [b] },
    { caseId: 'c3', returned: [] },
    { caseId: 'c4', returned: [c] },
  ];
}

describe('hook search golden parser and validator', () => {
  it('parses one case per JSONL line', () => {
    const text = `${cases().map((item) => JSON.stringify(item)).join('\n')}\n`;
    expect(parseHookSearchGoldenJsonl(text)).toEqual(cases());
  });

  it('reports only line/count/reason for malformed private artifact data', () => {
    const secret = 'RAW-PRIVATE-QUERY-DO-NOT-LEAK';
    expect(() => parseHookSearchGoldenJsonl(`{"query":"${secret}"\n`)).toThrowError(
      /line 1; count 1; malformed JSON/,
    );
    try {
      parseHookSearchGoldenJsonl(`{"query":"${secret}"\n`);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects invalid schema without echoing raw identifiers or queries', () => {
    const raw = 'PRIVATE-RAW-VALUE';
    const invalid = JSON.stringify({
      caseId: raw,
      subject: a,
      kind: 'error',
      query: '   ',
      expected: [a],
      irrelevant: [],
    });
    expect(() => parseHookSearchGoldenJsonl(invalid)).toThrow(HookSearchArtifactError);
    try {
      parseHookSearchGoldenJsonl(invalid);
    } catch (error) {
      expect(String(error)).not.toContain(raw);
      expect(String(error)).toContain('line 1');
    }
  });

  it.each([
    ['duplicate caseId', (items: HookSearchCase[]) => { items[1]!.caseId = items[0]!.caseId; }],
    ['subject does not exist', (items: HookSearchCase[]) => { items[0]!.subject = { id: 'missing', source: 'own' }; }],
    ['positive expected empty', (items: HookSearchCase[]) => { items[0]!.expected = []; }],
    ['negative expected nonempty', (items: HookSearchCase[]) => { items[3]!.expected = [a]; }],
    ['duplicate expected ref', (items: HookSearchCase[]) => { items[0]!.expected = [a, a]; }],
    ['duplicate irrelevant ref', (items: HookSearchCase[]) => { items[0]!.irrelevant = [c, c]; }],
    ['expected irrelevant intersection', (items: HookSearchCase[]) => { items[0]!.irrelevant = [a]; }],
    ['expected ref missing', (items: HookSearchCase[]) => { items[0]!.expected = [{ id: 'missing', source: 'own' }]; }],
    ['irrelevant ref missing', (items: HookSearchCase[]) => { items[0]!.irrelevant = [{ id: 'missing', source: 'own' }]; }],
    ['positive subject not expected', (items: HookSearchCase[]) => { items[0]!.expected = [b]; }],
  ])('rejects %s', (_name, mutate) => {
    const items = cases();
    mutate(items);
    expect(() => validateHookSearchCases(items, corpus)).toThrow(HookSearchArtifactError);
  });

  it('requires 2-4 cases for every subject', () => {
    expect(() => validateHookSearchCases(cases().slice(0, 3), corpus)).toThrow(/subject case count/);
    const tooMany = [...cases(), ...Array.from({ length: 3 }, (_, index) => ({ ...cases()[0]!, caseId: `extra-${index}` }))];
    expect(() => validateHookSearchCases(tooMany, corpus)).toThrow(/subject case count/);
  });

  it('rejects a subject represented only by negative cases', () => {
    const negativeOnly: HookSearchCase[] = [
      { caseId: 'n1', subject: a, kind: 'negative', query: 'healthy alpha', expected: [], irrelevant: [c] },
      { caseId: 'n2', subject: a, kind: 'negative', query: 'working alpha', expected: [], irrelevant: [c] },
    ];
    expect(() => validateHookSearchCases(negativeOnly, corpus))
      .toThrow(/every subject must have at least one positive case/);
  });
});

describe('hook search metrics', () => {
  it('returns explicit numerators and denominators for aggregate and kind metrics', () => {
    const metrics = evaluateHookSearch(cases(), results(), corpus);
    expect(metrics).toMatchObject({
      schemaVersion: 'hook-search-golden/v1',
      runnerVersion: 'hook-search-eval/v2',
      caseCount: 4,
      subjectCount: 2,
      positiveHitAt5: { numerator: 2, denominator: 3, value: 2 / 3 },
      caseMacroRecallAt5: { numerator: 1.5, denominator: 3, value: 0.5 },
      expectedRefMicroRecallAt5: { numerator: 2, denominator: 4, value: 0.5 },
      microPrecisionAt5: { numerator: 2, denominator: 4, value: 0.5 },
      subjectMacroPositiveRecallAt5: { numerator: 2 / 3, denominator: 2, value: 1 / 3 },
      subjectMacroPrecisionAmongReturnedAt5: {
        numerator: 2 / 3,
        denominator: 2,
        totalSubjectCount: 2,
        value: 1 / 3,
      },
      negativeAnyHitRate: { numerator: 1, denominator: 1, value: 1 },
      entryCoverage: { numerator: 2, denominator: 3, value: 2 / 3 },
    });
    expect(metrics.byKind.error.hitAt5).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(metrics.byKind.negative.negativeAnyHitRate).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(metrics.byKind.negative.hitAt5).toEqual({ numerator: 0, denominator: 0, value: null });
  });

  it('returns null precision when every case returns zero refs', () => {
    const empty = cases().map(({ caseId }) => ({ caseId, returned: [] }));
    const metrics = evaluateHookSearch(cases(), empty, corpus);
    expect(metrics.microPrecisionAt5)
      .toEqual({ numerator: 0, denominator: 0, value: null });
    expect(metrics.subjectMacroPrecisionAmongReturnedAt5)
      .toEqual({ numerator: 0, denominator: 0, totalSubjectCount: 2, value: null });
  });

  it('fails when any returned top-five ref is unjudged', () => {
    const unjudged: HookSearchRef = { id: 'unjudged', source: 'own' };
    const actual = results();
    actual[0] = { caseId: 'c1', returned: [unjudged] };
    expect(() => evaluateHookSearch(cases(), actual, corpus)).toThrow(/returned refs are not fully judged/);
  });

  it('checks ordered top-five stability across two runs', () => {
    expect(() => assertStableHookSearchResults(results(), results())).not.toThrow();
    const changed = results();
    changed[0] = { caseId: 'c1', returned: [c, a] };
    expect(() => assertStableHookSearchResults(results(), changed)).toThrow(/repeat top 5 refs differ/);
  });
});
