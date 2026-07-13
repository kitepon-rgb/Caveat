#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import { scanSource, walkMarkdown } from '../packages/core/dist/indexer.js';
import { defaultSelfIdentityTokens, findCaveatsForHook } from '../packages/core/dist/claudeHooks.js';
import { evaluateHookProvenance, HookProvenanceArtifactError, parseHookProvenanceGoldenJsonl, validateHookProvenanceCases } from '../packages/core/dist/hookProvenanceEval.js';

class SafeRunnerError extends Error { constructor(reason, count = 1) { super(`evaluation precondition failed; count ${count}; ${reason}`); this.name = 'SafeRunnerError'; } }
function parseArgs(args) {
  let golden; let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--golden') { golden = args[++index]; if (!golden) throw new SafeRunnerError('--golden requires one value'); }
    else throw new SafeRunnerError('unknown command-line option');
  }
  if (!help && !golden) throw new SafeRunnerError('--golden is required');
  return { golden, help };
}
function validateArtifactPermissions(path) {
  if (!existsSync(path)) throw new SafeRunnerError('golden artifact is missing', 0);
  const parent = statSync(dirname(path)); const file = statSync(path);
  if (!parent.isDirectory()) throw new SafeRunnerError('golden artifact parent is not a directory');
  if (!file.isFile()) throw new SafeRunnerError('golden artifact is not a regular file');
  if ((parent.mode & 0o777) !== 0o700) throw new SafeRunnerError('golden artifact directory mode must be 0700');
  if ((file.mode & 0o777) !== 0o600) throw new SafeRunnerError('golden artifact file mode must be 0600');
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function digestCorpus(entriesDir) {
  const hash = createHash('sha256');
  if (!existsSync(entriesDir)) return hash.digest('hex');
  const files = [...walkMarkdown(entriesDir)].sort((a, b) => Buffer.compare(Buffer.from(relative(entriesDir, a).replace(/\\/g, '/')), Buffer.from(relative(entriesDir, b).replace(/\\/g, '/'))));
  for (const path of files) { const name = Buffer.from(relative(entriesDir, path).replace(/\\/g, '/')); const bytes = readFileSync(path); const lengths = Buffer.allocUnsafe(8); lengths.writeUInt32BE(name.length, 0); lengths.writeUInt32BE(bytes.length, 4); hash.update(lengths).update(name).update(bytes); }
  return hash.digest('hex');
}

let tempRoot; let db;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write('Usage: pnpm eval:hook-provenance -- --golden <jsonl>\n'); process.exit(0); }
  const goldenPath = resolve(process.cwd(), options.golden);
  validateArtifactPermissions(goldenPath);
  const goldenBytes = readFileSync(goldenPath);
  const cases = parseHookProvenanceGoldenJsonl(goldenBytes.toString('utf8'));
  const userHome = process.env.HOME || homedir();
  const caveatHome = findCaveatHome(userHome);
  const paths = resolvePaths(caveatHome, loadConfig(join(userHome, '.caveatrc.json')).knowledgeRepo, userHome);
  tempRoot = mkdtempSync(join(tmpdir(), 'caveat-hook-provenance-eval-'));
  db = new DatabaseSync(join(tempRoot, 'eval.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../packages/core/dist/schema.sql', import.meta.url), 'utf8'));
  scanSource({ db, source: 'own', entriesRoot: paths.entriesDir });
  const corpusRefs = db.prepare('SELECT id, source FROM entries ORDER BY source, id').all();
  validateHookProvenanceCases(cases, corpusRefs);
  const selfIdentity = defaultSelfIdentityTokens();
  const results = cases.map((item) => ({ caseId: item.caseId, returned: findCaveatsForHook(db, item, { selfIdentity, limit: 5 }).map(({ id, source }) => ({ id, source })) }));
  const report = evaluateHookProvenance(cases, results);
  process.stdout.write(`${JSON.stringify({ ...report, corpusDigest: digestCorpus(paths.entriesDir), goldenDigest: sha256(goldenBytes), corpusCount: corpusRefs.length }, null, 2)}\n`);
} catch (error) {
  if (error instanceof HookProvenanceArtifactError || error instanceof SafeRunnerError) process.stderr.write(`[caveat:hook-provenance-eval] ${error.message}\n`);
  else process.stderr.write('[caveat:hook-provenance-eval] unexpected runtime failure; no private artifact data was printed\n');
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { process.stderr.write('[caveat:hook-provenance-eval] temporary database close failed\n'); process.exitCode = 1; }
  if (tempRoot) try { rmSync(tempRoot, { recursive: true, force: true }); } catch { process.stderr.write('[caveat:hook-provenance-eval] temporary database cleanup failed\n'); process.exitCode = 1; }
}
