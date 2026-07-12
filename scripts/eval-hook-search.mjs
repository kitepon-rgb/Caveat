#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import { scanSource, walkMarkdown } from '../packages/core/dist/indexer.js';
import { defaultSelfIdentityTokens, findCaveatsForPrompt } from '../packages/core/dist/claudeHooks.js';
import {
  assertStableHookSearchResults,
  evaluateHookSearch,
  HookSearchArtifactError,
  parseHookSearchGoldenJsonl,
  validateHookSearchCases,
} from '../packages/core/dist/hookSearchEval.js';

const LIMITATION = 'characterization only: current retrieval tie-break is not deterministic across machines';

class SafeRunnerError extends Error {
  constructor(reason, count = 1) {
    super(`evaluation precondition failed; count ${count}; ${reason}`);
    this.name = 'SafeRunnerError';
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  const message = error instanceof SafeRunnerError
    ? error.message
    : 'unexpected command-line parsing failure';
  process.stderr.write(`[caveat:hook-search-eval] ${message}\n`);
  process.exit(1);
}
if (options.help) {
  process.stdout.write('Usage: pnpm eval:hook-search -- [--golden <jsonl>]\n');
  process.exit(0);
}

let tempRoot;
let db;
try {
  const userHome = process.env.HOME || homedir();
  const caveatHome = findCaveatHome(userHome);
  const config = loadConfig(join(userHome, '.caveatrc.json'));
  const paths = resolvePaths(caveatHome, config.knowledgeRepo, userHome);
  const goldenPath = options.golden
    ? resolve(process.cwd(), options.golden)
    : join(paths.knowledgeRepo, 'eval', 'hook-search-golden.jsonl');

  validateArtifactPermissions(goldenPath);
  const subscriptions = subscriptionDirectoryCount(paths.communityDir);
  if (subscriptions > 0) {
    throw new SafeRunnerError('community subscriptions make own-only evaluation differ from the production hook corpus', subscriptions);
  }

  const goldenBytes = readFileSync(goldenPath);
  const cases = parseHookSearchGoldenJsonl(goldenBytes.toString('utf-8'));
  tempRoot = mkdtempSync(join(tmpdir(), 'caveat-hook-search-eval-'));
  const dbPath = join(tempRoot, 'eval.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../packages/core/dist/schema.sql', import.meta.url), 'utf-8'));
  scanSource({ db, source: 'own', entriesRoot: paths.entriesDir });

  const corpusRefs = db.prepare('SELECT id, source FROM entries ORDER BY source, id').all();
  validateHookSearchCases(cases, corpusRefs);
  const first = runSnapshot(db, cases);
  const second = runSnapshot(db, cases);
  assertStableHookSearchResults(first, second);
  const metrics = evaluateHookSearch(cases, first, corpusRefs);
  if (metrics.entryCoverage.numerator !== metrics.entryCoverage.denominator) {
    throw new SafeRunnerError(
      'golden subject coverage must include every corpus entry',
      metrics.entryCoverage.denominator - metrics.entryCoverage.numerator,
    );
  }
  const git = gitSnapshot(paths.knowledgeRepo);
  const sourceCounts = Object.fromEntries(
    db.prepare('SELECT source, COUNT(*) AS count FROM entries GROUP BY source ORDER BY source')
      .all()
      .map((row) => [row.source, Number(row.count)]),
  );

  process.stdout.write(`${JSON.stringify({
    ...metrics,
    corpusDigest: digestCorpus(paths.entriesDir),
    goldenDigest: sha256(goldenBytes),
    sourceCounts,
    corpusCount: corpusRefs.length,
    gitHead: git.head,
    dirty: git.dirty,
    reproducible: false,
    limitation: LIMITATION,
    evaluatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
} catch (error) {
  if (error instanceof HookSearchArtifactError || error instanceof SafeRunnerError) {
    process.stderr.write(`[caveat:hook-search-eval] ${error.message}\n`);
  } else {
    process.stderr.write('[caveat:hook-search-eval] unexpected runtime failure; no private artifact data was printed\n');
  }
  process.exitCode = 1;
} finally {
  try {
    db?.close();
  } catch {
    process.stderr.write('[caveat:hook-search-eval] temporary database close failed\n');
    process.exitCode = 1;
  }
  if (tempRoot) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      process.stderr.write('[caveat:hook-search-eval] temporary database cleanup failed\n');
      process.exitCode = 1;
    }
  }
}

function parseArgs(args) {
  const parsed = { golden: undefined, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--golden') {
      const value = args[++index];
      if (!value) throw new SafeRunnerError('--golden requires one value');
      parsed.golden = value;
    } else {
      throw new SafeRunnerError('unknown command-line option');
    }
  }
  return parsed;
}

function validateArtifactPermissions(goldenPath) {
  if (!existsSync(goldenPath)) throw new SafeRunnerError('golden artifact is missing', 0);
  const dirStat = statSync(dirname(goldenPath));
  const fileStat = statSync(goldenPath);
  if (!dirStat.isDirectory()) throw new SafeRunnerError('golden artifact parent is not a directory');
  if (!fileStat.isFile()) throw new SafeRunnerError('golden artifact is not a regular file');
  const dirMode = dirStat.mode & 0o777;
  const fileMode = fileStat.mode & 0o777;
  if (dirMode !== 0o700) throw new SafeRunnerError('golden artifact directory mode must be 0700');
  if (fileMode !== 0o600) throw new SafeRunnerError('golden artifact file mode must be 0600');
}

function subscriptionDirectoryCount(communityDir) {
  if (!existsSync(communityDir)) return 0;
  return readdirSync(communityDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .length;
}

function runSnapshot(database, cases) {
  const selfIdentity = defaultSelfIdentityTokens();
  return cases.map((item) => ({
    caseId: item.caseId,
    returned: findCaveatsForPrompt(database, item.query, { selfIdentity, limit: 5 })
      .map(({ id, source }) => ({ id, source })),
  }));
}

function digestCorpus(entriesDir) {
  const hash = createHash('sha256');
  if (!existsSync(entriesDir)) return hash.digest('hex');
  const files = [...walkMarkdown(entriesDir)].sort((a, b) => Buffer.compare(
    Buffer.from(relative(entriesDir, a).replace(/\\/g, '/'), 'utf-8'),
    Buffer.from(relative(entriesDir, b).replace(/\\/g, '/'), 'utf-8'),
  ));
  for (const file of files) {
    const relPath = relative(entriesDir, file).replace(/\\/g, '/');
    const bytes = readFileSync(file);
    const pathBytes = Buffer.from(relPath, 'utf-8');
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(pathBytes.length, 0);
    lengths.writeUInt32BE(bytes.length, 4);
    hash.update(lengths).update(pathBytes).update(bytes);
  }
  return hash.digest('hex');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitSnapshot(knowledgeRepo) {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: knowledgeRepo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (head.status !== 0 || !/^[0-9a-f]{40,64}\s*$/i.test(head.stdout)) {
    throw new SafeRunnerError('knowledge repository git HEAD is unavailable');
  }
  const status = spawnSync('git', ['status', '--porcelain', '--', 'entries', 'eval'], {
    cwd: knowledgeRepo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (status.status !== 0) throw new SafeRunnerError('knowledge repository dirty state is unavailable');
  return { head: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}
