#!/usr/bin/env node

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const MODELS = ['gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.6-terra'];
const SECRET = 'SYNTHETIC_SIGNAL_DO_NOT_PRINT';

runSuccessfulCase();
runUsageUnavailableCase();
runStartupMismatchCase();
runUnbalancedCase();
process.stdout.write(`${JSON.stringify({ synthetic: true, cases: 4 })}\n`);

function runSuccessfulCase() {
  const fixture = makeFixture('valid');
  try {
    const result = run(fixture);
    assert(result.status === 0, `valid study failed: ${result.stderr}`);
    assert(!`${result.stdout}${result.stderr}`.includes(SECRET), 'private prompt leaked');
    const receipts = readJsonl(join(fixture.evalRoot, 'receipts.jsonl'));
    const packets = readJsonl(join(fixture.evalRoot, 'review-packets.jsonl'));
    assert(receipts.length === 6 && packets.length === 6, 'balanced outputs missing');
    assert(receipts.every((row) => row.status === 'completed'), 'completed status missing');
    assert(receipts.every((row) => row.usageStatus === 'available'), 'usage was not retained');
    assert(receipts.every((row) => row.usage.modelContextWindow === 200000), 'context window missing');
    assert(receipts.every((row) => row.modelProvenance === 'requested_and_process_args'), 'startup provenance missing');
  } finally {
    fixture.cleanup();
  }
}

function runUsageUnavailableCase() {
  const fixture = makeFixture('missing_usage', { oneSurface: true });
  try {
    const result = run(fixture);
    assert(result.status === 0, 'missing usage should not fail execution');
    const receipts = readJsonl(join(fixture.evalRoot, 'receipts.jsonl'));
    assert(receipts.every((row) => row.status === 'completed'), 'missing usage changed completion');
    assert(receipts.every((row) => row.usageStatus === 'unavailable' && row.usage === null), 'missing usage became zero');
  } finally {
    fixture.cleanup();
  }
}

function runStartupMismatchCase() {
  const fixture = makeFixture('bad_process_args', { oneSurface: true });
  try {
    const result = run(fixture);
    assert(result.status === 0, 'startup mismatch should produce noncompleted receipts');
    const receipts = readJsonl(join(fixture.evalRoot, 'receipts.jsonl'));
    const packets = readJsonl(join(fixture.evalRoot, 'review-packets.jsonl'));
    assert(receipts.every((row) => row.status === 'noncompleted'), 'startup mismatch was accepted');
    assert(packets.length === 0, 'noncompleted result entered masked review');
  } finally {
    fixture.cleanup();
  }
}

function runUnbalancedCase() {
  const fixture = makeFixture('valid', { unbalanced: true });
  try {
    const result = run(fixture);
    assert(result.status !== 0, 'unbalanced study was accepted');
    assert(result.stderr.includes('scenario/surface/model run counts are unbalanced'), 'wrong imbalance failure');
  } finally {
    fixture.cleanup();
  }
}

function makeFixture(mode, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sidecar-advisory-eval-'));
  const home = join(root, 'home');
  const caveatHome = join(root, 'caveat');
  const evalRoot = join(caveatHome, 'local-eval', 'sidecar-advisory');
  const knowledgeRepo = join(caveatHome, 'own');
  const cli = join(root, `fake-sidecar-${mode}.mjs`);
  for (const path of [home, evalRoot, knowledgeRepo]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(cli, fakeSidecar(mode), { mode: 0o700 });
  chmodSync(cli, 0o700);
  const study = studyFixture(cli, options);
  writeFileSync(join(evalRoot, 'study.json'), JSON.stringify(study), { mode: 0o600 });
  return {
    home,
    caveatHome,
    evalRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function studyFixture(cli, options) {
  const seed = 'a'.repeat(64);
  const surfaces = options.oneSurface ? ['stop'] : ['stop', 'tool_error'];
  const runs = [];
  for (const surface of surfaces) {
    for (const model of MODELS) {
      const scenarioId = `scenario-${surface}`;
      const replicate = 0;
      const identity = `${seed}\0${scenarioId}\0${surface}\0${model}\0${replicate}`;
      runs.push({
        runId: sha(`${identity}\0run`).slice(0, 32),
        judgmentId: sha(`${identity}\0judge`).slice(0, 32),
        scenarioId,
        surface,
        model,
        replicate,
        reasoningEffort: 'low',
        prompt: SECRET,
        context: [{
          kind: 'manual_note',
          source: 'synthetic-fixture',
          trust: 'user-provided',
          summary: 'The hook should recommend inspecting the failed command before retrying.',
        }],
        knownBadClaims: ['Retrying blindly is safe.'],
        validSolutionRubric: ['Inspect the failed command and its error before retrying.'],
      });
    }
  }
  if (options.unbalanced) runs.pop();
  runs.sort((left, right) => sha(`${seed}\0${left.runId}\0order`).localeCompare(sha(`${seed}\0${right.runId}\0order`)));
  return {
    schemaVersion: 'sidecar-advisory-study/v1',
    seed,
    sidecarCli: { kind: 'executable', path: cli },
    sidecarVersion: '0.3.5',
    runs,
  };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fakeSidecar(mode) {
  return `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('0.3.5\\n'); process.exit(0); }
const option = (name) => argv[argv.indexOf(name) + 1];
const project = option('--project');
const model = option('--model');
const logs = join(project, '.codex-sidecar', 'logs', 'app-server');
mkdirSync(logs, { recursive: true, mode: 0o700 });
const raw = join(logs, 'run.jsonl');
const processArgs = ${JSON.stringify(mode)} === 'bad_process_args'
  ? ['app-server', '-c', 'model="wrong"', '-c', 'model_reasoning_effort="low"']
  : ['app-server', '-c', 'model=' + JSON.stringify(model), '-c', 'model_reasoning_effort="low"'];
const events = [
  { timestamp: '2026-07-13T00:00:00.000Z', category: 'lifecycle', event: 'run/start', data: { model, modelReasoningEffort: 'low', modelPolicySource: 'explicit' } },
  { timestamp: '2026-07-13T00:00:00.010Z', category: 'lifecycle', event: 'process/start', data: { command: 'codex', args: processArgs } },
  { timestamp: '2026-07-13T00:00:01.000Z', category: 'protocol', event: 'request/send', direction: 'outbound', data: { kind: 'request', method: 'turn/start', params: {} } },
];
if (${JSON.stringify(mode)} !== 'missing_usage') events.push({
  timestamp: '2026-07-13T00:00:01.500Z', category: 'protocol', event: 'notification/retained', direction: 'inbound',
  data: { kind: 'notification', method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {
    total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 110 },
    last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 110 },
    modelContextWindow: 200000,
  } } },
});
events.push({ timestamp: '2026-07-13T00:00:02.000Z', category: 'protocol', event: 'notification/retained', direction: 'inbound', data: { kind: 'notification', method: 'turn/completed', params: {} } });
writeFileSync(raw, events.map(JSON.stringify).join('\\n') + '\\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({
  status: 'ok', workflow: 'explore', summary: 'Inspect the failed command.', recommendedNextAction: 'Read the exact error before retrying.',
  modelPolicy: { source: 'explicit', model, modelReasoningEffort: 'low' },
  normalizedRequest: { model, modelReasoningEffort: 'low' }, rawEventLogRef: raw,
}));
`;
}

function run(fixture) {
  const env = {
    HOME: fixture.home,
    CAVEAT_HOME: fixture.caveatHome,
    CODEX_HOME: join(fixture.home, '.codex'),
    PATH: process.env.PATH || '',
    USER: process.env.USER || '',
    LOGNAME: process.env.LOGNAME || '',
  };
  return spawnSync(process.execPath, ['scripts/run-codex-sidecar-advisory-eval.mjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
}

function readJsonl(path) {
  const text = readFileSync(path, 'utf8').trim();
  return text ? text.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
