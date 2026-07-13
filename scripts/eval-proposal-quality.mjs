#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import { ProposalEvalArtifactError, evaluateProposalArtifacts, isPathInside, parseProposalAssignmentsJsonl, parseProposalJudgmentsJsonl, parseProposalPoliciesJsonl, parseProposalReviewPacketsJsonl, parseProposalScenariosJsonl, parseProposalTrialsJsonl } from '../packages/core/dist/proposalEval.js';

class SafeRunnerError extends Error { constructor(reason, count = 1) { super(`evaluation precondition failed; count ${count}; ${reason}`); this.name = 'SafeRunnerError'; } }
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write('Usage: pnpm eval:proposal-quality -- [--scenarios <jsonl>] [--policies <jsonl>] [--assignments <jsonl>] [--trials <jsonl>] [--review-packets <jsonl>] [--judgments <jsonl>]\n');
  else {
    const userHome = process.env.HOME || homedir();
    const caveatHome = findCaveatHome(userHome);
    const paths = resolvePaths(caveatHome, loadConfig(join(userHome, '.caveatrc.json')).knowledgeRepo, userHome);
    const root = join(caveatHome, 'local-eval', 'proposal');
    const artifactPaths = Object.fromEntries(['scenarios', 'policies', 'assignments', 'trials', 'review-packets', 'judgments'].map((name) => [name, options[name] ? resolve(process.cwd(), options[name]) : join(root, `${name}.jsonl`)]));
    for (const path of Object.values(artifactPaths)) validateArtifact(path, paths.knowledgeRepo);
    const bytes = Object.fromEntries(Object.entries(artifactPaths).map(([name, path]) => [name, readFileSync(path)]));
    const metrics = evaluateProposalArtifacts(parseProposalScenariosJsonl(bytes.scenarios.toString('utf8')), parseProposalPoliciesJsonl(bytes.policies.toString('utf8')), parseProposalAssignmentsJsonl(bytes.assignments.toString('utf8')), parseProposalTrialsJsonl(bytes.trials.toString('utf8')), parseProposalReviewPacketsJsonl(bytes['review-packets'].toString('utf8')), parseProposalJudgmentsJsonl(bytes.judgments.toString('utf8')));
    process.stdout.write(`${JSON.stringify({ schemaVersion: metrics.schemaVersion, runnerVersion: metrics.runnerVersion, artifactDigests: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha256(value)])), aggregate: metrics.strata.map((stratum) => ({ host: stratum.host, modelDigest: sha256(stratum.model), policyDigest: stratum.policyDigest, scenarioCount: stratum.scenarioCount, macroRateDifference: stratum.macroRateDifference, scenarioMetrics: stratum.scenarios.map((scenario) => ({ conditions: scenario.conditions, rateDifference: scenario.rateDifference })) })) }, null, 2)}\n`);
  }
} catch (error) { process.stderr.write(`[caveat:proposal-eval] ${error instanceof ProposalEvalArtifactError || error instanceof SafeRunnerError ? error.message : 'unexpected runtime failure; no private artifact data was printed'}\n`); process.exitCode = 1; }
function parseArgs(args) { const parsed = { scenarios: undefined, policies: undefined, assignments: undefined, trials: undefined, 'review-packets': undefined, judgments: undefined, help: false }; for (let index = 0; index < args.length; index++) { const arg = args[index]; if (arg === '--') continue; if (arg === '--help' || arg === '-h') parsed.help = true; else if (['--scenarios', '--policies', '--assignments', '--trials', '--review-packets', '--judgments'].includes(arg)) { const value = args[++index]; if (!value) throw new SafeRunnerError(`${arg} requires one value`); parsed[arg.slice(2)] = value; } else throw new SafeRunnerError('unknown command-line option'); } return parsed; }
function validateArtifact(path, knowledgeRepo) { if (!existsSync(path)) throw new SafeRunnerError('required local evaluation artifact is missing', 0); const parent = statSync(dirname(path)); const file = statSync(path); if (!parent.isDirectory()) throw new SafeRunnerError('artifact parent is not a directory'); if (!file.isFile()) throw new SafeRunnerError('artifact is not a regular file'); if ((parent.mode & 0o777) !== 0o700) throw new SafeRunnerError('artifact parent mode must be 0700'); if ((file.mode & 0o777) !== 0o600) throw new SafeRunnerError('artifact file mode must be 0600'); if (isPathInside(realpathSync(knowledgeRepo), realpathSync(path))) throw new SafeRunnerError('local evaluation artifact must not be inside the knowledge repository'); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
