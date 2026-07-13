export const HOOK_PROVENANCE_SCHEMA_VERSION = 'hook-provenance-golden/v1';
export const HOOK_PROVENANCE_RUNNER_VERSION = 'hook-provenance-eval/v1';

export const HOOK_PROVENANCE_SURFACES = ['user_prompt', 'tool_error', 'stop'] as const;
export type HookProvenanceSurface = typeof HOOK_PROVENANCE_SURFACES[number];
export type HookProvenanceKind = 'positive' | 'negative';

export interface HookProvenanceRef { id: string; source: string; }
export interface HookProvenanceCase {
  schemaVersion: typeof HOOK_PROVENANCE_SCHEMA_VERSION;
  caseId: string;
  surface: HookProvenanceSurface;
  topicText: string;
  failureText: string;
  expectedRefs: HookProvenanceRef[];
  kind: HookProvenanceKind;
}
export interface HookProvenanceResult { caseId: string; returned: HookProvenanceRef[]; }
export interface HookProvenanceMetric { numerator: number; denominator: number; value: number | null; }
export interface HookProvenanceSurfaceMetrics {
  caseCount: number;
  precision: HookProvenanceMetric;
  positiveRecall: HookProvenanceMetric;
  negativeHitRate: HookProvenanceMetric;
}
export interface HookProvenanceMetrics {
  schemaVersion: typeof HOOK_PROVENANCE_SCHEMA_VERSION;
  runnerVersion: typeof HOOK_PROVENANCE_RUNNER_VERSION;
  caseCount: number;
  precision: HookProvenanceMetric;
  positiveRecall: HookProvenanceMetric;
  negativeHitRate: HookProvenanceMetric;
  bySurface: Record<HookProvenanceSurface, HookProvenanceSurfaceMetrics>;
}

export class HookProvenanceArtifactError extends Error {
  constructor(line: number | null, reason: string, count = 1) {
    super(`hook provenance artifact mismatch: ${line === null ? 'aggregate' : `line ${line}`}; count ${count}; ${reason}`);
    this.name = 'HookProvenanceArtifactError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[], line: number): void {
  const actual = Object.keys(value);
  if (actual.length !== allowed.length || actual.some((key) => !allowed.includes(key))) {
    throw new HookProvenanceArtifactError(line, 'unknown or missing keys');
  }
}
function text(value: unknown, line: number, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HookProvenanceArtifactError(line, `${field} must be a nonempty string`);
  return value;
}
function refKey(ref: HookProvenanceRef): string { return `${ref.source}\0${ref.id}`; }
function ref(value: unknown, line: number, field: string): HookProvenanceRef {
  if (!record(value)) throw new HookProvenanceArtifactError(line, `${field} must be an object`);
  keys(value, ['id', 'source'], line);
  const id = text(value.id, line, `${field}.id`);
  const source = text(value.source, line, `${field}.source`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new HookProvenanceArtifactError(line, `${field}.id is invalid`);
  if (source !== 'own' && !/^community\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source)) throw new HookProvenanceArtifactError(line, `${field}.source is invalid`);
  return { id, source };
}

export function parseHookProvenanceGoldenJsonl(textValue: string): HookProvenanceCase[] {
  const lines = textValue.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new HookProvenanceArtifactError(null, 'artifact has no cases', 0);
  const cases: HookProvenanceCase[] = [];
  const caseIds = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    if (lines[index]!.trim().length === 0) throw new HookProvenanceArtifactError(line, 'empty JSONL record');
    let value: unknown;
    try { value = JSON.parse(lines[index]!); } catch { throw new HookProvenanceArtifactError(line, 'malformed JSON'); }
    if (!record(value)) throw new HookProvenanceArtifactError(line, 'case must be an object');
    keys(value, ['schemaVersion', 'caseId', 'surface', 'topicText', 'failureText', 'expectedRefs', 'kind'], line);
    if (value.schemaVersion !== HOOK_PROVENANCE_SCHEMA_VERSION) throw new HookProvenanceArtifactError(line, 'schemaVersion is invalid');
    const caseId = text(value.caseId, line, 'caseId');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(caseId)) throw new HookProvenanceArtifactError(line, 'caseId is invalid');
    if (caseIds.has(caseId)) throw new HookProvenanceArtifactError(line, 'duplicate caseId');
    caseIds.add(caseId);
    if (typeof value.surface !== 'string' || !HOOK_PROVENANCE_SURFACES.includes(value.surface as HookProvenanceSurface)) throw new HookProvenanceArtifactError(line, 'surface is invalid');
    if (value.kind !== 'positive' && value.kind !== 'negative') throw new HookProvenanceArtifactError(line, 'kind is invalid');
    if (!Array.isArray(value.expectedRefs)) throw new HookProvenanceArtifactError(line, 'expectedRefs must be an array');
    const expectedRefs = value.expectedRefs.map((item, itemIndex) => ref(item, line, `expectedRefs[${itemIndex}]`));
    if (new Set(expectedRefs.map(refKey)).size !== expectedRefs.length) throw new HookProvenanceArtifactError(line, 'duplicate expected ref');
    if (value.kind === 'positive' && expectedRefs.length === 0) throw new HookProvenanceArtifactError(line, 'positive case must have expected refs', 0);
    if (value.kind === 'negative' && expectedRefs.length !== 0) throw new HookProvenanceArtifactError(line, 'negative case must have zero expected refs', expectedRefs.length);
    if (typeof value.topicText !== 'string' || typeof value.failureText !== 'string') {
      throw new HookProvenanceArtifactError(line, 'topicText and failureText must be strings');
    }
    if (value.topicText.trim().length === 0 && value.failureText.trim().length === 0) {
      throw new HookProvenanceArtifactError(line, 'topicText and failureText cannot both be empty');
    }
    cases.push({ schemaVersion: HOOK_PROVENANCE_SCHEMA_VERSION, caseId, surface: value.surface as HookProvenanceSurface, topicText: value.topicText, failureText: value.failureText, expectedRefs, kind: value.kind });
  }
  return cases;
}

export function validateHookProvenanceCases(cases: HookProvenanceCase[], corpusRefs: HookProvenanceRef[]): void {
  const corpus = new Set(corpusRefs.map(refKey));
  for (let index = 0; index < cases.length; index++) for (const item of cases[index]!.expectedRefs) {
    if (!corpus.has(refKey(item))) throw new HookProvenanceArtifactError(index + 1, 'expected ref does not exist in corpus');
  }
}
function ratio(numerator: number, denominator: number): HookProvenanceMetric { return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator }; }
interface Acc { cases: number; relevant: number; returned: number; positives: number; recalled: number; negatives: number; negativeHits: number; }
function acc(): Acc { return { cases: 0, relevant: 0, returned: 0, positives: 0, recalled: 0, negatives: 0, negativeHits: 0 }; }
function metrics(value: Acc): HookProvenanceSurfaceMetrics { return { caseCount: value.cases, precision: ratio(value.relevant, value.returned), positiveRecall: ratio(value.recalled, value.positives), negativeHitRate: ratio(value.negativeHits, value.negatives) }; }

export function evaluateHookProvenance(cases: HookProvenanceCase[], results: HookProvenanceResult[]): HookProvenanceMetrics {
  const resultMap = new Map(results.map((item) => [item.caseId, item.returned]));
  if (resultMap.size !== results.length || results.length !== cases.length) throw new HookProvenanceArtifactError(null, 'case result set differs from cases', results.length);
  const total = acc();
  const surfaces = Object.fromEntries(HOOK_PROVENANCE_SURFACES.map((surface) => [surface, acc()])) as Record<HookProvenanceSurface, Acc>;
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]!; const returned = resultMap.get(item.caseId);
    if (!returned) throw new HookProvenanceArtifactError(index + 1, 'case result is missing');
    const keys = returned.map(refKey);
    if (new Set(keys).size !== keys.length) throw new HookProvenanceArtifactError(index + 1, 'case result contains duplicate refs');
    for (const value of [total, surfaces[item.surface]]) {
      const expected = new Set(item.expectedRefs.map(refKey));
      const relevant = keys.filter((key) => expected.has(key)).length;
      value.cases++; value.relevant += relevant; value.returned += returned.length;
      if (item.kind === 'positive') { value.positives++; if (relevant > 0) value.recalled++; }
      else { value.negatives++; if (returned.length > 0) value.negativeHits++; }
    }
  }
  const all = metrics(total);
  return { schemaVersion: HOOK_PROVENANCE_SCHEMA_VERSION, runnerVersion: HOOK_PROVENANCE_RUNNER_VERSION, caseCount: cases.length, precision: all.precision, positiveRecall: all.positiveRecall, negativeHitRate: all.negativeHitRate, bySurface: Object.fromEntries(HOOK_PROVENANCE_SURFACES.map((surface) => [surface, metrics(surfaces[surface])])) as Record<HookProvenanceSurface, HookProvenanceSurfaceMetrics> };
}
