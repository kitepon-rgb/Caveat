#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import {
  isPathInside,
  parseProposalJudgmentsJsonl,
  parseProposalReviewPacketsJsonl,
} from '../packages/core/dist/proposalEval.js';

const PRICING = {
  'gpt-5.4-mini': { input: 18.75, cached: 1.875, output: 113 },
  'gpt-5.6-luna': { input: 25, cached: 2.5, output: 150 },
  'gpt-5.6-terra': { input: 62.5, cached: 6.25, output: 375 },
};
const MODELS = Object.keys(PRICING);
const SURFACES = ['stop', 'tool_error'];

try {
  main();
} catch (error) {
  process.stderr.write(`[caveat:eval-sidecar-advisory] ${error instanceof Error ? error.message : 'unexpected failure'}\n`);
  process.exitCode = 1;
}

function main() {
  const home = realpathSync(process.env.HOME || homedir());
  const caveatHome = findCaveatHome(home);
  const knowledgeRepo = realpathSync(resolvePaths(
    caveatHome,
    loadConfig(join(home, '.caveatrc.json')).knowledgeRepo,
    home,
  ).knowledgeRepo);
  const baseRoot = join(caveatHome, 'local-eval', 'sidecar-advisory');
  const repairRoot = join(baseRoot, 'context-schema-fix');
  const repeatRoot = join(baseRoot, 'adoption-repeat');
  const outputPath = join(baseRoot, 'evaluation-adoption-final.json');
  if (existsSync(outputPath)) throw new Error('evaluation output already exists');
  for (const root of [baseRoot, repairRoot, repeatRoot]) validateRoot(root, knowledgeRepo);

  const base = loadBatch(baseRoot);
  const repair = loadBatch(repairRoot);
  const repeat = loadBatch(repeatRoot);
  const invalidInitial = base.study.runs.filter((run) => run.context.length > 0);
  if (invalidInitial.length !== 6
    || invalidInitial.some((run) => base.receiptByRun.get(run.runId)?.status !== 'noncompleted'
      || base.receiptByRun.get(run.runId)?.usageStatus !== 'unavailable')) {
    throw new Error('initial provider-not-reached exclusion set is invalid');
  }
  if (repair.study.runs.length !== 6 || repair.study.runs.some((run) => run.context.length === 0)) {
    throw new Error('repair batch is not the balanced context replacement');
  }

  const originalContextKeys = new Set(invalidInitial.map(scenarioModelKey));
  if (repair.study.runs.some((run) => !originalContextKeys.has(scenarioModelKey(run)))) {
    throw new Error('repair batch does not replace the invalid context cells');
  }
  for (const repaired of repair.study.runs) {
    const original = invalidInitial.find((run) => scenarioModelKey(run) === scenarioModelKey(repaired));
    if (!original
      || repaired.prompt !== original.prompt
      || JSON.stringify(repaired.knownBadClaims) !== JSON.stringify(original.knownBadClaims)
      || JSON.stringify(repaired.validSolutionRubric) !== JSON.stringify(original.validSolutionRubric)) {
      throw new Error('repair changed a judged scenario contract');
    }
  }
  if (repeat.study.runs.length !== 8
    || repeat.study.runs.some((run) => run.replicate !== 1 || !['gpt-5.4-mini', 'gpt-5.6-luna'].includes(run.model))) {
    throw new Error('adoption repeat is not the balanced mini/Luna replicate');
  }
  for (const repeated of repeat.study.runs) {
    const original = base.study.runs.find((run) => scenarioModelKey(run) === scenarioModelKey(repeated));
    if (!original
      || repeated.prompt !== original.prompt
      || JSON.stringify(repeated.knownBadClaims) !== JSON.stringify(original.knownBadClaims)
      || JSON.stringify(repeated.validSolutionRubric) !== JSON.stringify(original.validSolutionRubric)) {
      throw new Error('adoption repeat changed a judged scenario contract');
    }
  }

  const canonical = [
    ...base.study.runs.filter((run) => run.context.length === 0).map((run) => ({ batch: base, run })),
    ...repair.study.runs.map((run) => ({ batch: repair, run })),
    ...repeat.study.runs.map((run) => ({ batch: repeat, run })),
  ];
  if (canonical.length !== 20) throw new Error('canonical denominator is not 20');
  const metrics = Object.fromEntries(MODELS.map((model) => [model, blankModel()]));

  for (const { batch, run } of canonical) {
    const receipt = batch.receiptByRun.get(run.runId);
    if (!receipt
      || receipt.judgmentId !== run.judgmentId
      || receipt.scenarioId !== run.scenarioId
      || receipt.surface !== run.surface
      || receipt.requestedModel !== run.model) throw new Error('receipt/run join mismatch');
    const model = metrics[run.model];
    const surface = model.surfaces[run.surface];
    for (const bucket of [model, surface]) {
      bucket.denominator += 1;
      bucket.statuses[receipt.status] += 1;
      bucket.totalLatencyMs.push(receipt.totalLatencyMs);
    }
    if (receipt.usageStatus === 'available') {
      for (const bucket of [model, surface]) {
        bucket.usageAvailable += 1;
        addUsage(bucket.usage, receipt.usage);
      }
    }

    const packet = batch.packetByJudgment.get(run.judgmentId);
    const judgment = batch.judgmentById.get(run.judgmentId);
    if (receipt.status === 'completed') {
      if (!packet || !judgment || judgment.packetDigest !== packet.packetDigest
        || judgment.maskedReviewAttested !== true
        || !judgment.judge.endsWith(':claude-sonnet-5')) {
        throw new Error('completed run has no valid masked Sonnet 5 judgment');
      }
      for (const bucket of [model, surface]) {
        bucket.knownBad[judgment.knownBadClaimEmitted] += 1;
        bucket.validSolution[judgment.validSolutionSupplied] += 1;
      }
    } else {
      if (packet || judgment) throw new Error('noncompleted run entered review');
      for (const bucket of [model, surface]) {
        bucket.knownBad.unclear += 1;
        bucket.validSolution.unclear += 1;
      }
    }
  }

  for (const [model, value] of Object.entries(metrics)) finalize(value, PRICING[model]);
  const lunaQualified = qualifies(metrics['gpt-5.6-luna'], metrics['gpt-5.4-mini']);
  const terraFeasibilityQualified = feasibilityQualifies(metrics['gpt-5.6-terra']);
  const selectedModel = lunaQualified
    ? 'gpt-5.6-luna'
    : null;
  const data = {
    schemaVersion: 'sidecar-advisory-evaluation/v2',
    scope: 'synthetic-public-explicit-context-feasibility-only',
    canonicalRunCount: canonical.length,
    excludedInfrastructureRuns: invalidInitial.length,
    exclusionReason: 'codex-sidecar rejected malformed context before provider invocation; every invalid cell was replaced by the balanced context-schema-fix batch',
    judge: 'claude-sonnet-5',
    pricingUnit: 'Codex credits per 1M tokens',
    metrics,
    decision: {
      selectedModel,
      reasoningEffort: selectedModel ? 'low' : null,
      lunaAdoptionQualified: lunaQualified,
      terraFeasibilityQualified,
      terraAdoptionEvaluated: false,
      solEvaluated: false,
      productionChangeAuthorized: false,
      requiredNextGate: 'privacy-approved actual hook input contract plus separate Stop/tool_error characterization',
    },
  };
  const output = { ...data, digest: sha(JSON.stringify(data)) };
  writeExclusive(outputPath, Buffer.from(`${JSON.stringify(output, null, 2)}\n`));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: output.schemaVersion,
    canonicalRunCount: output.canonicalRunCount,
    excludedInfrastructureRuns: output.excludedInfrastructureRuns,
    selectedModel: output.decision.selectedModel,
    productionChangeAuthorized: output.decision.productionChangeAuthorized,
    digest: output.digest,
  })}\n`);
}

function loadBatch(root) {
  const study = JSON.parse(readFileSync(join(root, 'study.json'), 'utf8'));
  const receipts = jsonl(join(root, 'receipts.jsonl'));
  const packets = parseProposalReviewPacketsJsonl(readFileSync(join(root, 'review-packets.jsonl'), 'utf8'));
  const judgments = parseProposalJudgmentsJsonl(readFileSync(join(root, 'judgments-sonnet5.jsonl'), 'utf8'));
  const receiptByRun = new Map();
  for (const receipt of receipts) {
    const { digest, ...data } = receipt;
    if (receiptByRun.has(receipt.runId) || digest !== sha(JSON.stringify(data))) throw new Error('receipt digest is invalid');
    receiptByRun.set(receipt.runId, receipt);
  }
  if (receiptByRun.size !== study.runs.length) throw new Error('batch receipt count mismatch');
  return {
    study,
    receiptByRun,
    packetByJudgment: new Map(packets.map((packet) => [packet.judgmentId, packet])),
    judgmentById: new Map(judgments.map((judgment) => [judgment.judgmentId, judgment])),
  };
}

function blankCounts() { return { yes: 0, no: 0, unclear: 0 }; }
function blankUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }; }
function blankBucket() { return { denominator: 0, statuses: { completed: 0, noncompleted: 0 }, knownBad: blankCounts(), validSolution: blankCounts(), usageAvailable: 0, usage: blankUsage(), totalLatencyMs: [] }; }
function blankModel() { return { ...blankBucket(), surfaces: { stop: blankBucket(), tool_error: blankBucket() } }; }
function addUsage(target, source) { for (const key of Object.keys(target)) target[key] += source[key] ?? 0; }

function finalize(bucket, pricing) {
  const latencies = [...bucket.totalLatencyMs].sort((a, b) => a - b);
  bucket.meanLatencyMs = Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
  bucket.p95LatencyMs = latencies[Math.ceil(latencies.length * 0.95) - 1];
  delete bucket.totalLatencyMs;
  const noncached = bucket.usage.inputTokens - bucket.usage.cachedInputTokens;
  bucket.estimatedCredits = round6((
    noncached * pricing.input
    + bucket.usage.cachedInputTokens * pricing.cached
    + bucket.usage.outputTokens * pricing.output
  ) / 1_000_000);
  bucket.estimatedCreditsPerRun = round6(bucket.estimatedCredits / bucket.denominator);
  if (bucket.surfaces) for (const surface of SURFACES) finalize(bucket.surfaces[surface], pricing);
}

function qualifies(candidate, baseline) {
  return candidate.statuses.completed === candidate.denominator
    && candidate.knownBad.yes === 0
    && SURFACES.every((surface) => {
      const value = candidate.surfaces[surface];
      const base = baseline.surfaces[surface];
      return value.statuses.completed === value.denominator
        && value.knownBad.yes === 0
        && value.validSolution.yes >= base.validSolution.yes;
    });
}

function feasibilityQualifies(candidate) {
  return candidate.statuses.completed === candidate.denominator
    && candidate.knownBad.yes === 0
    && candidate.validSolution.yes === candidate.denominator;
}

function validateRoot(root, knowledgeRepo) {
  if (!existsSync(root)
    || !statSync(root).isDirectory()
    || (statSync(root).mode & 0o777) !== 0o700
    || isPathInside(knowledgeRepo, realpathSync(root))) throw new Error('local evaluation root is unsafe');
  for (const name of ['study.json', 'receipts.jsonl', 'review-packets.jsonl', 'judgments-sonnet5.jsonl']) {
    const path = join(root, name);
    if (!existsSync(path) || !statSync(path).isFile() || (statSync(path).mode & 0o777) !== 0o600) throw new Error('local artifact is unsafe');
  }
}

function scenarioModelKey(run) { return `${run.scenarioId}\0${run.surface}\0${run.model}`; }
function jsonl(path) { const text = readFileSync(path, 'utf8').trim(); return text ? text.split(/\r?\n/).map(JSON.parse) : []; }
function round6(value) { return Math.round(value * 1_000_000) / 1_000_000; }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function writeExclusive(path, bytes) { const descriptor = openSync(path, 'wx', 0o600); try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); } }
