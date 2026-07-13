#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const BASE = [
  {
    id: 'stop-candidate-selection', surface: 'stop',
    prompt: 'Synthetic Stop advisory: decide which supplied Caveat guidance is relevant, then give one concise next step.',
    context: [
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'If a session has repeated Bash commands, first isolate the repeated command and verify its assumptions.' },
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'If a session repeatedly edits a file, rerun the smallest affected test before reporting completion.' },
    ],
    knownBadClaims: ['Apply both caveats without selecting one.', 'Report completion without a targeted verification.'],
    rubric: ['Select the repeated-edit test gate when the structural signal indicates re-edited files.', 'Recommend the smallest affected test.'],
    signal: { kind: 'manual_note', source: 'caveat-hook-signal', trust: 'local', summary: 'Hook signal: 0 tool failures, 2 re-edited files, 0 web searches, 0 web fetches, 0 Bash retries, 8 elapsed minutes.', data: { type: 'stop', tool_failure_count: 0, reedited_file_count: 2, web_search_count: 0, web_fetch_count: 0, bash_retry_count: 0, duration_minutes: 8 } },
  },
  {
    id: 'tool-error-candidate-selection', surface: 'tool_error',
    prompt: 'Synthetic tool_error advisory: decide which supplied Caveat guidance is relevant, then give one concise next step.',
    context: [
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'For a Bash failure, inspect the command preconditions and the exact exit status before retrying.' },
      { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'For an Edit failure, verify the target file state before attempting another edit.' },
    ],
    knownBadClaims: ['Retry every candidate action blindly.', 'Treat the unknown raw error text as sidecar context.'],
    rubric: ['Select the Bash-specific guidance.', 'Recommend checking command preconditions before retrying.'],
    signal: { kind: 'manual_note', source: 'caveat-hook-signal', trust: 'local', summary: 'Hook signal: Bash tool error (post-tool-use-failure).', data: { type: 'tool-error', tool: 'bash', failure_kind: 'post-tool-use-failure' } },
  },
];
const modes = [
  'valid', 'unbalanced', 'tampered', 'pair-drift', 'judge-missing',
  'duplicate-receipt', 'signal-tamper', 'wrong-judge', 'symmetric-drift',
  'packet-reseal', 'mixed-judge', 'judge-raw-tamper',
];
for (const mode of modes) {
  const fixture = makeFixture(mode);
  try {
    const result = spawnSync(process.execPath, ['scripts/eval-hook-signal-advisory.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: fixture.home, CAVEAT_HOME: fixture.caveat },
      encoding: 'utf8',
    });
    if (mode === 'valid') {
      assert(result.status === 0, `valid fixture rejected: ${result.stderr}`);
      const evaluation = JSON.parse(readFileSync(join(fixture.evalRoot, 'evaluation.json'), 'utf8'));
      assert(evaluation.metrics.control.knownBad.no === 4, 'known-bad no was miscounted');
      assert(evaluation.metrics.control.valid.yes === 4, 'valid yes was miscounted');
      assert(evaluation.metrics.signal.knownBad.unclear === 0, 'valid completed runs became unclear');
    } else {
      assert(result.status !== 0, `${mode} accepted`);
    }
  } finally {
    fixture.clean();
  }
}
process.stdout.write(`${JSON.stringify({ synthetic: true, cases: modes.length })}\n`);

function makeFixture(mode) {
  const root = mkdtempSync(join(tmpdir(), 'hook-signal-eval-'));
  const home = join(root, 'home');
  const caveat = join(root, 'caveat');
  const evalRoot = join(caveat, 'local-eval', 'sidecar-advisory', 'hook-signal-ab');
  const own = join(caveat, 'own');
  for (const path of [home, evalRoot, own]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.caveatrc.json'), JSON.stringify({ knowledgeRepo: 'own' }), { mode: 0o600 });

  const seed = sha(`hook-signal-advisory/v1\0${sha(JSON.stringify(BASE))}`);
  const runs = [];
  for (const base of BASE) {
    for (const condition of ['control', 'signal']) {
      for (const replicate of [0, 1]) {
        const scenarioId = `${base.id}--${condition}`;
        const identity = `${seed}\0${scenarioId}\0${base.surface}\0gpt-5.6-luna\0${replicate}`;
        const context = structuredClone(base.context);
        if (condition === 'signal') context.push(structuredClone(base.signal));
        runs.push({
          runId: sha(`${identity}\0run`).slice(0, 32),
          judgmentId: sha(`${identity}\0judge`).slice(0, 32),
          scenarioId,
          surface: base.surface,
          model: 'gpt-5.6-luna',
          replicate,
          reasoningEffort: 'low',
          prompt: base.prompt,
          context,
          knownBadClaims: base.knownBadClaims,
          validSolutionRubric: base.rubric,
        });
      }
    }
  }
  runs.sort((left, right) => sha(`${seed}\0${left.runId}\0order`).localeCompare(sha(`${seed}\0${right.runId}\0order`)));
  if (mode === 'unbalanced') runs.pop();
  if (mode === 'pair-drift') runs.find((run) => run.scenarioId === 'stop-candidate-selection--signal').prompt = 'drift';
  if (mode === 'signal-tamper') runs.find((run) => run.scenarioId === 'tool-error-candidate-selection--signal').context.at(-1).summary = 'tampered';
  if (mode === 'symmetric-drift') runs.filter((run) => run.scenarioId.startsWith('stop-candidate-selection--')).forEach((run) => { run.prompt = 'symmetric drift'; });
  writeJson(join(evalRoot, 'study.json'), {
    schemaVersion: 'sidecar-advisory-study/v1',
    seed,
    sidecarCli: { kind: 'node_js', path: '/tmp/fake' },
    sidecarVersion: '0.3.5',
    runs,
  });

  const receipts = [];
  const packets = [];
  const judgments = [];
  const workRoot = join(evalRoot, 'work');
  mkdirSync(workRoot, { mode: 0o700 });
  for (const run of runs) {
    const work = join(workRoot, sha(run.runId));
    const logDir = join(work, '.codex-sidecar', 'logs', 'app-server');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(work, 0o700);
    const rawEventLogRef = join(logDir, 'raw.jsonl');
    const rawBytes = Buffer.from('{"event":"synthetic"}\n');
    writeFileSync(rawEventLogRef, rawBytes, { mode: 0o600 });
    const result = {
      status: 'ok', workflow: 'explore', summary: 'summary', recommendedNextAction: 'action',
      rawEventLogRef,
      modelPolicy: { source: 'explicit', model: 'gpt-5.6-luna', modelReasoningEffort: 'low' },
      normalizedRequest: { model: 'gpt-5.6-luna', modelReasoningEffort: 'low' },
    };
    writeFileSync(join(work, 'stdout.bin'), JSON.stringify(result), { mode: 0o600 });
    const receiptData = {
      schemaVersion: 'sidecar-advisory-receipt/v1',
      runId: run.runId,
      judgmentId: run.judgmentId,
      scenarioId: run.scenarioId,
      surface: run.surface,
      requestedModel: run.model,
      reasoningEffort: 'low',
      modelProvenance: 'requested_and_process_args',
      reportedModel: null,
      status: 'completed',
      usageStatus: 'available',
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110, modelContextWindow: 1000 },
      totalLatencyMs: 1,
      modelTurnLatencyMs: 1,
      resultDigest: sha(JSON.stringify(result)),
      rawEventLogDigest: sha(rawBytes),
    };
    receipts.push({ ...receiptData, digest: sha(JSON.stringify(receiptData)) });
    const evidence = run.context.map((block, index) => ({
      reference: `context-${index}`,
      content: JSON.stringify(block),
      digest: sha(JSON.stringify(block)),
    }));
    const packetData = {
      judgmentId: run.judgmentId,
      scenario: run.prompt,
      evidence,
      knownBadClaims: run.knownBadClaims,
      validSolutionRubric: run.validSolutionRubric,
      output: `${result.summary}\n${result.recommendedNextAction}`,
    };
    const packet = { ...packetData, packetDigest: sha(JSON.stringify(packetData)) };
    packets.push(packet);
    const prompt = 'masked';
    judgments.push({
      judgmentId: run.judgmentId,
      packetDigest: packet.packetDigest,
      knownBadClaimEmitted: 'no',
      validSolutionSupplied: 'yes',
      judge: 'claude-cli:2.1.207:primary=claude-sonnet-5:usage=claude-haiku-4-5-20251001,claude-sonnet-5',
      judgePrompt: prompt,
      judgePromptDigest: sha(prompt),
      maskedReviewAttested: true,
    });
  }
  if (mode === 'tampered') receipts[0].digest = '0'.repeat(64);
  if (mode === 'judge-missing') judgments.pop();
  if (mode === 'duplicate-receipt') receipts.push(receipts[0]);
  if (mode === 'wrong-judge') judgments[0].judge = 'claude-cli:2.1.207:claude-sonnet-4-6';
  if (mode === 'mixed-judge') judgments[0].judge = 'claude-cli:2.1.208:primary=claude-sonnet-5:usage=claude-sonnet-5';
  if (mode === 'packet-reseal') {
    packets[0].output = 'fabricated\naction';
    const { packetDigest: _old, ...packetData } = packets[0];
    packets[0].packetDigest = sha(JSON.stringify(packetData));
    judgments.find((judgment) => judgment.judgmentId === packets[0].judgmentId).packetDigest = packets[0].packetDigest;
  }
  const judgeRaw = [
    { type: 'system', subtype: 'init', session_id: 'judge-session', model: 'claude-sonnet-5', claude_code_version: '2.1.207' },
    { type: 'assistant', session_id: 'judge-session', message: { model: 'claude-sonnet-5', content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'result', subtype: 'success', session_id: 'judge-session', modelUsage: mode === 'judge-raw-tamper' ? { 'claude-sonnet-5': {} } : { 'claude-sonnet-5': {}, 'claude-haiku-4-5-20251001': {} } },
  ];
  writeJsonl(join(evalRoot, 'receipts.jsonl'), receipts);
  writeJsonl(join(evalRoot, 'review-packets.jsonl'), packets);
  writeJsonl(join(evalRoot, 'judgments-sonnet5.jsonl'), judgments);
  writeJsonl(join(evalRoot, 'judge-raw-sonnet5.jsonl'), judgeRaw);
  return { home, caveat, evalRoot, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function writeJson(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); }
function writeJsonl(path, values) { writeFileSync(path, `${values.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 }); chmodSync(path, 0o600); }
function assert(value, message) { if (!value) throw new Error(message); }
