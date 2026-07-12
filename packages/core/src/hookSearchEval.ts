export const HOOK_SEARCH_SCHEMA_VERSION = 'hook-search-golden/v1';
export const HOOK_SEARCH_RUNNER_VERSION = 'hook-search-eval/v2';

export const HOOK_SEARCH_KINDS = [
  'error',
  'paraphrase',
  'cross-language',
  'negative',
] as const;

export type HookSearchCaseKind = typeof HOOK_SEARCH_KINDS[number];

export interface HookSearchRef {
  id: string;
  source: string;
}

export interface HookSearchCase {
  caseId: string;
  subject: HookSearchRef;
  kind: HookSearchCaseKind;
  query: string;
  expected: HookSearchRef[];
  irrelevant: HookSearchRef[];
}

export interface HookSearchCaseResult {
  caseId: string;
  returned: HookSearchRef[];
}

export interface HookSearchMetric {
  numerator: number;
  denominator: number;
  value: number | null;
}

/**
 * A subject-macro precision. `denominator` counts only subjects with at least
 * one returned ref; `totalSubjectCount` keeps that exclusion visible.
 */
export interface HookSearchSubjectPrecisionMetric extends HookSearchMetric {
  totalSubjectCount: number;
}

export interface HookSearchKindMetrics {
  caseCount: number;
  hitAt5: HookSearchMetric;
  caseMacroRecallAt5: HookSearchMetric;
  expectedRefMicroRecallAt5: HookSearchMetric;
  microPrecisionAt5: HookSearchMetric;
  negativeAnyHitRate: HookSearchMetric;
}

export interface HookSearchMetrics {
  schemaVersion: typeof HOOK_SEARCH_SCHEMA_VERSION;
  runnerVersion: typeof HOOK_SEARCH_RUNNER_VERSION;
  caseCount: number;
  subjectCount: number;
  positiveHitAt5: HookSearchMetric;
  caseMacroRecallAt5: HookSearchMetric;
  expectedRefMicroRecallAt5: HookSearchMetric;
  microPrecisionAt5: HookSearchMetric;
  subjectMacroPositiveRecallAt5: HookSearchMetric;
  subjectMacroPrecisionAmongReturnedAt5: HookSearchSubjectPrecisionMetric;
  negativeAnyHitRate: HookSearchMetric;
  entryCoverage: HookSearchMetric;
  byKind: Record<HookSearchCaseKind, HookSearchKindMetrics>;
}

interface LocatedCase {
  line: number;
  value: HookSearchCase;
}

export class HookSearchArtifactError extends Error {
  constructor(line: number | null, reason: string, count = 1) {
    super(`hook search artifact mismatch: ${line === null ? 'aggregate' : `line ${line}`}; count ${count}; ${reason}`);
    this.name = 'HookSearchArtifactError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRef(value: unknown, line: number, field: string): HookSearchRef {
  if (!isRecord(value)) throw new HookSearchArtifactError(line, `${field} must be an object`);
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new HookSearchArtifactError(line, `${field}.id must be a nonempty string`);
  }
  if (typeof value.source !== 'string' || value.source.trim().length === 0) {
    throw new HookSearchArtifactError(line, `${field}.source must be a nonempty string`);
  }
  return { id: value.id, source: value.source };
}

function parseRefArray(value: unknown, line: number, field: string): HookSearchRef[] {
  if (!Array.isArray(value)) throw new HookSearchArtifactError(line, `${field} must be an array`);
  return value.map((ref, index) => parseRef(ref, line, `${field}[${index}]`));
}

function parseCase(value: unknown, line: number): HookSearchCase {
  if (!isRecord(value)) throw new HookSearchArtifactError(line, 'case must be an object');
  if (typeof value.caseId !== 'string' || value.caseId.trim().length === 0) {
    throw new HookSearchArtifactError(line, 'caseId must be a nonempty string');
  }
  if (typeof value.query !== 'string' || value.query.trim().length === 0) {
    throw new HookSearchArtifactError(line, 'query must be a nonempty string');
  }
  if (typeof value.kind !== 'string' || !HOOK_SEARCH_KINDS.includes(value.kind as HookSearchCaseKind)) {
    throw new HookSearchArtifactError(line, 'kind is invalid');
  }
  return {
    caseId: value.caseId,
    subject: parseRef(value.subject, line, 'subject'),
    kind: value.kind as HookSearchCaseKind,
    query: value.query,
    expected: parseRefArray(value.expected, line, 'expected'),
    irrelevant: parseRefArray(value.irrelevant, line, 'irrelevant'),
  };
}

function refKey(ref: HookSearchRef): string {
  return `${ref.source}\0${ref.id}`;
}

export function parseHookSearchGoldenJsonl(text: string): HookSearchCase[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new HookSearchArtifactError(null, 'artifact has no cases', 0);
  const located: LocatedCase[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    if (lines[index]!.trim().length === 0) throw new HookSearchArtifactError(line, 'empty JSONL record');
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]!);
    } catch {
      throw new HookSearchArtifactError(line, 'malformed JSON');
    }
    located.push({ line, value: parseCase(parsed, line) });
  }
  return located.map(({ value }) => value);
}

export function validateHookSearchCases(
  cases: HookSearchCase[],
  corpusRefs: HookSearchRef[],
): void {
  if (cases.length === 0) throw new HookSearchArtifactError(null, 'artifact has no cases', 0);
  const corpus = new Set(corpusRefs.map(refKey));
  const caseIds = new Set<string>();
  const subjectCounts = new Map<string, number>();
  const subjectsWithPositiveCases = new Set<string>();

  for (let index = 0; index < cases.length; index++) {
    const line = index + 1;
    const item = cases[index]!;
    if (typeof item.caseId !== 'string' || item.caseId.trim().length === 0) {
      throw new HookSearchArtifactError(line, 'caseId must be a nonempty string');
    }
    if (typeof item.query !== 'string' || item.query.trim().length === 0) {
      throw new HookSearchArtifactError(line, 'query must be a nonempty string');
    }
    if (!HOOK_SEARCH_KINDS.includes(item.kind)) throw new HookSearchArtifactError(line, 'kind is invalid');
    if (!Array.isArray(item.expected) || !Array.isArray(item.irrelevant)) {
      throw new HookSearchArtifactError(line, 'expected and irrelevant must be arrays');
    }
    if (caseIds.has(item.caseId)) throw new HookSearchArtifactError(line, 'duplicate caseId');
    caseIds.add(item.caseId);
    const subjectKey = refKey(item.subject);
    if (!corpus.has(subjectKey)) throw new HookSearchArtifactError(line, 'subject does not exist in corpus');
    subjectCounts.set(subjectKey, (subjectCounts.get(subjectKey) ?? 0) + 1);

    if (item.kind === 'negative' && item.expected.length !== 0) {
      throw new HookSearchArtifactError(line, 'negative case must have zero expected refs', item.expected.length);
    }
    if (item.kind !== 'negative' && item.expected.length === 0) {
      throw new HookSearchArtifactError(line, 'positive case must have at least one expected ref', 0);
    }

    const expected = new Set<string>();
    for (const ref of item.expected) {
      const key = refKey(ref);
      if (expected.has(key)) throw new HookSearchArtifactError(line, 'duplicate expected ref');
      expected.add(key);
      if (!corpus.has(key)) throw new HookSearchArtifactError(line, 'expected ref does not exist in corpus');
    }
    if (item.kind !== 'negative') {
      if (!expected.has(subjectKey)) {
        throw new HookSearchArtifactError(line, 'positive case expected refs must include its subject');
      }
      subjectsWithPositiveCases.add(subjectKey);
    }
    const irrelevant = new Set<string>();
    for (const ref of item.irrelevant) {
      const key = refKey(ref);
      if (irrelevant.has(key)) throw new HookSearchArtifactError(line, 'duplicate irrelevant ref');
      irrelevant.add(key);
      if (expected.has(key)) throw new HookSearchArtifactError(line, 'expected and irrelevant refs intersect');
      if (!corpus.has(key)) throw new HookSearchArtifactError(line, 'irrelevant ref does not exist in corpus');
    }
  }

  for (const count of subjectCounts.values()) {
    if (count < 2 || count > 4) {
      throw new HookSearchArtifactError(null, 'subject case count must be between 2 and 4', count);
    }
  }
  const subjectsWithoutPositiveCases = [...subjectCounts.keys()]
    .filter((subjectKey) => !subjectsWithPositiveCases.has(subjectKey));
  if (subjectsWithoutPositiveCases.length > 0) {
    throw new HookSearchArtifactError(
      null,
      'every subject must have at least one positive case',
      subjectsWithoutPositiveCases.length,
    );
  }
}

function ratio(numerator: number, denominator: number): HookSearchMetric {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

interface MetricAccumulator {
  caseCount: number;
  positiveCases: number;
  positiveHits: number;
  caseRecallSum: number;
  expectedFound: number;
  expectedTotal: number;
  relevantReturned: number;
  returnedTotal: number;
  negativeCases: number;
  negativeAnyHits: number;
}

interface SubjectMetricAccumulator {
  positiveExpectedFound: number;
  positiveExpectedTotal: number;
  relevantReturned: number;
  returnedTotal: number;
}

function accumulator(): MetricAccumulator {
  return {
    caseCount: 0,
    positiveCases: 0,
    positiveHits: 0,
    caseRecallSum: 0,
    expectedFound: 0,
    expectedTotal: 0,
    relevantReturned: 0,
    returnedTotal: 0,
    negativeCases: 0,
    negativeAnyHits: 0,
  };
}

function subjectAccumulator(): SubjectMetricAccumulator {
  return {
    positiveExpectedFound: 0,
    positiveExpectedTotal: 0,
    relevantReturned: 0,
    returnedTotal: 0,
  };
}

function finalize(acc: MetricAccumulator): HookSearchKindMetrics {
  return {
    caseCount: acc.caseCount,
    hitAt5: ratio(acc.positiveHits, acc.positiveCases),
    caseMacroRecallAt5: ratio(acc.caseRecallSum, acc.positiveCases),
    expectedRefMicroRecallAt5: ratio(acc.expectedFound, acc.expectedTotal),
    microPrecisionAt5: ratio(acc.relevantReturned, acc.returnedTotal),
    negativeAnyHitRate: ratio(acc.negativeAnyHits, acc.negativeCases),
  };
}

function addCase(acc: MetricAccumulator, item: HookSearchCase, returned: HookSearchRef[]): void {
  const expected = new Set(item.expected.map(refKey));
  const returnedKeys = returned.map(refKey);
  const expectedFound = new Set(returnedKeys.filter((key) => expected.has(key))).size;
  acc.caseCount++;
  acc.expectedFound += expectedFound;
  acc.expectedTotal += expected.size;
  acc.relevantReturned += expectedFound;
  acc.returnedTotal += returned.length;
  if (item.kind === 'negative') {
    acc.negativeCases++;
    if (returned.length > 0) acc.negativeAnyHits++;
  } else {
    acc.positiveCases++;
    if (expectedFound > 0) acc.positiveHits++;
    acc.caseRecallSum += expectedFound / expected.size;
  }
}

function addSubjectCase(
  acc: SubjectMetricAccumulator,
  item: HookSearchCase,
  returned: HookSearchRef[],
): void {
  const expected = new Set(item.expected.map(refKey));
  const expectedFound = new Set(returned.map(refKey).filter((key) => expected.has(key))).size;
  if (item.kind !== 'negative') {
    acc.positiveExpectedFound += expectedFound;
    acc.positiveExpectedTotal += expected.size;
  }
  acc.relevantReturned += expectedFound;
  acc.returnedTotal += returned.length;
}

function subjectMacroMetrics(
  subjects: Map<string, SubjectMetricAccumulator>,
): Pick<HookSearchMetrics, 'subjectMacroPositiveRecallAt5' | 'subjectMacroPrecisionAmongReturnedAt5'> {
  const values = [...subjects.values()];
  const positiveRecallSum = values.reduce(
    (sum, subject) => sum + subject.positiveExpectedFound / subject.positiveExpectedTotal,
    0,
  );
  const returnedSubjects = values.filter((subject) => subject.returnedTotal > 0);
  const precisionSum = returnedSubjects.reduce(
    (sum, subject) => sum + subject.relevantReturned / subject.returnedTotal,
    0,
  );
  return {
    subjectMacroPositiveRecallAt5: ratio(positiveRecallSum, values.length),
    subjectMacroPrecisionAmongReturnedAt5: {
      ...ratio(precisionSum, returnedSubjects.length),
      totalSubjectCount: values.length,
    },
  };
}

export function evaluateHookSearch(
  cases: HookSearchCase[],
  results: HookSearchCaseResult[],
  corpusRefs: HookSearchRef[],
): HookSearchMetrics {
  validateHookSearchCases(cases, corpusRefs);
  const resultMap = new Map(results.map((result) => [result.caseId, result.returned]));
  if (resultMap.size !== results.length) throw new HookSearchArtifactError(null, 'duplicate case result');
  if (results.length !== cases.length) {
    throw new HookSearchArtifactError(null, 'case result count differs from case count', results.length);
  }

  const total = accumulator();
  const kinds = Object.fromEntries(HOOK_SEARCH_KINDS.map((kind) => [kind, accumulator()])) as Record<HookSearchCaseKind, MetricAccumulator>;
  const subjects = new Map<string, SubjectMetricAccumulator>();
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]!;
    const returned = resultMap.get(item.caseId);
    if (!returned) throw new HookSearchArtifactError(index + 1, 'case result is missing');
    if (returned.length > 5) throw new HookSearchArtifactError(index + 1, 'case result exceeds top 5', returned.length);
    const judged = new Set([...item.expected, ...item.irrelevant].map(refKey));
    const returnedKeys = returned.map(refKey);
    if (new Set(returnedKeys).size !== returnedKeys.length) {
      throw new HookSearchArtifactError(index + 1, 'case result contains duplicate refs');
    }
    const unjudgedCount = returnedKeys.filter((key) => !judged.has(key)).length;
    if (unjudgedCount > 0) {
      throw new HookSearchArtifactError(index + 1, 'returned refs are not fully judged', unjudgedCount);
    }
    addCase(total, item, returned);
    addCase(kinds[item.kind], item, returned);
    const subjectKey = refKey(item.subject);
    const subject = subjects.get(subjectKey) ?? subjectAccumulator();
    addSubjectCase(subject, item, returned);
    subjects.set(subjectKey, subject);
  }

  const finalized = finalize(total);
  const subjectMacro = subjectMacroMetrics(subjects);
  return {
    schemaVersion: HOOK_SEARCH_SCHEMA_VERSION,
    runnerVersion: HOOK_SEARCH_RUNNER_VERSION,
    caseCount: cases.length,
    subjectCount: subjects.size,
    positiveHitAt5: finalized.hitAt5,
    caseMacroRecallAt5: finalized.caseMacroRecallAt5,
    expectedRefMicroRecallAt5: finalized.expectedRefMicroRecallAt5,
    microPrecisionAt5: finalized.microPrecisionAt5,
    ...subjectMacro,
    negativeAnyHitRate: finalized.negativeAnyHitRate,
    entryCoverage: ratio(subjects.size, new Set(corpusRefs.map(refKey)).size),
    byKind: Object.fromEntries(HOOK_SEARCH_KINDS.map((kind) => [kind, finalize(kinds[kind])])) as Record<HookSearchCaseKind, HookSearchKindMetrics>,
  };
}

export function assertStableHookSearchResults(
  first: HookSearchCaseResult[],
  second: HookSearchCaseResult[],
): void {
  if (first.length !== second.length) {
    throw new HookSearchArtifactError(null, 'repeat result count differs', second.length);
  }
  const secondMap = new Map(second.map((result) => [result.caseId, result.returned.map(refKey)]));
  if (secondMap.size !== second.length) throw new HookSearchArtifactError(null, 'repeat contains duplicate case results');
  for (let index = 0; index < first.length; index++) {
    const a = first[index]!;
    const b = secondMap.get(a.caseId);
    if (!b) throw new HookSearchArtifactError(index + 1, 'repeat case result is missing');
    const aKeys = a.returned.map(refKey);
    if (aKeys.length !== b.length || aKeys.some((key, position) => key !== b[position])) {
      throw new HookSearchArtifactError(index + 1, 'repeat top 5 refs differ');
    }
  }
}
