#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import { isPathInside } from '../packages/core/dist/proposalEval.js';

const MODEL = 'gpt-5.6-luna';
const BLOCK = (data, summary) => ({ kind: 'manual_note', source: 'caveat-hook-signal', trust: 'local', summary, data });
const BASE = [
  { id: 'stop-candidate-selection', surface: 'stop', prompt: 'Synthetic Stop advisory: decide which supplied Caveat guidance is relevant, then give one concise next step.', context: [
    { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'If a session has repeated Bash commands, first isolate the repeated command and verify its assumptions.' },
    { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'If a session repeatedly edits a file, rerun the smallest affected test before reporting completion.' },
  ], knownBadClaims: ['Apply both caveats without selecting one.', 'Report completion without a targeted verification.'], rubric: ['Select the repeated-edit test gate when the structural signal indicates re-edited files.', 'Recommend the smallest affected test.'], signal: BLOCK({ type: 'stop', tool_failure_count: 0, reedited_file_count: 2, web_search_count: 0, web_fetch_count: 0, bash_retry_count: 0, duration_minutes: 8 }, 'Hook signal: 0 tool failures, 2 re-edited files, 0 web searches, 0 web fetches, 0 Bash retries, 8 elapsed minutes.') },
  { id: 'tool-error-candidate-selection', surface: 'tool_error', prompt: 'Synthetic tool_error advisory: decide which supplied Caveat guidance is relevant, then give one concise next step.', context: [
    { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'For a Bash failure, inspect the command preconditions and the exact exit status before retrying.' },
    { kind: 'caveat_entry', source: 'synthetic-public-fixture', trust: 'project', summary: 'For an Edit failure, verify the target file state before attempting another edit.' },
  ], knownBadClaims: ['Retry every candidate action blindly.', 'Treat the unknown raw error text as sidecar context.'], rubric: ['Select the Bash-specific guidance.', 'Recommend checking command preconditions before retrying.'], signal: BLOCK({ type: 'tool-error', tool: 'bash', failure_kind: 'post-tool-use-failure' }, 'Hook signal: Bash tool error (post-tool-use-failure).') },
];
try { main(args(process.argv.slice(2))); } catch (e) { process.stderr.write(`[caveat:prepare-hook-signal-study] ${e instanceof Error ? e.message : 'unexpected failure'}\n`); process.exitCode = 1; }
function main(o) {
  const home = realpathSync(process.env.HOME || homedir()); const caveat = findCaveatHome(home); const knowledge = realpathSync(resolvePaths(caveat, loadConfig(join(home, '.caveatrc.json')).knowledgeRepo, home).knowledgeRepo);
  const root = join(caveat, 'local-eval', 'sidecar-advisory', 'hook-signal-ab'); mkdirSync(root, { recursive: true, mode: 0o700 });
  if ((statSync(root).mode & 0o777) !== 0o700 || isPathInside(knowledge, realpathSync(root))) throw new Error('local output root is unsafe');
  const output = join(root, 'study.json'); if (existsSync(output)) throw new Error('study already exists');
  const manifest = sha(JSON.stringify(BASE)); const seed = sha(`hook-signal-advisory/v1\0${manifest}`);
  const runs = BASE.flatMap((base) => ['control', 'signal'].flatMap((condition) => [0, 1].map((replicate) => {
    const scenarioId = `${base.id}--${condition}`; const identity = `${seed}\0${scenarioId}\0${base.surface}\0${MODEL}\0${replicate}`;
    return { runId: sha(`${identity}\0run`).slice(0, 32), judgmentId: sha(`${identity}\0judge`).slice(0, 32), scenarioId, surface: base.surface, model: MODEL, replicate, reasoningEffort: 'low', prompt: base.prompt, context: condition === 'signal' ? [...base.context, base.signal] : base.context, knownBadClaims: base.knownBadClaims, validSolutionRubric: base.rubric };
  })));
  runs.sort((a,b) => sha(`${seed}\0${a.runId}\0order`).localeCompare(sha(`${seed}\0${b.runId}\0order`)));
  const study = { schemaVersion: 'sidecar-advisory-study/v1', seed, sidecarCli: { kind: o.kind, path: o.cli }, sidecarVersion: o.version, runs };
  const bytes = Buffer.from(`${JSON.stringify(study, null, 2)}\n`); const fd = openSync(output, 'wx', 0o600); try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  process.stdout.write(`${JSON.stringify({ schemaVersion: study.schemaVersion, runCount: runs.length, model: MODEL, studyDigest: sha(bytes) })}\n`);
}
function args(xs) { const o = { kind: 'node_js', version: '0.3.5' }; for(let i=0;i<xs.length;i++){ if(xs[i]==='--cli')o.cli=resolve(xs[++i]); else if(xs[i]==='--kind')o.kind=xs[++i]; else if(xs[i]==='--version')o.version=xs[++i]; else if(xs[i]!=='--')throw new Error('unknown option'); } if(!o.cli||!isAbsolute(o.cli)||!['node_js','executable'].includes(o.kind)||!o.version)throw new Error('valid --cli, --kind, and --version are required'); return o; }
function sha(v) { return createHash('sha256').update(v).digest('hex'); }
