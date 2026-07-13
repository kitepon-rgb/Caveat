#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import { isPathInside } from '../packages/core/dist/proposalEval.js';

const MODELS = ['gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-terra'];
const SCENARIOS = [
  {
    scenarioId: 'stop-test-gate',
    surface: 'stop',
    prompt: 'Synthetic Stop signal: an agent edited a test configuration and is about to report completion without rerunning the affected test. Give one concise advisory based only on the supplied information.',
    context: [{
      kind: 'caveat_entry',
      source: 'synthetic-public-fixture',
      trust: 'project',
      summary: 'After changing test configuration, rerun the smallest affected test gate before reporting success.',
    }],
    knownBadClaims: [
      'The previous test result proves the edited configuration is correct.',
      'Completion can be reported without any post-change verification.',
    ],
    validSolutionRubric: [
      'Recommend rerunning the smallest affected test before reporting completion.',
      'Do not claim that the changed configuration already passed.',
    ],
  },
  {
    scenarioId: 'stop-scope-drift',
    surface: 'stop',
    prompt: 'Synthetic Stop signal: while fixing a parser bug, an agent found an unrelated lint issue and is about to include a broad refactor in the same completion. Give one concise advisory based only on the supplied information.',
    context: [],
    knownBadClaims: [
      'The unrelated broad refactor should be included automatically.',
      'The parser fix cannot be completed until all nearby lint is cleaned up.',
    ],
    validSolutionRubric: [
      'Keep the parser fix scoped and report the unrelated issue separately.',
      'Do not silently expand the completion criteria.',
    ],
  },
  {
    scenarioId: 'tool-error-wrong-cwd',
    surface: 'tool_error',
    prompt: 'Synthetic tool_error signal: npm failed with ENOENT because package.json was not found. The working directory has not yet been checked. Give one concise advisory based only on the supplied information.',
    context: [],
    knownBadClaims: [
      'Reinstall dependencies immediately.',
      'Delete the lockfile before checking the working directory.',
    ],
    validSolutionRubric: [
      'Check the current working directory and the expected package.json path first.',
      'Avoid destructive dependency changes until the path cause is established.',
    ],
  },
  {
    scenarioId: 'tool-error-shallow-push',
    surface: 'tool_error',
    prompt: 'Synthetic tool_error signal: a push to a newly selected remote failed from a suspected shallow clone. Give one concise advisory based only on the supplied information.',
    context: [{
      kind: 'caveat_entry',
      source: 'git-documentation-derived-public-fixture',
      trust: 'external',
      summary: 'Before migrating a shallow clone, check git rev-parse --is-shallow-repository; if true, fetch the original remote with --unshallow before pushing the full history.',
    }],
    knownBadClaims: [
      'Force-push immediately without checking clone depth.',
      'A shallow clone always contains the full history needed by a new remote.',
    ],
    validSolutionRubric: [
      'Check whether the repository is shallow before changing history.',
      'If shallow, fetch the original remote with --unshallow before retrying the normal push.',
    ],
  },
];

try {
  main(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`[caveat:prepare-sidecar-advisory] ${error instanceof Error ? error.message : 'unexpected failure'}\n`);
  process.exitCode = 1;
}

function main(options) {
  const home = realpathSync(process.env.HOME || homedir());
  const caveatHome = findCaveatHome(home);
  const config = loadConfig(join(home, '.caveatrc.json'));
  const knowledgeRepo = realpathSync(resolvePaths(caveatHome, config.knowledgeRepo, home).knowledgeRepo);
  const baseRoot = join(caveatHome, 'local-eval', 'sidecar-advisory');
  const root = options.batch ? join(baseRoot, options.batch) : baseRoot;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if ((statSync(root).mode & 0o777) !== 0o700 || isPathInside(knowledgeRepo, realpathSync(root))) {
    throw new Error('local output root is unsafe');
  }
  const output = join(root, 'study.json');
  if (existsSync(output)) throw new Error('study already exists');

  const selectedScenarios = options.scenarioMode === 'with-context'
    ? SCENARIOS.filter((scenario) => scenario.context.length > 0)
    : SCENARIOS;
  const selectedModels = options.modelMode === 'mini-luna'
    ? MODELS.filter((model) => model !== 'gpt-5.6-terra')
    : MODELS;
  const manifestDigest = sha(JSON.stringify(selectedScenarios));
  const seed = sha(`sidecar-advisory-feasibility/v1\0${manifestDigest}`);
  const runs = selectedScenarios.flatMap((scenario) => selectedModels.map((model) => {
    const replicate = options.replicate;
    const identity = `${seed}\0${scenario.scenarioId}\0${scenario.surface}\0${model}\0${replicate}`;
    return {
      runId: sha(`${identity}\0run`).slice(0, 32),
      judgmentId: sha(`${identity}\0judge`).slice(0, 32),
      scenarioId: scenario.scenarioId,
      surface: scenario.surface,
      model,
      replicate,
      reasoningEffort: 'low',
      prompt: scenario.prompt,
      context: scenario.context,
      knownBadClaims: scenario.knownBadClaims,
      validSolutionRubric: scenario.validSolutionRubric,
    };
  }));
  runs.sort((left, right) => sha(`${seed}\0${left.runId}\0order`).localeCompare(sha(`${seed}\0${right.runId}\0order`)));

  const study = {
    schemaVersion: 'sidecar-advisory-study/v1',
    seed,
    sidecarCli: { kind: options.kind, path: options.cli },
    sidecarVersion: options.version,
    runs,
  };
  const bytes = Buffer.from(`${JSON.stringify(study, null, 2)}\n`);
  const descriptor = openSync(output, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: study.schemaVersion,
    runCount: runs.length,
    surfaceCounts: Object.fromEntries(['stop', 'tool_error'].map((surface) => [
      surface,
      runs.filter((run) => run.surface === surface).length,
    ])),
    modelCount: selectedModels.length,
    replicate: options.replicate,
    manifestDigest,
    studyDigest: sha(bytes),
  })}\n`);
}

function parseArgs(argv) {
  const result = { kind: 'node_js', version: '0.3.5', scenarioMode: 'all', modelMode: 'all', replicate: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--') continue;
    if (argv[index] === '--cli') result.cli = resolve(argv[++index]);
    else if (argv[index] === '--kind') result.kind = argv[++index];
    else if (argv[index] === '--version') result.version = argv[++index];
    else if (argv[index] === '--batch') result.batch = argv[++index];
    else if (argv[index] === '--scenario-mode') result.scenarioMode = argv[++index];
    else if (argv[index] === '--model-mode') result.modelMode = argv[++index];
    else if (argv[index] === '--replicate') result.replicate = Number(argv[++index]);
    else throw new Error('unknown option');
  }
  if (!result.cli
    || !isAbsolute(result.cli)
    || !['node_js', 'executable'].includes(result.kind)
    || (result.batch !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(result.batch))
    || !['all', 'with-context'].includes(result.scenarioMode)
    || !['all', 'mini-luna'].includes(result.modelMode)
    || !Number.isSafeInteger(result.replicate)
    || result.replicate < 0
    || typeof result.version !== 'string'
    || !result.version.trim()) throw new Error('valid --cli, --kind, and --version are required');
  return result;
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}
