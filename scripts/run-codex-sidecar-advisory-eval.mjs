#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import { isPathInside } from '../packages/core/dist/proposalEval.js';

const STUDY_SCHEMA = 'sidecar-advisory-study/v1';
const RECEIPT_SCHEMA = 'sidecar-advisory-receipt/v1';
const ALLOWED_MODELS = new Set(['gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-terra']);
const BLOCKED_ENV = [
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
];

class PreconditionError extends Error {
  constructor(message) {
    super(`sidecar advisory evaluation precondition failed; ${message}`);
  }
}

try {
  main(parseArgs(process.argv.slice(2)));
} catch (error) {
  const message = error instanceof PreconditionError
    ? error.message
    : 'unexpected runtime failure; no private artifact data was printed';
  process.stderr.write(`[caveat:sidecar-advisory-eval] ${message}\n`);
  process.exitCode = 1;
}

function main(options) {
  const home = realpathSync(process.env.HOME || homedir());
  const caveatHome = findCaveatHome(home);
  const config = loadConfig(join(home, '.caveatrc.json'));
  const knowledgeRepo = resolvePaths(caveatHome, config.knowledgeRepo, home).knowledgeRepo;
  const baseRoot = join(caveatHome, 'local-eval', 'sidecar-advisory');
  const outputRoot = options.batch ? join(baseRoot, options.batch) : baseRoot;
  const sourcePath = options.source
    ? resolve(process.cwd(), options.source)
    : join(outputRoot, 'study.json');

  rejectRoutingEnvironment();
  validateLocalArtifact(sourcePath, knowledgeRepo, true);
  validateLocalArtifact(outputRoot, knowledgeRepo, false);

  const receiptsPath = join(outputRoot, 'receipts.jsonl');
  const packetsPath = join(outputRoot, 'review-packets.jsonl');
  const workRoot = join(outputRoot, 'work');
  if (existsSync(receiptsPath) || existsSync(packetsPath) || existsSync(workRoot)) {
    throw new PreconditionError('existing output or crash marker');
  }

  const study = parseStudy(JSON.parse(readFileSync(sourcePath, 'utf8')));
  validateCli(study.sidecarCli, knowledgeRepo);
  const command = study.sidecarCli.kind === 'node_js' ? process.execPath : study.sidecarCli.path;
  const prefix = study.sidecarCli.kind === 'node_js' ? [study.sidecarCli.path] : [];
  const baseEnv = {
    HOME: home,
    CODEX_HOME: process.env.CODEX_HOME || join(home, '.codex'),
    PATH: process.env.PATH || '',
    TMPDIR: outputRoot,
    LANG: 'C.UTF-8',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || '',
  };

  const version = spawnSync(command, [...prefix, '--version'], { env: baseEnv, encoding: 'utf8' });
  if (version.status !== 0 || String(version.stdout).trim() !== study.sidecarVersion) {
    throw new PreconditionError('sidecar version mismatch');
  }

  mkdirSync(workRoot, { mode: 0o700 });
  const receipts = [];
  const packets = [];
  const written = [];
  try {
    for (const run of study.runs) {
      const workRootReal = realpathSync(workRoot);
      const work = join(workRoot, sha256(run.runId));
      mkdirSync(work, { mode: 0o700 });
      const git = spawnSync('git', ['init', '--quiet'], { cwd: work, env: baseEnv, encoding: 'utf8' });
      if (git.status !== 0) throw new PreconditionError('isolated git initialization failed');

      writeFileSync(join(work, '.codex-sidecar.yml'), sidecarConfig(), { mode: 0o600 });
      const contextPath = join(work, 'context.json');
      writeFileSync(contextPath, JSON.stringify({ context: run.context }), { mode: 0o600 });

      const started = performance.now();
      const child = spawnSync(
        command,
        [
          ...prefix,
          'explore',
          '--project', work,
          '--preset', 'advisory',
          '--model', run.model,
          '--model-reasoning-effort', 'low',
          '--context-file', contextPath,
          run.prompt,
        ],
        { env: { ...baseEnv, TMPDIR: work }, timeout: options.timeout, encoding: 'utf8' },
      );
      const totalLatencyMs = Math.round(performance.now() - started);
      writeFileSync(join(work, 'stdout.bin'), child.stdout || '', { mode: 0o600 });
      writeFileSync(join(work, 'stderr.bin'), child.stderr || '', { mode: 0o600 });

      let result = null;
      try {
        result = JSON.parse(child.stdout);
      } catch {}

      const rawPath = resolveRawLog(result?.rawEventLogRef, workRootReal, work);
      const rawBytes = rawPath ? readFileSync(rawPath) : null;
      const provenance = rawBytes ? parseRawLog(rawBytes, run) : null;
      const completed = child.status === 0
        && result?.status === 'ok'
        && result.workflow === 'explore'
        && typeof result.summary === 'string'
        && typeof result.recommendedNextAction === 'string'
        && result.modelPolicy?.source === 'explicit'
        && result.modelPolicy?.model === run.model
        && result.modelPolicy?.modelReasoningEffort === 'low'
        && result.normalizedRequest?.model === run.model
        && result.normalizedRequest?.modelReasoningEffort === 'low'
        && rawBytes !== null
        && provenance?.startupValid === true;

      const receiptData = {
        schemaVersion: RECEIPT_SCHEMA,
        runId: run.runId,
        judgmentId: run.judgmentId,
        scenarioId: run.scenarioId,
        surface: run.surface,
        requestedModel: run.model,
        reasoningEffort: 'low',
        modelProvenance: provenance?.startupValid
          ? 'requested_and_process_args'
          : 'requested_only',
        reportedModel: null,
        status: completed ? 'completed' : 'noncompleted',
        usageStatus: provenance?.usage ? 'available' : 'unavailable',
        usage: provenance?.usage ?? null,
        totalLatencyMs,
        modelTurnLatencyMs: provenance?.modelTurnLatencyMs ?? null,
        resultDigest: result ? sha256(Buffer.from(JSON.stringify(result))) : null,
        rawEventLogDigest: rawBytes ? sha256(rawBytes) : null,
      };
      receipts.push({ ...receiptData, digest: sha256(Buffer.from(JSON.stringify(receiptData))) });

      if (completed) {
        const packetData = {
          judgmentId: run.judgmentId,
          scenario: run.prompt,
          evidence: run.context.map((block, index) => ({
            reference: `context-${index}`,
            content: JSON.stringify(block),
            digest: sha256(Buffer.from(JSON.stringify(block))),
          })),
          knownBadClaims: run.knownBadClaims,
          validSolutionRubric: run.validSolutionRubric,
          output: `${result.summary}\n${result.recommendedNextAction}`,
        };
        packets.push({
          ...packetData,
          packetDigest: sha256(Buffer.from(JSON.stringify(packetData))),
        });
      }
    }

    validateOutputs(study, receipts, packets);
    writeExclusive(receiptsPath, Buffer.from(`${receipts.map(JSON.stringify).join('\n')}\n`));
    written.push(receiptsPath);
    writeExclusive(
      packetsPath,
      Buffer.from(`${packets.map(JSON.stringify).join('\n')}${packets.length ? '\n' : ''}`),
    );
    written.push(packetsPath);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'sidecar-advisory-eval/v1',
      runCount: receipts.length,
      receiptDigest: sha256(readFileSync(receiptsPath)),
      packetDigest: sha256(readFileSync(packetsPath)),
    })}\n`);
  } catch (error) {
    for (const path of written) rmSync(path, { force: true });
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const result = { timeout: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--') continue;
    if (argv[index] === '--source') result.source = argv[++index];
    else if (argv[index] === '--batch') {
      result.batch = argv[++index];
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(result.batch || '')) {
        throw new PreconditionError('batch name is invalid');
      }
    }
    else if (argv[index] === '--timeout-ms') {
      result.timeout = Number(argv[++index]);
      if (!Number.isInteger(result.timeout) || result.timeout < 1 || result.timeout > 3_600_000) {
        throw new PreconditionError('timeout is invalid');
      }
    } else throw new PreconditionError('unknown option');
  }
  return result;
}

function parseStudy(value) {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['schemaVersion', 'seed', 'sidecarCli', 'sidecarVersion', 'runs'])
    || value.schemaVersion !== STUDY_SCHEMA
    || !/^[0-9a-f]{64}$/.test(value.seed)
    || !Array.isArray(value.runs)
    || value.runs.length === 0) {
    throw new PreconditionError('study schema is invalid');
  }

  const cli = value.sidecarCli;
  if (!isPlainObject(cli)
    || !hasExactKeys(cli, ['kind', 'path'])
    || !['executable', 'node_js'].includes(cli.kind)
    || !isAbsolute(cli.path)
    || typeof value.sidecarVersion !== 'string'
    || !value.sidecarVersion.trim()) {
    throw new PreconditionError('sidecar CLI is invalid');
  }

  const seen = new Set();
  const counts = new Map();
  const scenarioSurfaces = new Set();
  const studyModels = new Set();
  for (const run of value.runs) {
    const keys = [
      'runId', 'judgmentId', 'scenarioId', 'surface', 'model', 'replicate', 'reasoningEffort',
      'prompt', 'context', 'knownBadClaims', 'validSolutionRubric',
    ];
    if (!isPlainObject(run)
      || !hasExactKeys(run, keys)
      || !/^[0-9a-f]{32}$/.test(run.runId)
      || !/^[0-9a-f]{32}$/.test(run.judgmentId)
      || typeof run.scenarioId !== 'string'
      || !run.scenarioId.trim()
      || !['stop', 'tool_error'].includes(run.surface)
      || !ALLOWED_MODELS.has(run.model)
      || !Number.isSafeInteger(run.replicate)
      || run.replicate < 0
      || run.reasoningEffort !== 'low'
      || typeof run.prompt !== 'string'
      || !run.prompt.trim()
      || !Array.isArray(run.context)
      || !run.context.every(validContextBlock)
      || !nonemptyStrings(run.knownBadClaims)
      || run.knownBadClaims.length === 0
      || !nonemptyStrings(run.validSolutionRubric)
      || run.validSolutionRubric.length === 0
      || seen.has(run.runId)
      || seen.has(run.judgmentId)) {
      throw new PreconditionError('run schema is invalid');
    }
    const identity = `${value.seed}\0${run.scenarioId}\0${run.surface}\0${run.model}\0${run.replicate}`;
    if (run.runId !== sha256(Buffer.from(`${identity}\0run`)).slice(0, 32)
      || run.judgmentId !== sha256(Buffer.from(`${identity}\0judge`)).slice(0, 32)) {
      throw new PreconditionError('run identity is not seed-derived');
    }
    seen.add(run.runId);
    seen.add(run.judgmentId);
    const scenarioSurface = `${run.scenarioId}\0${run.surface}`;
    scenarioSurfaces.add(scenarioSurface);
    studyModels.add(run.model);
    const key = `${scenarioSurface}\0${run.model}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const scenarioSurface of scenarioSurfaces) {
    const modelCounts = [...studyModels].map((model) => counts.get(`${scenarioSurface}\0${model}`) ?? 0);
    if (modelCounts.includes(0) || new Set(modelCounts).size !== 1) {
      throw new PreconditionError('scenario/surface/model run counts are unbalanced');
    }
  }
  const expectedOrder = [...value.runs].sort((left, right) => {
    const leftKey = sha256(Buffer.from(`${value.seed}\0${left.runId}\0order`));
    const rightKey = sha256(Buffer.from(`${value.seed}\0${right.runId}\0order`));
    return leftKey.localeCompare(rightKey);
  });
  if (expectedOrder.some((run, index) => run.runId !== value.runs[index].runId)) {
    throw new PreconditionError('run order is not seed-derived');
  }
  return value;
}

function rejectRoutingEnvironment() {
  for (const name of BLOCKED_ENV) {
    if (process.env[name] !== undefined || process.env[name.toLowerCase()] !== undefined) {
      throw new PreconditionError('routing-affecting environment is set');
    }
  }
}

function validateCli(cli, knowledgeRepo) {
  if (!existsSync(cli.path) || !statSync(cli.path).isFile()) {
    throw new PreconditionError('sidecar CLI path is invalid');
  }
  const real = realpathSync(cli.path);
  if (isPathInside(realpathSync(knowledgeRepo), real)) {
    throw new PreconditionError('sidecar CLI path is unsafe');
  }
  if (cli.kind === 'executable' && (statSync(real).mode & 0o111) === 0) {
    throw new PreconditionError('sidecar CLI is not executable');
  }
}

function validateLocalArtifact(path, knowledgeRepo, file) {
  if (!existsSync(path)
    || (file && !statSync(path).isFile())
    || (!file && !statSync(path).isDirectory())
    || (statSync(file ? dirname(path) : path).mode & 0o777) !== 0o700
    || isPathInside(realpathSync(knowledgeRepo), realpathSync(path))) {
    throw new PreconditionError('local artifact is unsafe');
  }
}

function resolveRawLog(reference, workRootReal, work) {
  if (typeof reference !== 'string' || !isAbsolute(reference) || !existsSync(reference)) return null;
  const stat = statSync(reference);
  if (!stat.isFile()) return null;
  const real = realpathSync(reference);
  return isPathInside(workRootReal, real) && isPathInside(realpathSync(work), real) ? real : null;
}

function parseRawLog(raw, run) {
  try {
    let runStartCount = 0;
    let processStartCount = 0;
    let threadId;
    let turnId;
    let lastTotal;
    let lastContextWindow;
    let usageInvalid = false;
    let turnStartedAt;
    let turnCompletedAt;
    for (const line of raw.toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      const event = JSON.parse(line);
      const data = event?.data;
      if (event.event === 'run/start') {
        runStartCount += 1;
        if (data?.model !== run.model
          || data?.modelReasoningEffort !== 'low'
          || data?.modelPolicySource !== 'explicit') return null;
      }
      if (event.event === 'process/start') {
        processStartCount += 1;
        if (!validProcessArgs(data?.args, run.model)) return null;
      }
      if (data?.method === 'turn/start'
        && event.event === 'request/send'
        && event.direction === 'outbound') turnStartedAt = Date.parse(event.timestamp);
      if (data?.method === 'turn/completed'
        && event.event === 'notification/retained'
        && event.direction === 'inbound') turnCompletedAt = Date.parse(event.timestamp);
      if (data?.method !== 'thread/tokenUsage/updated') continue;

      const parsed = parseUsageEvent(event);
      if (!parsed) {
        usageInvalid = true;
        continue;
      }
      if ((threadId !== undefined && (threadId !== parsed.threadId || turnId !== parsed.turnId))
        || (lastTotal && Object.keys(lastTotal).some((key) => parsed.total[key] < lastTotal[key]))) {
        usageInvalid = true;
        continue;
      }
      threadId = parsed.threadId;
      turnId = parsed.turnId;
      lastTotal = parsed.total;
      lastContextWindow = parsed.modelContextWindow;
    }
    return {
      startupValid: runStartCount === 1 && processStartCount === 1,
      usage: !usageInvalid && lastTotal
        ? { ...lastTotal, modelContextWindow: lastContextWindow }
        : null,
      modelTurnLatencyMs: latency(turnStartedAt, turnCompletedAt),
    };
  } catch {
    return null;
  }
}

function validProcessArgs(args, model) {
  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) return false;
  const pairs = new Set();
  for (let index = 0; index + 1 < args.length; index += 1) {
    if (args[index] === '-c') pairs.add(args[index + 1]);
  }
  return pairs.has(`model=${JSON.stringify(model)}`)
    && pairs.has(`model_reasoning_effort=${JSON.stringify('low')}`);
}

function parseUsageEvent(event) {
  const data = event?.data;
  if (!hasExactKeys(event, ['timestamp', 'category', 'event', 'direction', 'data'])
    || event.category !== 'protocol'
    || event.event !== 'notification/retained'
    || event.direction !== 'inbound'
    || !isPlainObject(data)
    || !hasExactKeys(data, ['kind', 'method', 'params'])
    || data.kind !== 'notification'
    || !isPlainObject(data.params)
    || !hasExactKeys(data.params, ['threadId', 'turnId', 'tokenUsage'])
    || typeof data.params.threadId !== 'string'
    || typeof data.params.turnId !== 'string') return null;
  const usage = data.params.tokenUsage;
  if (!isPlainObject(usage)
    || !hasExactKeys(usage, ['total', 'last', 'modelContextWindow'])
    || !Number.isSafeInteger(usage.modelContextWindow)
    || usage.modelContextWindow < 1
    || !validTokenCounts(usage.total)
    || !validTokenCounts(usage.last)) return null;
  return {
    threadId: data.params.threadId,
    turnId: data.params.turnId,
    total: usage.total,
    modelContextWindow: usage.modelContextWindow,
  };
}

function validTokenCounts(value) {
  const keys = [
    'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens',
  ];
  return isPlainObject(value)
    && hasExactKeys(value, keys)
    && Object.values(value).every((number) => Number.isSafeInteger(number) && number >= 0)
    && value.totalTokens === value.inputTokens + value.outputTokens
    && value.cachedInputTokens <= value.inputTokens;
}

function validateOutputs(study, receipts, packets) {
  if (receipts.length !== study.runs.length) throw new PreconditionError('receipt count mismatch');
  const runIds = new Set();
  const completedJudgments = new Set();
  for (const receipt of receipts) {
    const { digest, ...data } = receipt;
    if (runIds.has(receipt.runId)
      || digest !== sha256(Buffer.from(JSON.stringify(data)))) {
      throw new PreconditionError('receipt digest or identity mismatch');
    }
    runIds.add(receipt.runId);
    if (receipt.status === 'completed') completedJudgments.add(receipt.judgmentId);
  }
  const packetJudgments = new Set();
  for (const packet of packets) {
    const { packetDigest, ...data } = packet;
    if (packetJudgments.has(packet.judgmentId)
      || !completedJudgments.has(packet.judgmentId)
      || packetDigest !== sha256(Buffer.from(JSON.stringify(data)))) {
      throw new PreconditionError('review packet digest or identity mismatch');
    }
    packetJudgments.add(packet.judgmentId);
  }
  if (packetJudgments.size !== completedJudgments.size) {
    throw new PreconditionError('receipt or packet join mismatch');
  }
}

function sidecarConfig() {
  return `project: sidecar-advisory-eval
defaults:
  readonly: true
  result_format: json
deny_paths:
  - ".codex-sidecar/**"
presets:
  advisory:
    workflow: explore
    readonly: true
    prompt: "Return concise Caveat hook advisory with concrete next steps."
`;
}

function writeExclusive(path, bytes) {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function latency(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function validContextBlock(value) {
  const allowed = ['kind', 'source', 'trust', 'summary', 'references', 'data'];
  return isPlainObject(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && ['caveat_entry', 'manual_note'].includes(value.kind)
    && typeof value.source === 'string'
    && value.source.trim().length > 0
    && ['local', 'user-provided', 'project', 'external'].includes(value.trust)
    && typeof value.summary === 'string'
    && value.summary.trim().length > 0
    && (value.references === undefined
      || (Array.isArray(value.references) && value.references.every(validFileReference)))
    && (value.data === undefined || isJsonValue(value.data));
}

function validFileReference(value) {
  return isPlainObject(value)
    && Object.keys(value).every((key) => ['path', 'line', 'label'].includes(key))
    && typeof value.path === 'string'
    && value.path.trim().length > 0
    && (value.line === undefined || (Number.isSafeInteger(value.line) && value.line > 0))
    && (value.label === undefined || typeof value.label === 'string');
}

function isJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value)
    && Object.values(value).every(isJsonValue);
}

function nonemptyStrings(value) {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'string' && entry.trim() && !entry.includes('\0'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
