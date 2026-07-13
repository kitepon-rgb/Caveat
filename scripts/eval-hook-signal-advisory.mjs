#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import {
  isPathInside,
  parseProposalJudgmentsJsonl,
  parseProposalReviewPacketsJsonl,
} from '../packages/core/dist/proposalEval.js';

const MODEL = 'gpt-5.6-luna';
const BATCH = 'hook-signal-ab';
const PRICE = { input: 25, cached: 2.5, output: 150 };
const BASE_SURFACES = new Map([
  ['stop-candidate-selection', 'stop'],
  ['tool-error-candidate-selection', 'tool_error'],
]);
const EXPECTED_BASE = [
  {
    id: 'stop-candidate-selection',
    surface: 'stop',
    prompt: 'Synthetic Stop advisory: decide which supplied Caveat guidance is relevant, then give one concise next step.',
    context: [
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'If a session has repeated Bash commands, first isolate the repeated command and verify its assumptions.' },
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'If a session repeatedly edits a file, rerun the smallest affected test before reporting completion.' },
    ],
    knownBadClaims: ['Apply both caveats without selecting one.', 'Report completion without a targeted verification.'],
    rubric: ['Select the repeated-edit test gate when the structural signal indicates re-edited files.', 'Recommend the smallest affected test.'],
    signal: {
      kind: 'manual_note', source: 'caveat-hook-signal', trust: 'local',
      summary: 'Hook signal: 0 tool failures, 2 re-edited files, 0 web searches, 0 web fetches, 0 Bash retries, 8 elapsed minutes.',
      data: { type: 'stop', tool_failure_count: 0, reedited_file_count: 2, web_search_count: 0, web_fetch_count: 0, bash_retry_count: 0, duration_minutes: 8 },
    },
  },
  {
    id: 'tool-error-candidate-selection',
    surface: 'tool_error',
    prompt: 'Synthetic tool_error advisory: decide which supplied Caveat guidance is relevant, then give one concise next step.',
    context: [
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'For a Bash failure, inspect the command preconditions and the exact exit status before retrying.' },
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'For an Edit failure, verify the target file state before attempting another edit.' },
    ],
    knownBadClaims: ['Retry every candidate action blindly.', 'Treat the unknown raw error text as sidecar context.'],
    rubric: ['Select the Bash-specific guidance.', 'Recommend checking command preconditions before retrying.'],
    signal: {
      kind: 'manual_note', source: 'caveat-hook-signal', trust: 'local',
      summary: 'Hook signal: Bash tool error (post-tool-use-failure).',
      data: { type: 'tool-error', tool: 'bash', failure_kind: 'post-tool-use-failure' },
    },
  },
];
const sha = (value) => createHash('sha256').update(value).digest('hex');

try {
  main();
} catch (error) {
  process.stderr.write(`[caveat:eval-hook-signal] ${error instanceof Error ? error.message : 'unexpected failure'}\n`);
  process.exitCode = 1;
}

function main() {
  const home = realpathSync(process.env.HOME || homedir());
  const caveat = findCaveatHome(home);
  const knowledge = realpathSync(resolvePaths(
    caveat,
    loadConfig(join(home, '.caveatrc.json')).knowledgeRepo,
    home,
  ).knowledgeRepo);
  const root = join(caveat, 'local-eval', 'sidecar-advisory', BATCH);
  safeRoot(root, knowledge);
  const outputPath = join(root, 'evaluation.json');
  if (existsSync(outputPath)) throw new Error('evaluation output already exists');

  const study = parseStudy(JSON.parse(readFileSync(join(root, 'study.json'), 'utf8')));
  const receipts = jsonl(join(root, 'receipts.jsonl'));
  const packets = parseProposalReviewPacketsJsonl(readFileSync(join(root, 'review-packets.jsonl'), 'utf8'));
  const judgmentBytes = readFileSync(join(root, 'judgments-sonnet5.jsonl'));
  const judgments = parseProposalJudgmentsJsonl(judgmentBytes.toString('utf8'));
  const judgeRawBytes = readFileSync(join(root, 'judge-raw-sonnet5.jsonl'));
  const receiptByRun = uniqueMap(receipts, 'runId', 'receipt');
  const packetByJudgment = uniqueMap(packets, 'judgmentId', 'packet');
  const judgmentById = uniqueMap(judgments, 'judgmentId', 'judgment');
  if (receipts.length !== 8 || receiptByRun.size !== 8) throw new Error('receipt set mismatch');

  const completedIds = new Set();
  const groups = new Map();
  const artifactsByRun = new Map();
  for (const run of study.runs) {
    const receipt = receiptByRun.get(run.runId);
    validateReceipt(receipt, run);
    artifactsByRun.set(run.runId, validateRunArtifacts(root, run, receipt));
    const { base, condition } = scenarioIdentity(run.scenarioId);
    const groupKey = `${base}\0${run.replicate}`;
    const group = groups.get(groupKey) ?? {};
    if (group[condition]) throw new Error('duplicate pair condition');
    group[condition] = run;
    groups.set(groupKey, group);
    if (receipt.status === 'completed') completedIds.add(run.judgmentId);
  }
  if (groups.size !== 4) throw new Error('pair count mismatch');
  for (const group of groups.values()) validatePair(group.control, group.signal);

  if (packets.length !== completedIds.size || packetByJudgment.size !== completedIds.size) {
    throw new Error('packet set mismatch');
  }
  if (judgments.length !== completedIds.size || judgmentById.size !== completedIds.size) {
    throw new Error('judgment set mismatch');
  }
  for (const id of packetByJudgment.keys()) if (!completedIds.has(id)) throw new Error('packet for noncompleted run');
  for (const id of judgmentById.keys()) if (!completedIds.has(id)) throw new Error('judgment for noncompleted run');

  const metrics = { control: blankCondition(), signal: blankCondition() };
  let commonJudge = null;
  let commonJudgePromptDigest = null;
  for (const run of study.runs) {
    const { condition } = scenarioIdentity(run.scenarioId);
    const receipt = receiptByRun.get(run.runId);
    const buckets = [metrics[condition], metrics[condition].surfaces[run.surface]];
    for (const bucket of buckets) {
      bucket.total += 1;
      if (receipt.status === 'completed') bucket.completed += 1;
      if (receipt.usageStatus === 'available') {
        bucket.usageRuns += 1;
        addUsage(bucket.usage, receipt.usage);
      }
    }
    if (receipt.status !== 'completed') {
      for (const bucket of buckets) {
        bucket.knownBad.unclear += 1;
        bucket.valid.unclear += 1;
      }
      continue;
    }
    const packet = packetByJudgment.get(run.judgmentId);
    const judgment = judgmentById.get(run.judgmentId);
    validatePacket(packet, run, artifactsByRun.get(run.runId).result);
    const provenance = validateJudgment(judgment, packet);
    commonJudge ??= provenance.judge;
    commonJudgePromptDigest ??= provenance.judgePromptDigest;
    if (provenance.judge !== commonJudge || provenance.judgePromptDigest !== commonJudgePromptDigest) {
      throw new Error('judge provenance differs across packets');
    }
    for (const bucket of buckets) {
      bucket.knownBad[judgment.knownBadClaimEmitted] += 1;
      bucket.valid[judgment.validSolutionSupplied] += 1;
    }
  }
  for (const condition of Object.values(metrics)) finalizeCondition(condition);
  const judgeProvenance = validateJudgeRaw(
    judgeRawBytes,
    commonJudge,
    commonJudgePromptDigest,
    judgmentBytes,
  );

  const data = {
    schemaVersion: 'hook-signal-advisory-evaluation/v1',
    scope: 'synthetic-public-paired-signal-only',
    pricing: {
      unit: 'Codex credits per 1M tokens',
      source: 'existing sidecar-advisory evaluation v2',
      gpt_5_6_luna: PRICE,
    },
    judgeProvenance,
    metrics,
    difference: {
      completed: metrics.signal.completed - metrics.control.completed,
      knownBadYes: metrics.signal.knownBad.yes - metrics.control.knownBad.yes,
      validSolutionYes: metrics.signal.valid.yes - metrics.control.valid.yes,
      creditsPerRun: round(metrics.signal.creditsPerRun - metrics.control.creditsPerRun),
    },
  };
  const output = { ...data, digest: sha(JSON.stringify(data)) };
  exclusive(outputPath, Buffer.from(`${JSON.stringify(output, null, 2)}\n`));
  process.stdout.write(`${JSON.stringify({ schemaVersion: output.schemaVersion, digest: output.digest })}\n`);
}

function parseStudy(value) {
  const expectedManifest = sha(JSON.stringify(EXPECTED_BASE));
  const expectedSeed = sha(`hook-signal-advisory/v1\0${expectedManifest}`);
  if (!plain(value) || !exactKeys(value, ['schemaVersion', 'seed', 'sidecarCli', 'sidecarVersion', 'runs'])
    || value.schemaVersion !== 'sidecar-advisory-study/v1'
    || value.seed !== expectedSeed
    || !plain(value.sidecarCli)
    || !exactKeys(value.sidecarCli, ['kind', 'path'])
    || !['node_js', 'executable'].includes(value.sidecarCli.kind)
    || typeof value.sidecarCli.path !== 'string'
    || !value.sidecarCli.path.startsWith('/')
    || typeof value.sidecarVersion !== 'string'
    || !value.sidecarVersion
    || !Array.isArray(value.runs)
    || value.runs.length !== 8) throw new Error('study is invalid');
  const ids = new Set();
  const cells = new Set();
  for (const run of value.runs) {
    const keys = ['runId', 'judgmentId', 'scenarioId', 'surface', 'model', 'replicate', 'reasoningEffort', 'prompt', 'context', 'knownBadClaims', 'validSolutionRubric'];
    if (!plain(run) || !exactKeys(run, keys)
      || !/^[0-9a-f]{32}$/.test(run.runId)
      || !/^[0-9a-f]{32}$/.test(run.judgmentId)
      || ids.has(run.runId) || ids.has(run.judgmentId)
      || run.model !== MODEL || run.reasoningEffort !== 'low'
      || ![0, 1].includes(run.replicate)
      || typeof run.prompt !== 'string' || !run.prompt
      || !stringArray(run.knownBadClaims) || !run.knownBadClaims.length
      || !stringArray(run.validSolutionRubric) || !run.validSolutionRubric.length
      || !Array.isArray(run.context)) throw new Error('study run is invalid');
    const { base, condition } = scenarioIdentity(run.scenarioId);
    if (run.surface !== BASE_SURFACES.get(base)) throw new Error('study surface mismatch');
    const identity = `${value.seed}\0${run.scenarioId}\0${run.surface}\0${MODEL}\0${run.replicate}`;
    if (run.runId !== sha(`${identity}\0run`).slice(0, 32)
      || run.judgmentId !== sha(`${identity}\0judge`).slice(0, 32)) throw new Error('study identity mismatch');
    validateConditionContext(base, condition, run.context);
    const expected = EXPECTED_BASE.find((candidate) => candidate.id === base);
    if (!expected || run.prompt !== expected.prompt
      || JSON.stringify(run.knownBadClaims) !== JSON.stringify(expected.knownBadClaims)
      || JSON.stringify(run.validSolutionRubric) !== JSON.stringify(expected.rubric)) {
      throw new Error('study scenario manifest drift');
    }
    const cell = `${base}\0${condition}\0${run.replicate}`;
    if (cells.has(cell)) throw new Error('duplicate study cell');
    cells.add(cell);
    ids.add(run.runId);
    ids.add(run.judgmentId);
  }
  if (cells.size !== 8) throw new Error('study cells are unbalanced');
  const expected = [...value.runs].sort((left, right) =>
    sha(`${value.seed}\0${left.runId}\0order`).localeCompare(sha(`${value.seed}\0${right.runId}\0order`)));
  if (expected.some((run, index) => run.runId !== value.runs[index].runId)) throw new Error('study order mismatch');
  return value;
}

function validateConditionContext(base, condition, context) {
  const expected = EXPECTED_BASE.find((candidate) => candidate.id === base);
  if (!expected) throw new Error('unknown scenario context');
  const expectedSignal = expected.signal;
  const signalIndexes = context
    .map((block, index) => block?.source === 'caveat-hook-signal' ? index : -1)
    .filter((index) => index >= 0);
  if (condition === 'control') {
    if (context.length !== 2 || signalIndexes.length !== 0) throw new Error('control context is invalid');
  } else if (context.length !== 3 || signalIndexes.length !== 1 || signalIndexes[0] !== 2
    || JSON.stringify(context[2]) !== JSON.stringify(expectedSignal)) {
    throw new Error('signal context is invalid');
  }
  const caveats = condition === 'signal' ? context.slice(0, -1) : context;
  if (JSON.stringify(caveats) !== JSON.stringify(expected.context)) throw new Error('caveat context is invalid');
}

function validatePair(control, signal) {
  if (!control || !signal
    || control.surface !== signal.surface
    || control.replicate !== signal.replicate
    || control.prompt !== signal.prompt
    || JSON.stringify(control.knownBadClaims) !== JSON.stringify(signal.knownBadClaims)
    || JSON.stringify(control.validSolutionRubric) !== JSON.stringify(signal.validSolutionRubric)
    || JSON.stringify(control.context) !== JSON.stringify(signal.context.slice(0, -1))) {
    throw new Error('pair drift');
  }
}

function validateReceipt(receipt, run) {
  const keys = ['schemaVersion', 'runId', 'judgmentId', 'scenarioId', 'surface', 'requestedModel', 'reasoningEffort', 'modelProvenance', 'reportedModel', 'status', 'usageStatus', 'usage', 'totalLatencyMs', 'modelTurnLatencyMs', 'resultDigest', 'rawEventLogDigest', 'digest'];
  if (!plain(receipt) || !exactKeys(receipt, keys)) throw new Error('receipt schema mismatch');
  const { digest, ...data } = receipt;
  if (digest !== sha(JSON.stringify(data))
    || receipt.schemaVersion !== 'sidecar-advisory-receipt/v1'
    || receipt.runId !== run.runId || receipt.judgmentId !== run.judgmentId
    || receipt.scenarioId !== run.scenarioId || receipt.surface !== run.surface
    || receipt.requestedModel !== MODEL || receipt.reasoningEffort !== 'low'
    || !['requested_and_process_args', 'requested_only'].includes(receipt.modelProvenance)
    || receipt.reportedModel !== null
    || !['completed', 'noncompleted'].includes(receipt.status)
    || !['available', 'unavailable'].includes(receipt.usageStatus)
    || !Number.isSafeInteger(receipt.totalLatencyMs) || receipt.totalLatencyMs < 0
    || !(receipt.modelTurnLatencyMs === null || Number.isSafeInteger(receipt.modelTurnLatencyMs) && receipt.modelTurnLatencyMs >= 0)
    || !(receipt.resultDigest === null || /^[0-9a-f]{64}$/.test(receipt.resultDigest))
    || !(receipt.rawEventLogDigest === null || /^[0-9a-f]{64}$/.test(receipt.rawEventLogDigest))) {
    throw new Error('receipt/run integrity failure');
  }
  if (receipt.usageStatus === 'available') validateUsage(receipt.usage);
  else if (receipt.usage !== null) throw new Error('unavailable usage must be null');
  if (receipt.status === 'completed' && (receipt.modelProvenance !== 'requested_and_process_args'
    || receipt.resultDigest === null || receipt.rawEventLogDigest === null)) throw new Error('completed receipt lacks provenance');
}

function validatePacket(packet, run, result) {
  const expectedEvidence = run.context.map((block, index) => ({
    reference: `context-${index}`,
    content: JSON.stringify(block),
    digest: sha(JSON.stringify(block)),
  }));
  if (!packet || packet.judgmentId !== run.judgmentId
    || packet.scenario !== run.prompt
    || JSON.stringify(packet.evidence) !== JSON.stringify(expectedEvidence)
    || JSON.stringify(packet.knownBadClaims) !== JSON.stringify(run.knownBadClaims)
    || JSON.stringify(packet.validSolutionRubric) !== JSON.stringify(run.validSolutionRubric)
    || packet.output !== `${result.summary}\n${result.recommendedNextAction}`) throw new Error('packet/run integrity failure');
}

function validateJudgment(judgment, packet) {
  if (!judgment || judgment.packetDigest !== packet.packetDigest
    || judgment.maskedReviewAttested !== true
    || typeof judgment.judge !== 'string'
    || !/^claude-cli:.+:primary=claude-sonnet-5:usage=[a-z0-9.,-]+$/.test(judgment.judge)
    || !judgment.judge.split(':usage=')[1].split(',').includes('claude-sonnet-5')
    || !['yes', 'no', 'unclear'].includes(judgment.knownBadClaimEmitted)
    || !['yes', 'no', 'unclear'].includes(judgment.validSolutionSupplied)) {
    throw new Error('judgment is invalid');
  }
  return { judge: judgment.judge, judgePromptDigest: judgment.judgePromptDigest };
}

function validateRunArtifacts(root, run, receipt) {
  const workRoot = join(root, 'work');
  const work = join(workRoot, sha(run.runId));
  const stdoutPath = join(work, 'stdout.bin');
  if (!existsSync(work) || !statSync(work).isDirectory() || (statSync(work).mode & 0o777) !== 0o700
    || !existsSync(stdoutPath) || !statSync(stdoutPath).isFile() || (statSync(stdoutPath).mode & 0o777) !== 0o600) {
    throw new Error('run work artifact is unsafe');
  }
  const result = JSON.parse(readFileSync(stdoutPath, 'utf8'));
  if (!plain(result) || result.status !== 'ok' || result.workflow !== 'explore'
    || typeof result.summary !== 'string' || !result.summary
    || typeof result.recommendedNextAction !== 'string' || !result.recommendedNextAction
    || result.modelPolicy?.source !== 'explicit' || result.modelPolicy?.model !== MODEL
    || result.modelPolicy?.modelReasoningEffort !== 'low'
    || result.normalizedRequest?.model !== MODEL
    || result.normalizedRequest?.modelReasoningEffort !== 'low'
    || sha(JSON.stringify(result)) !== receipt.resultDigest
    || typeof result.rawEventLogRef !== 'string' || !isAbsolute(result.rawEventLogRef)
    || !existsSync(result.rawEventLogRef) || !statSync(result.rawEventLogRef).isFile()) {
    throw new Error('SidecarResult artifact mismatch');
  }
  const rawReal = realpathSync(result.rawEventLogRef);
  if (!isPathInside(realpathSync(workRoot), rawReal) || !isPathInside(realpathSync(work), rawReal)
    || sha(readFileSync(rawReal)) !== receipt.rawEventLogDigest) throw new Error('raw event log artifact mismatch');
  return { result, rawEventLogRef: rawReal };
}

function validateJudgeRaw(rawBytes, commonJudge, judgePromptDigest, judgmentBytes) {
  try {
    const events = rawBytes.toString('utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const init = events[0];
    const terminals = events.filter((event) => event?.type === 'result');
    const assistants = events.filter((event) => event?.type === 'assistant');
    if (init?.type !== 'system' || init?.subtype !== 'init' || init.model !== 'claude-sonnet-5'
      || typeof init.claude_code_version !== 'string' || !init.claude_code_version
      || terminals.length !== 1 || !plain(terminals[0].modelUsage)
      || assistants.length === 0 || assistants.some((event) => event.message?.model !== 'claude-sonnet-5')) {
      throw new Error();
    }
    const usageModels = Object.keys(terminals[0].modelUsage).sort();
    if (!usageModels.includes('claude-sonnet-5') || usageModels.some((model) => !model || model.includes('\0'))) throw new Error();
    const expectedJudge = `claude-cli:${init.claude_code_version}:primary=claude-sonnet-5:usage=${usageModels.join(',')}`;
    if (commonJudge !== expectedJudge || !/^[0-9a-f]{64}$/.test(judgePromptDigest)) throw new Error();
    return {
      judge: expectedJudge,
      primaryModel: 'claude-sonnet-5',
      usageModels,
      judgePromptDigest,
      judgmentsDigest: sha(judgmentBytes),
      rawStreamDigest: sha(rawBytes),
    };
  } catch {
    throw new Error('judge raw provenance mismatch');
  }
}

function scenarioIdentity(value) {
  if (typeof value !== 'string') throw new Error('scenario identity invalid');
  const match = /^(stop-candidate-selection|tool-error-candidate-selection)--(control|signal)$/.exec(value);
  if (!match) throw new Error('scenario identity invalid');
  return { base: match[1], condition: match[2] };
}

function validateUsage(value) {
  const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'modelContextWindow'];
  if (!plain(value) || !exactKeys(value, keys)
    || !keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.totalTokens !== value.inputTokens + value.outputTokens
    || value.cachedInputTokens > value.inputTokens
    || value.modelContextWindow < 1) throw new Error('usage is invalid');
}

function blankBucket() {
  return { total: 0, completed: 0, knownBad: counts(), valid: counts(), usageRuns: 0, usage: usage() };
}
function blankCondition() {
  return { ...blankBucket(), surfaces: { stop: blankBucket(), tool_error: blankBucket() } };
}
function counts() { return { yes: 0, no: 0, unclear: 0 }; }
function usage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }; }
function addUsage(target, source) { for (const key of Object.keys(target)) target[key] += source[key]; }
function finalizeCondition(condition) {
  finalizeBucket(condition);
  finalizeBucket(condition.surfaces.stop);
  finalizeBucket(condition.surfaces.tool_error);
}
function finalizeBucket(bucket) {
  const noncached = bucket.usage.inputTokens - bucket.usage.cachedInputTokens;
  bucket.credits = round((noncached * PRICE.input
    + bucket.usage.cachedInputTokens * PRICE.cached
    + bucket.usage.outputTokens * PRICE.output) / 1_000_000);
  bucket.creditsPerRun = round(bucket.credits / bucket.total);
}
function uniqueMap(values, key, label) {
  const map = new Map();
  for (const value of values) {
    if (!plain(value) || typeof value[key] !== 'string' || map.has(value[key])) throw new Error(`duplicate or invalid ${label}`);
    map.set(value[key], value);
  }
  return map;
}
function jsonl(path) {
  const source = readFileSync(path, 'utf8').trim();
  return source ? source.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}
function safeRoot(root, knowledge) {
  if (!existsSync(root) || !statSync(root).isDirectory()
    || (statSync(root).mode & 0o777) !== 0o700
    || isPathInside(knowledge, realpathSync(root))) throw new Error('unsafe root');
  for (const name of ['study.json', 'receipts.jsonl', 'review-packets.jsonl', 'judgments-sonnet5.jsonl', 'judge-raw-sonnet5.jsonl']) {
    const path = join(root, name);
    if (!existsSync(path) || !statSync(path).isFile() || (statSync(path).mode & 0o777) !== 0o600) {
      throw new Error('unsafe artifact');
    }
  }
}
function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function stringArray(value) { return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0); }
function round(value) { return Math.round(value * 1_000_000) / 1_000_000; }
function exclusive(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}
