import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assignedConditions, type ProposalAssignment, type ProposalPolicy, type ProposalScenario } from '../src/proposalEval.js';
import { PROPOSAL_EXECUTION_SCHEMA_VERSION, buildProposalRequestBytes, canonicalProposalExecutionJson, proposalAssignmentDigest } from '../src/proposalExecution.js';
import { compileProposalExecutionOutcomes, evaluateProposalExecutionOutcomes, parseProposalExecutionOutcomesJsonl, parseProposalExecutionSuiteJson, prepareProposalExecutionReviewPackets, prepareProposalExecutionSuite, validateProposalExecutionArtifacts } from '../src/proposalExecutionCompiler.js';

const h = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const plan = (trialId: string, digest: string) => ({ trialId, scenarioId: 's', host: 'codex', requestedModel: 'm', policyId: 'p', policyDigest: h('policy'), planDigest: digest });
const assignment = { scenarioId: 's', host: 'codex' as const, model: 'm', policyId: 'p', policyDigest: h('policy'), seed: h('seed'), algorithm: 'sha256-sort-halves/v1' as const, runs: [{ trialId: 't1', judgmentId: '00000000000000000000000000000001', runId: 'r1' }, { trialId: 't2', judgmentId: '00000000000000000000000000000002', runId: 'r2' }, { trialId: 't3', judgmentId: '00000000000000000000000000000003', runId: 'r3' }, { trialId: 't4', judgmentId: '00000000000000000000000000000004', runId: 'r4' }] };

function executionFixture() {
  const evidence = [{ reference: 'r', content: 'e', digest: h('e') }];
  const scenario: ProposalScenario = { scenarioId: 'scenario', scenario: 'prompt', evidence, knownBadClaims: ['bad'], validSolutionRubric: ['good'], reminder: 'remember', scenarioDigest: h(JSON.stringify({ scenario: 'prompt', evidence: evidence.map(({ reference, digest }) => ({ reference, digest })), knownBadClaims: ['bad'], validSolutionRubric: ['good'] })), reminderDigest: h('remember') };
  const policyData = { host: 'codex', model: 'model', hostAdapter: 'codex-cli/prompt-injected-reminder/v1', systemInstructions: '', developerInstructions: '', toolSchema: {}, toolAllowlist: [], permissionMode: 'read-only-no-tools', sampling: { temperature: null, topP: null, seed: null } };
  const policy: ProposalPolicy = { policyId: 'policy', ...policyData, policyDigest: h(canonicalProposalExecutionJson(policyData)) };
  const manifest: ProposalAssignment = { scenarioId: scenario.scenarioId, host: 'codex', model: 'model', policyId: policy.policyId, policyDigest: policy.policyDigest, seed: h('seed'), algorithm: 'sha256-sort-halves/v1', runs: ['a', 'b', 'c', 'd'].map((runId, index) => ({ trialId: `trial-${runId}`, judgmentId: `${index + 1}`.padStart(32, '0'), runId })) };
  const conditions = assignedConditions(manifest); const plans = manifest.runs.map((run) => { const condition = conditions.get(run.runId)!; const request = buildProposalRequestBytes(scenario, condition); const environment = { values: { HOME: '/tmp/home', CODEX_HOME: '/tmp/home/.codex', PATH: '/bin', TMPDIR: '/tmp/work', LANG: 'C.UTF-8' }, credentialSlotId: h('codex\0/tmp/home/.codex'), endpoint: 'default', organization: null, project: null }; const invocationData = { executablePath: '/usr/bin/codex', executableDigest: h('binary'), argv: ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--model', 'model', '-'], cwdPath: '/tmp/work', environment }; const invocation = { ...invocationData, digest: h(canonicalProposalExecutionJson(invocationData)) }; const data = { schemaVersion: PROPOSAL_EXECUTION_SCHEMA_VERSION, trialId: run.trialId, judgmentId: run.judgmentId, runId: run.runId, scenarioId: scenario.scenarioId, host: 'codex' as const, policyId: policy.policyId, condition, adapter: 'codex-cli' as const, adapterVersion: '1', requestedModel: policy.model, scenarioDigest: scenario.scenarioDigest, policyDigest: policy.policyDigest, assignmentDigest: proposalAssignmentDigest(manifest), request: { bytesBase64: request.toString('base64'), byteLength: request.length, digest: h(request), channel: 'stdin' as const, envelope: 'prompt-injected-reminder/v1' as const }, invocation }; return { ...data, planDigest: h(canonicalProposalExecutionJson(data)) }; });
  const raw = new Map(plans.map((plan) => { const output = `answer ${plan.trialId}`; const stdout = Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: `thread-${plan.trialId}` })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: output } })}\n${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`); return [plan.trialId, { rawStdout: stdout, rawStderr: Buffer.alloc(0), output: Buffer.from(output) }] as const; }));
  const receipts = plans.map((plan) => { const bytes = raw.get(plan.trialId)!; const data = { schemaVersion: PROPOSAL_EXECUTION_SCHEMA_VERSION, trialId: plan.trialId, runId: plan.runId, planDigest: plan.planDigest, invocationDigest: plan.invocation.digest, status: 'completed' as const, startedAt: '2026-07-13T01:02:03.000Z', completedAt: '2026-07-13T01:02:04.000Z', cliVersion: '1', exitCode: 0, providerRunId: `thread-${plan.trialId}`, reportedModel: null, modelProvenance: 'requested_only' as const, requestSubmission: 'passed_to_spawn_sync' as const, submittedRequestDigest: plan.request.digest, submittedByteLength: plan.request.byteLength, rawStdoutDigest: h(bytes.rawStdout), rawStderrDigest: h(bytes.rawStderr), outputDigest: h(bytes.output!) }; return { ...data, receiptDigest: h(canonicalProposalExecutionJson(data)) }; });
  const suite = prepareProposalExecutionSuite([manifest], plans, '00000000000000000000000000000001');
  return { scenarios: [scenario], policies: [policy], assignments: [manifest], plans, receipts, suite, raw };
}

describe('proposal execution compiler schemas', () => {
  it('seals sorted suite blocks and rejects missing block plan or digest mutation', () => {
    const suite = prepareProposalExecutionSuite([assignment], [plan('t1', h('p1')) as any, plan('t2', h('p2')) as any, plan('t3', h('p3')) as any, plan('t4', h('p4')) as any], '00000000000000000000000000000001');
    expect(parseProposalExecutionSuiteJson(JSON.stringify(suite))).toEqual(suite);
    expect(() => parseProposalExecutionSuiteJson(JSON.stringify({ ...suite, blocks: [{ ...suite.blocks[0]!, planDigests: suite.blocks[0]!.planDigests.slice(1) }] }))).toThrow(/exact|manifest/);
    expect(() => parseProposalExecutionSuiteJson(JSON.stringify({ ...suite, manifestDigest: h('tampered') }))).toThrow(/manifestDigest/);
    expect(() => parseProposalExecutionSuiteJson(JSON.stringify({ ...suite, unexpected: true }))).toThrow(/keys/);
  });

  it('rejects outcome unknown keys and outcome digest mutation', () => {
    const data = { schemaVersion: 'proposal-execution-outcome/v1', trialId: 't', judgmentId: '00000000000000000000000000000001', runId: 'r', scenarioId: 's', host: 'codex', requestedModel: 'm', reportedModel: null, modelProvenance: 'requested_only', policyId: 'p', policyDigest: h('policy'), condition: 'control', status: 'completed', planDigest: h('plan'), receiptDigest: h('receipt'), runtimeDigest: h('runtime'), output: 'answer', outputDigest: h('answer') };
    const outcome = { ...data, outcomeDigest: h(canonicalProposalExecutionJson(data)) };
    expect(parseProposalExecutionOutcomesJsonl(JSON.stringify(outcome))).toEqual([outcome]);
    expect(() => parseProposalExecutionOutcomesJsonl(JSON.stringify({ ...outcome, unexpected: true }))).toThrow(/keys/);
    expect(() => parseProposalExecutionOutcomesJsonl(JSON.stringify({ ...outcome, output: 'changed' }))).toThrow(/output fields|outcomeDigest/);
  });

  it('requires the exact sealed suite block and plan set', () => {
    const fixture = executionFixture();
    expect(() => compileProposalExecutionOutcomes({ ...fixture, suite: { ...fixture.suite, blocks: [] } })).toThrow(/suite|manifest/);
    const extra = { ...fixture.suite.blocks[0]!, planDigests: [...fixture.suite.blocks[0]!.planDigests, h('extra')] };
    expect(() => compileProposalExecutionOutcomes({ ...fixture, suite: { ...fixture.suite, blocks: [extra] } })).toThrow(/suite|manifest/);
    expect(() => compileProposalExecutionOutcomes({ ...fixture, plans: fixture.plans.slice(1) })).toThrow(/every assignment|suite/);
    expect(() => compileProposalExecutionOutcomes({ ...fixture, plans: [...fixture.plans, fixture.plans[0]!] })).toThrow(/mismatch|suite/);
  });

  it('rejects raw mutation and exact-set/output resealing attacks', () => {
    const fixture = executionFixture();
    const trial = fixture.plans[0]!.trialId;
    const changedRaw = new Map(fixture.raw); changedRaw.set(trial, { ...changedRaw.get(trial)!, rawStdout: Buffer.from('changed') });
    expect(() => compileProposalExecutionOutcomes({ ...fixture, raw: changedRaw })).toThrow(/raw digest/);
    const missingRaw = new Map(fixture.raw); missingRaw.delete(trial);
    expect(() => compileProposalExecutionOutcomes({ ...fixture, raw: missingRaw })).toThrow(/raw map/);
    const extraRaw = new Map(fixture.raw); extraRaw.set('extra', fixture.raw.get(trial)!);
    expect(() => compileProposalExecutionOutcomes({ ...fixture, raw: extraRaw })).toThrow(/raw map/);
    const outcomes = compileProposalExecutionOutcomes(fixture); const changed = { ...outcomes[0]!, output: 'forged' }; const { outcomeDigest: ignored, ...data } = changed;
    const resealed = { ...changed, outputDigest: h('forged'), outcomeDigest: h(canonicalProposalExecutionJson({ ...data, outputDigest: h('forged') })) };
    expect(() => validateProposalExecutionArtifacts(fixture, [resealed, ...outcomes.slice(1)], [], [])).toThrow(/compiled provenance/);
  });

  it('requires exact completed packets/judgments and keeps noncompleted trials unjudged', () => {
    const fixture = executionFixture(); const outcomes = compileProposalExecutionOutcomes(fixture); const packets = prepareProposalExecutionReviewPackets(fixture.scenarios, outcomes);
    const judgments = packets.map((packet) => ({ judgmentId: packet.judgmentId, packetDigest: packet.packetDigest, knownBadClaimEmitted: 'no' as const, validSolutionSupplied: 'yes' as const, judge: 'judge', judgePrompt: 'prompt', judgePromptDigest: h('prompt'), maskedReviewAttested: true as const }));
    expect(() => validateProposalExecutionArtifacts(fixture, outcomes, packets, judgments)).not.toThrow();
    expect(() => validateProposalExecutionArtifacts(fixture, outcomes, packets.slice(1), judgments.slice(1))).toThrow(/completed outcome/);
    const forgedPacket = { ...packets[0]!, output: 'safe replacement', packetDigest: h(JSON.stringify({ ...packets[0]!, output: 'safe replacement', packetDigest: undefined })) };
    expect(() => validateProposalExecutionArtifacts(fixture, outcomes, [forgedPacket as any, ...packets.slice(1)], judgments)).toThrow();
    const noncompleted = { ...outcomes[0]!, status: 'tool_attempted', output: null, outputDigest: null }; const { outcomeDigest: removed, ...noncompletedData } = noncompleted; const resealed = { ...noncompleted, outcomeDigest: h(canonicalProposalExecutionJson(noncompletedData)) };
    expect(() => validateProposalExecutionArtifacts(fixture, [resealed, ...outcomes.slice(1)], packets, judgments)).toThrow(/compiled provenance/);
  });

  it('uses every plan as the denominator and scenario-macro differences', () => {
    const fixture = executionFixture(); const outcomes = compileProposalExecutionOutcomes(fixture); const packets = prepareProposalExecutionReviewPackets(fixture.scenarios, outcomes);
    const judgments = packets.map((packet, index) => ({ judgmentId: packet.judgmentId, packetDigest: packet.packetDigest, knownBadClaimEmitted: index % 2 === 0 ? 'unclear' as const : 'no' as const, validSolutionSupplied: 'unclear' as const, judge: 'judge', judgePrompt: 'prompt', judgePromptDigest: h('prompt'), maskedReviewAttested: true as const }));
    const evaluated = evaluateProposalExecutionOutcomes(fixture, outcomes, packets, judgments);
    expect(evaluated.strata[0]!.scenarios[0]!.conditions.control.knownBadClaimRate.lower.denominator).toBe(2);
    expect(evaluated.strata[0]!.macroRateDifference).toHaveProperty('validSolutionRate');
  });

  it('rejects an otherwise valid noncompleted outcome with a packet or judgment', () => {
    const fixture = executionFixture(); const plan = fixture.plans[0]!;
    const stdout = Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: `thread-${plan.trialId}` })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'item.started', item: { id: 'tool', type: 'command_execution' } })}\n${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`);
    const raw = new Map(fixture.raw); raw.set(plan.trialId, { rawStdout: stdout, rawStderr: Buffer.alloc(0), output: null });
    const original = fixture.receipts[0]!; const receiptData = { ...original, status: 'tool_attempted' as const, rawStdoutDigest: h(stdout), rawStderrDigest: h(Buffer.alloc(0)), outputDigest: null }; delete (receiptData as { receiptDigest?: string }).receiptDigest;
    const receipt = { ...receiptData, receiptDigest: h(canonicalProposalExecutionJson(receiptData)) };
    const input = { ...fixture, raw, receipts: [receipt, ...fixture.receipts.slice(1)] };
    const outcomes = compileProposalExecutionOutcomes(input); const packets = prepareProposalExecutionReviewPackets(input.scenarios, outcomes);
    const judgments = packets.map((packet) => ({ judgmentId: packet.judgmentId, packetDigest: packet.packetDigest, knownBadClaimEmitted: 'no' as const, validSolutionSupplied: 'yes' as const, judge: 'judge', judgePrompt: 'prompt', judgePromptDigest: h('prompt'), maskedReviewAttested: true as const }));
    const { packetDigest: ignoredDigest, ...packetData } = { ...packets[0]!, judgmentId: outcomes[0]!.judgmentId };
    const packetForNoncompleted = { ...packetData, packetDigest: h(JSON.stringify(packetData)) };
    expect(() => validateProposalExecutionArtifacts(input, outcomes, [packetForNoncompleted, ...packets], judgments)).toThrow(/noncompleted/);
    expect(evaluateProposalExecutionOutcomes(input, outcomes, packets, judgments).strata[0]!.scenarios[0]!.conditions[outcomes[0]!.condition].validSolutionRate.unclearCount).toBeGreaterThan(0);
  });

  it('accepts an all-noncompleted block with zero packets and judgments', () => {
    const fixture = executionFixture(); const raw = new Map(fixture.raw); const receipts = fixture.plans.map((plan, index) => { const stdout = Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: `tool-${index}` })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'item.started', item: { id: 'tool', type: 'command_execution' } })}\n${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`); raw.set(plan.trialId, { rawStdout: stdout, rawStderr: Buffer.alloc(0), output: null }); const original = fixture.receipts[index]!; const data = { ...original, status: 'tool_attempted' as const, providerRunId: `tool-${index}`, rawStdoutDigest: h(stdout), rawStderrDigest: h(Buffer.alloc(0)), outputDigest: null }; delete (data as { receiptDigest?: string }).receiptDigest; return { ...data, receiptDigest: h(canonicalProposalExecutionJson(data)) }; }); const input = { ...fixture, raw, receipts }; const outcomes = compileProposalExecutionOutcomes(input); expect(prepareProposalExecutionReviewPackets(input.scenarios, outcomes)).toEqual([]); const evaluated = evaluateProposalExecutionOutcomes(input, outcomes, [], []); const scenario = evaluated.strata[0]!.scenarios[0]!; expect(scenario.conditions.control.knownBadClaimRate.unclearCount).toBe(2); expect(scenario.conditions.caveat.validSolutionRate.unclearCount).toBe(2);
  });
});
