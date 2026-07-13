import { createHash } from 'node:crypto';
import { assignedConditions, parseProposalJudgmentsJsonl, parseProposalReviewPacketsJsonl, type ProposalAssignment, type ProposalCondition, type ProposalJudgment, type ProposalPolicy, type ProposalReviewPacket, type ProposalScenario } from './proposalEval.js';
import { canonicalProposalExecutionJson, parseClaudeProposalExecutionJsonl, parseCodexProposalExecutionJsonl, proposalExecutionRuntimeDigest, validateProposalExecutionProvenance, type ProposalExecutionPlan, type ProposalExecutionReceipt, type ProposalExecutionStatus } from './proposalExecution.js';

export const PROPOSAL_EXECUTION_SUITE_SCHEMA_VERSION = 'proposal-execution-suite/v1';
export const PROPOSAL_EXECUTION_OUTCOME_SCHEMA_VERSION = 'proposal-execution-outcome/v1';
export const PROPOSAL_EXECUTION_EVAL_SCHEMA_VERSION = 'proposal-execution-eval/v1';
type Host = 'claude' | 'codex';
type Provenance = 'requested_only' | 'provider_reported';
type StratumProvenance = Provenance | 'completed_provider_reported';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const DIGEST = /^[0-9a-f]{64}$/;
const JUDGMENT_ID = /^[0-9a-f]{32}$/;
const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const fail = (why: string): never => { throw new ProposalExecutionCompilerError(why); };
const exact = (v: Record<string, unknown>, ks: string[], label: string) => { const a = Object.keys(v); if (a.length !== ks.length || a.some(k => !ks.includes(k))) fail(`${label} has unknown or missing keys`); };
const str = (v: unknown, label: string) => typeof v === 'string' && v.length > 0 && !v.includes('\0') ? v : fail(`${label} must be a nonempty NUL-free string`);
const digest = (v: unknown, label: string) => { const x = str(v, label); return DIGEST.test(x) ? x : fail(`${label} must be a lowercase SHA-256 digest`); };
const same = (a: unknown, b: unknown, why: string) => { if (canonicalProposalExecutionJson(a) !== canonicalProposalExecutionJson(b)) fail(why); };
export class ProposalExecutionCompilerError extends Error { constructor(reason: string) { super(`proposal execution compiler mismatch: ${reason}`); this.name = 'ProposalExecutionCompilerError'; } }

export interface ProposalExecutionSuiteBlock { scenarioId: string; host: Host; requestedModel: string; policyId: string; policyDigest: string; assignmentDigest: string; planDigests: string[]; }
export interface ProposalExecutionSuite { schemaVersion: typeof PROPOSAL_EXECUTION_SUITE_SCHEMA_VERSION; suiteId: string; blocks: ProposalExecutionSuiteBlock[]; planCount: number; manifestDigest: string; }
export interface ProposalExecutionOutcome { schemaVersion: typeof PROPOSAL_EXECUTION_OUTCOME_SCHEMA_VERSION; trialId: string; judgmentId: string; runId: string; scenarioId: string; host: Host; requestedModel: string; reportedModel: string | null; modelProvenance: Provenance; policyId: string; policyDigest: string; condition: ProposalCondition; status: ProposalExecutionStatus; planDigest: string; receiptDigest: string; runtimeDigest: string; output: string | null; outputDigest: string | null; outcomeDigest: string; }
export interface ProposalExecutionRaw { rawStdout: Buffer; rawStderr: Buffer; output: Buffer | null; }
export interface ProposalExecutionCompileInput { scenarios: ProposalScenario[]; policies: ProposalPolicy[]; assignments: ProposalAssignment[]; plans: ProposalExecutionPlan[]; receipts: ProposalExecutionReceipt[]; suite: ProposalExecutionSuite; raw: Map<string, ProposalExecutionRaw> | Record<string, ProposalExecutionRaw>; }
export interface ProposalExecutionRate { lower: { numerator: number; denominator: number; value: number }; upper: { numerator: number; denominator: number; value: number }; unclearCount: number; }
export interface ProposalExecutionConditionMetrics { trialCount: number; knownBadClaimRate: ProposalExecutionRate; validSolutionRate: ProposalExecutionRate; safeAndUsefulRate: ProposalExecutionRate; statusCounts: Record<ProposalExecutionStatus, number>; }
export interface ProposalExecutionEval { schemaVersion: typeof PROPOSAL_EXECUTION_EVAL_SCHEMA_VERSION; manifestDigest: string; strata: Array<{ host: Host; requestedModel: string; modelProvenance: StratumProvenance; runtimeDigest: string; policyDigest: string; scenarios: Array<{ scenarioId: string; conditions: Record<ProposalCondition, ProposalExecutionConditionMetrics>; rateDifference: Record<string, { lower: number; upper: number }> }>; macroRateDifference: Record<string, { lower: number; upper: number }> }>; }

function assignmentDigest(a: ProposalAssignment) { return sha(canonicalProposalExecutionJson(a)); }
function blockKey(v: { scenarioId: string; host: Host; requestedModel: string; policyId: string; policyDigest: string }) { return [v.scenarioId, v.host, v.requestedModel, v.policyId, v.policyDigest].join('\0'); }
export function prepareProposalExecutionSuite(assignments: ProposalAssignment[], plans: ProposalExecutionPlan[], suiteId: string): ProposalExecutionSuite {
  if (!/^[0-9a-f]{32}$/.test(suiteId)) fail('suiteId must be lowercase 32hex');
  const by = new Map<string, ProposalExecutionPlan[]>();
  for (const p of plans) { const k = blockKey({ scenarioId: p.scenarioId, host: p.host, requestedModel: p.requestedModel, policyId: p.policyId, policyDigest: p.policyDigest }); const x = by.get(k) ?? []; x.push(p); by.set(k, x); }
  const blocks = assignments.map(a => { const key = blockKey({ scenarioId: a.scenarioId, host: a.host, requestedModel: a.model, policyId: a.policyId, policyDigest: a.policyDigest }); const ps = by.get(key) ?? []; return { scenarioId: a.scenarioId, host: a.host, requestedModel: a.model, policyId: a.policyId, policyDigest: a.policyDigest, assignmentDigest: assignmentDigest(a), planDigests: ps.map(p => p.planDigest).sort() }; }).sort((a,b) => canonicalProposalExecutionJson(a).localeCompare(canonicalProposalExecutionJson(b)));
  const data: Omit<ProposalExecutionSuite, 'manifestDigest'> = { schemaVersion: PROPOSAL_EXECUTION_SUITE_SCHEMA_VERSION, suiteId, blocks, planCount: plans.length };
  return { ...data, manifestDigest: sha(canonicalProposalExecutionJson(data)) };
}
export function parseProposalExecutionSuiteJson(source: string): ProposalExecutionSuite { let x: unknown; try { x = JSON.parse(source); } catch { return fail('suite is malformed JSON'); } return parseSuite(x); }
function parseSuite(value: unknown): ProposalExecutionSuite { const x = value as any; if (!rec(x)) fail('suite must be an object'); exact(x, ['schemaVersion','suiteId','blocks','planCount','manifestDigest'], 'suite'); if (x.schemaVersion !== PROPOSAL_EXECUTION_SUITE_SCHEMA_VERSION || !/^[0-9a-f]{32}$/.test(str(x.suiteId, 'suiteId')) || !Array.isArray(x.blocks) || !Number.isInteger(x.planCount) || x.planCount < 1) fail('suite fields are invalid'); const blocks: ProposalExecutionSuiteBlock[] = x.blocks.map((raw: any, i: number) => { if (!rec(raw)) fail(`suite block ${i} is invalid`); exact(raw, ['scenarioId','host','requestedModel','policyId','policyDigest','assignmentDigest','planDigests'], 'suite block'); if ((raw.host !== 'claude' && raw.host !== 'codex') || !Array.isArray(raw.planDigests) || raw.planDigests.length === 0) fail('suite block fields are invalid'); const b: ProposalExecutionSuiteBlock = { scenarioId: str(raw.scenarioId,'scenarioId'), host: raw.host, requestedModel: str(raw.requestedModel,'requestedModel'), policyId: str(raw.policyId,'policyId'), policyDigest: digest(raw.policyDigest,'policyDigest'), assignmentDigest: digest(raw.assignmentDigest,'assignmentDigest'), planDigests: raw.planDigests.map((v: unknown) => digest(v,'planDigest')).sort() }; if (new Set(b.planDigests).size !== b.planDigests.length) fail('suite block planDigests are duplicated'); return b; }); const sorted = [...blocks].sort((a,b) => canonicalProposalExecutionJson(a).localeCompare(canonicalProposalExecutionJson(b))); same(blocks, sorted, 'suite blocks are not sorted'); if (new Set(blocks.map(b => blockKey(b))).size !== blocks.length || blocks.reduce((n,b) => n+b.planDigests.length,0) !== x.planCount) fail('suite blocks are not exact'); const data: Omit<ProposalExecutionSuite,'manifestDigest'> = { schemaVersion: PROPOSAL_EXECUTION_SUITE_SCHEMA_VERSION, suiteId: x.suiteId, blocks, planCount: x.planCount }; if (sha(canonicalProposalExecutionJson(data)) !== digest(x.manifestDigest,'manifestDigest')) fail('manifestDigest mismatch'); return { ...data, manifestDigest: x.manifestDigest }; }
export function validateProposalExecutionSuite(suite: ProposalExecutionSuite, scenarios: ProposalScenario[], policies: ProposalPolicy[], assignments: ProposalAssignment[], plans: ProposalExecutionPlan[]): void { const parsed = parseSuite(suite); const expected = prepareProposalExecutionSuite(assignments, plans, parsed.suiteId); same(parsed, expected, 'suite does not exactly match assignments and plans'); const scenarioIds = new Set(scenarios.map(s => s.scenarioId)); const policiesById = new Map(policies.map(p => [p.policyId,p])); for (const b of parsed.blocks) { const p = policiesById.get(b.policyId); if (!scenarioIds.has(b.scenarioId) || !p || p.host !== b.host || p.model !== b.requestedModel || p.policyDigest !== b.policyDigest) fail('suite block has no scenario or policy'); } }

function rawEntries(raw: ProposalExecutionCompileInput['raw']): Array<[string, ProposalExecutionRaw]> {
  const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw);
  for (const [trialId, item] of entries) {
    str(trialId, 'raw trialId');
    if (!item || !Buffer.isBuffer(item.rawStdout) || !Buffer.isBuffer(item.rawStderr) || (item.output !== null && !Buffer.isBuffer(item.output))) fail(`raw data is invalid for ${trialId}`);
  }
  return entries;
}
function rawAt(raw: Map<string, ProposalExecutionRaw>, trialId: string): ProposalExecutionRaw {
  return raw.get(trialId) ?? fail(`raw data missing for ${trialId}`);
}
export function compileProposalExecutionOutcomes(input: ProposalExecutionCompileInput): ProposalExecutionOutcome[] {
  validateProposalExecutionProvenance(input.scenarios,input.policies,input.assignments,input.plans,input.receipts);
  validateProposalExecutionSuite(input.suite,input.scenarios,input.policies,input.assignments,input.plans);
  const raw = new Map(rawEntries(input.raw));
  const planIds = new Set(input.plans.map((plan) => plan.trialId));
  if (raw.size !== planIds.size || [...raw.keys()].some((trialId) => !planIds.has(trialId))) fail('raw map is not the exact plan set');
  const receipt = new Map(input.receipts.map(r => [r.trialId,r])); const outcomes: ProposalExecutionOutcome[] = [];
  for (const plan of input.plans) { if (!receipt.has(plan.trialId)) fail('receipt is missing'); const r = receipt.get(plan.trialId)!; const bytes = rawAt(raw, plan.trialId); if (sha(bytes.rawStdout) !== r.rawStdoutDigest || sha(bytes.rawStderr) !== r.rawStderrDigest) fail('raw digest mismatch'); const parsed = r.exitCode === 0 && (r.status === 'completed' || r.status === 'protocol_error' || r.status === 'tool_attempted') ? (plan.host === 'claude' ? parseClaudeProposalExecutionJsonl(bytes.rawStdout.toString('utf8'), plan.requestedModel) : parseCodexProposalExecutionJsonl(bytes.rawStdout.toString('utf8'))) : null;
    if (parsed && (parsed.status !== r.status || parsed.providerRunId !== r.providerRunId || parsed.reportedModel !== r.reportedModel || parsed.modelProvenance !== r.modelProvenance)) fail('receipt does not match reparsed protocol');
    const output = r.status === 'completed' ? (parsed?.output ?? fail('completed output cannot be reparsed')) : null;
    if (r.status === 'completed') { if (!bytes.output || !Buffer.from(output!, 'utf8').equals(bytes.output) || sha(bytes.output) !== r.outputDigest) fail('completed output does not match receipt or output bytes'); } else if (bytes.output !== null || r.outputDigest !== null) fail('noncompleted output must be absent');
    const data: Omit<ProposalExecutionOutcome, 'outcomeDigest'> = { schemaVersion: PROPOSAL_EXECUTION_OUTCOME_SCHEMA_VERSION, trialId: plan.trialId, judgmentId: plan.judgmentId, runId: plan.runId, scenarioId: plan.scenarioId, host: plan.host, requestedModel: plan.requestedModel, reportedModel: r.reportedModel, modelProvenance: r.modelProvenance, policyId: plan.policyId, policyDigest: plan.policyDigest, condition: plan.condition, status: r.status, planDigest: plan.planDigest, receiptDigest: r.receiptDigest, runtimeDigest: proposalExecutionRuntimeDigest(plan), output, outputDigest: r.outputDigest };
    outcomes.push({ ...data, outcomeDigest: sha(canonicalProposalExecutionJson(data)) });
  } return outcomes;
}
export function parseProposalExecutionOutcomesJsonl(source: string): ProposalExecutionOutcome[] {
  const lines = source.split(/\r?\n/); if (lines.at(-1) === '') lines.pop(); if (!lines.length) fail('outcomes artifact has no records');
  return lines.map((line) => {
    if (!line.trim()) fail('empty outcome record'); let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return fail('outcome is malformed JSON'); }
    if (!rec(parsed)) fail('outcome must be an object'); const x = parsed as Record<string, unknown>;
    exact(x,['schemaVersion','trialId','judgmentId','runId','scenarioId','host','requestedModel','reportedModel','modelProvenance','policyId','policyDigest','condition','status','planDigest','receiptDigest','runtimeDigest','output','outputDigest','outcomeDigest'],'outcome');
    if (x.schemaVersion!==PROPOSAL_EXECUTION_OUTCOME_SCHEMA_VERSION || (x.host!=='claude'&&x.host!=='codex') || (x.condition!=='control'&&x.condition!=='caveat') || !['completed','unavailable','protocol_error','tool_attempted','nonzero_exit'].includes(x.status as string) || (x.modelProvenance!=='requested_only'&&x.modelProvenance!=='provider_reported')) fail('outcome fields are invalid');
    const reportedModel = x.reportedModel === null ? null : str(x.reportedModel, 'reportedModel'); if ((x.modelProvenance === 'provider_reported') !== (reportedModel !== null)) fail('outcome model provenance is invalid');
    const output = x.output === null ? null : str(x.output, 'output'); const outputDigest = x.outputDigest === null ? null : digest(x.outputDigest, 'outputDigest'); if ((x.status==='completed') !== (output!==null && outputDigest!==null) || (output !== null && sha(Buffer.from(output, 'utf8')) !== outputDigest)) fail('outcome output fields are invalid');
    const judgmentId = str(x.judgmentId,'judgmentId'); if (!JUDGMENT_ID.test(judgmentId)) fail('judgmentId must be opaque lowercase 32hex');
    const data: Omit<ProposalExecutionOutcome, 'outcomeDigest'> = { schemaVersion: PROPOSAL_EXECUTION_OUTCOME_SCHEMA_VERSION, trialId: str(x.trialId,'trialId'), judgmentId, runId: str(x.runId,'runId'), scenarioId: str(x.scenarioId,'scenarioId'), host: x.host as Host, requestedModel: str(x.requestedModel,'requestedModel'), reportedModel, modelProvenance: x.modelProvenance as Provenance, policyId: str(x.policyId,'policyId'), policyDigest: digest(x.policyDigest,'policyDigest'), condition: x.condition as ProposalCondition, status: x.status as ProposalExecutionStatus, planDigest: digest(x.planDigest,'planDigest'), receiptDigest: digest(x.receiptDigest,'receiptDigest'), runtimeDigest: digest(x.runtimeDigest,'runtimeDigest'), output, outputDigest };
    const outcomeDigest = digest(x.outcomeDigest,'outcomeDigest'); if (sha(canonicalProposalExecutionJson(data)) !== outcomeDigest) fail('outcomeDigest mismatch'); return { ...data, outcomeDigest };
  });
}
function packet(outcome: ProposalExecutionOutcome, scenario: ProposalScenario): ProposalReviewPacket { const data = { judgmentId: outcome.judgmentId, scenario: scenario.scenario, evidence: scenario.evidence, knownBadClaims: scenario.knownBadClaims, validSolutionRubric: scenario.validSolutionRubric, output: outcome.output! }; return { ...data, packetDigest: sha(JSON.stringify(data)) }; }
export function prepareProposalExecutionReviewPackets(scenarios: ProposalScenario[], outcomes: ProposalExecutionOutcome[]): ProposalReviewPacket[] { const by = new Map(scenarios.map(s=>[s.scenarioId,s])); return outcomes.filter(o=>o.status==='completed').map(o => packet(o,by.get(o.scenarioId) ?? fail('outcome scenario missing'))); }
function rate(items: Array<{ known: 'yes'|'no'|'unclear'; valid: 'yes'|'no'|'unclear' }>, kind: 'known'|'valid'|'safe'): ProposalExecutionRate { const d=items.length; const lower=items.filter(x=>kind==='known'?x.known==='yes':kind==='valid'?x.valid==='yes':x.known==='no'&&x.valid==='yes').length; const upper=items.filter(x=>kind==='known'?x.known!=='no':kind==='valid'?x.valid!=='no':x.known!=='yes'&&x.valid!=='no').length; const unclear=items.filter(x=>kind==='known'?x.known==='unclear':kind==='valid'?x.valid==='unclear':x.known==='unclear'||x.valid==='unclear').length; return { lower:{numerator:lower,denominator:d,value:lower/d},upper:{numerator:upper,denominator:d,value:upper/d},unclearCount:unclear }; }
export function validateProposalExecutionArtifacts(input: ProposalExecutionCompileInput, outcomes: ProposalExecutionOutcome[], packets: ProposalReviewPacket[], judgments: ProposalJudgment[]): ProposalExecutionOutcome[] {
  const expected = compileProposalExecutionOutcomes(input);
  const all = outcomes.map((outcome) => parseProposalExecutionOutcomesJsonl(JSON.stringify(outcome))[0]!);
  const expectedByTrial = new Map(expected.map((outcome) => [outcome.trialId, outcome]));
  if (all.length !== expected.length || new Set(all.map((outcome) => outcome.trialId)).size !== all.length) fail('outcomes are not the exact compiled set');
  for (const outcome of all) if (canonicalProposalExecutionJson(outcome) !== canonicalProposalExecutionJson(expectedByTrial.get(outcome.trialId))) fail('outcome does not match compiled provenance');
  const scenarioById = new Map(input.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const packetBy = new Map(packets.map((packetValue) => { const parsed = parseProposalReviewPacketsJsonl(JSON.stringify(packetValue))[0]!; return [parsed.judgmentId, parsed] as const; }));
  const judgmentBy = new Map(judgments.map((judgmentValue) => { const parsed = parseProposalJudgmentsJsonl(JSON.stringify(judgmentValue))[0]!; return [parsed.judgmentId, parsed] as const; }));
  if (packetBy.size !== packets.length || judgmentBy.size !== judgments.length) fail('duplicate packet or judgment');
  const judgeByBlock = new Map<string, string>();
  for (const outcome of all) {
    const packetValue = packetBy.get(outcome.judgmentId); const judgment = judgmentBy.get(outcome.judgmentId);
    if (outcome.status !== 'completed') { if (packetValue || judgment) fail('noncompleted outcome must not have packet or judgment'); continue; }
    const scenario = scenarioById.get(outcome.scenarioId) ?? fail('completed outcome scenario missing');
    if (!packetValue || !judgment || canonicalProposalExecutionJson(packetValue) !== canonicalProposalExecutionJson(packet(outcome, scenario)) || judgment.packetDigest !== packetValue.packetDigest) fail('completed outcome requires its exact packet and judgment');
    const completedJudgment = judgment ?? fail('completed outcome judgment is missing');
    const key = [outcome.scenarioId, outcome.host, outcome.requestedModel, outcome.policyDigest].join('\0'); const judge = `${completedJudgment.judge}\0${completedJudgment.judgePromptDigest}`;
    if (judgeByBlock.has(key) && judgeByBlock.get(key) !== judge) fail('judge differs within comparison block'); judgeByBlock.set(key, judge);
  }
  return all;
}
export function evaluateProposalExecutionOutcomes(input: ProposalExecutionCompileInput, outcomes: ProposalExecutionOutcome[], packets: ProposalReviewPacket[], judgments: ProposalJudgment[]): ProposalExecutionEval {
  const parsedSuite = parseSuite(input.suite);
  const all = validateProposalExecutionArtifacts(input, outcomes, packets, judgments);
  const judgmentBy = new Map(judgments.map((value) => [value.judgmentId, parseProposalJudgmentsJsonl(JSON.stringify(value))[0]!]));
  const rows = all.map((outcome) => {
    if (outcome.status !== 'completed') return { o: outcome, known: 'unclear' as const, valid: 'unclear' as const };
    const judgment = judgmentBy.get(outcome.judgmentId) ?? fail('completed outcome judgment is missing');
    return { o: outcome, known: judgment.knownBadClaimEmitted, valid: judgment.validSolutionSupplied };
  });
  type Row = typeof rows[number];
  type ScenarioMetrics = ProposalExecutionEval['strata'][number]['scenarios'][number];
  const scenarioGroups = new Map<string, Row[]>();
  for (const row of rows) { const key = [row.o.scenarioId,row.o.host,row.o.requestedModel,row.o.runtimeDigest,row.o.policyDigest].join('\0'); const group = scenarioGroups.get(key) ?? []; group.push(row); scenarioGroups.set(key, group); }
  const strata = new Map<string, ScenarioMetrics[]>();
  for (const [key, scenarioRows] of scenarioGroups) {
    const [scenarioId,host,requestedModel,runtimeDigest,policyDigest] = key.split('\0') as [string,Host,string,string,string];
    const forCondition = (condition: ProposalCondition): ProposalExecutionConditionMetrics => { const group = scenarioRows.filter((row) => row.o.condition === condition); const statusCounts: Record<ProposalExecutionStatus, number> = { completed: 0, unavailable: 0, protocol_error: 0, tool_attempted: 0, nonzero_exit: 0 }; group.forEach((row) => statusCounts[row.o.status]++); return { trialCount: group.length, knownBadClaimRate: rate(group, 'known'), validSolutionRate: rate(group, 'valid'), safeAndUsefulRate: rate(group, 'safe'), statusCounts }; };
    const conditions = { control: forCondition('control'), caveat: forCondition('caveat') };
    const difference = (metric: 'knownBadClaimRate' | 'validSolutionRate' | 'safeAndUsefulRate') => { const caveat = conditions.caveat[metric]!; const control = conditions.control[metric]!; return { lower: caveat.lower.value - control.upper.value, upper: caveat.upper.value - control.lower.value }; };
    const scenario: ScenarioMetrics = { scenarioId, conditions, rateDifference: { knownBadClaimRate: difference('knownBadClaimRate'), validSolutionRate: difference('validSolutionRate'), safeAndUsefulRate: difference('safeAndUsefulRate') } };
    const stratumKey = [host,requestedModel,runtimeDigest,policyDigest].join('\0'); const group = strata.get(stratumKey) ?? []; group.push(scenario); strata.set(stratumKey, group);
  }
  return {schemaVersion:PROPOSAL_EXECUTION_EVAL_SCHEMA_VERSION,manifestDigest:parsedSuite.manifestDigest,strata:[...strata].map(([k,scenarios])=>{const [host,requestedModel,runtimeDigest,policyDigest]=k.split('\0') as [Host,string,string,string]; const stratumRows=rows.filter((row)=>row.o.host===host&&row.o.requestedModel===requestedModel&&row.o.runtimeDigest===runtimeDigest&&row.o.policyDigest===policyDigest); const proven=stratumRows.filter((row)=>row.o.modelProvenance==='provider_reported').length; const modelProvenance: StratumProvenance=proven===0?'requested_only':proven===stratumRows.length?'provider_reported':'completed_provider_reported'; const macro=(m: 'knownBadClaimRate' | 'validSolutionRate' | 'safeAndUsefulRate')=>({lower:scenarios.reduce((s,x)=>s+x.rateDifference[m]!.lower,0)/scenarios.length,upper:scenarios.reduce((s,x)=>s+x.rateDifference[m]!.upper,0)/scenarios.length});return{host,requestedModel,modelProvenance,runtimeDigest,policyDigest,scenarios,macroRateDifference:{knownBadClaimRate:macro('knownBadClaimRate'),validSolutionRate:macro('validSolutionRate'),safeAndUsefulRate:macro('safeAndUsefulRate')}};})};
}
