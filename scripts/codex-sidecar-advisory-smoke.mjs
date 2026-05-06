#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_REASONING_EFFORT = 'low';
const SESSION_ID = 'sidecar-smoke';

const options = parseArgs(process.argv.slice(2));
const root = mkdtempSync(`${tmpdir()}/caveat-sidecar-advisory-smoke-`);
const caveatHome = `${root}/caveat-home`;
const transcript = `${root}/stop.jsonl`;
const diagnostics = `${root}/diagnostics.json`;
let keepTemp = options.keepTemp;

try {
  mkdirSync(caveatHome, { recursive: true });
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_result',
              is_error: true,
              content: 'release smoke failure for Caveat Codex sidecar advisory',
            },
          ],
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  runCaveat(
    [
      'codex-sidecar',
      'diagnostics',
      '--project',
      options.repo,
      '--preset',
      'advisory',
      ...sidecarCliArgs(),
      '--save-result',
      diagnostics,
    ],
    {
      env: sidecarEnv(),
    },
  );

  const diagnosticResult = readJson(diagnostics);
  assertEqual(diagnosticResult.modelPolicy?.source, 'explicit', 'modelPolicy.source');
  assertEqual(diagnosticResult.normalizedRequest?.model, DEFAULT_MODEL, 'normalizedRequest.model');
  assertEqual(
    diagnosticResult.normalizedRequest?.modelReasoningEffort,
    DEFAULT_REASONING_EFFORT,
    'normalizedRequest.modelReasoningEffort',
  );

  runCaveat(
    ['hook', 'stop'],
    {
      input: JSON.stringify({
        session_id: SESSION_ID,
        transcript_path: transcript,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
      env: {
        ...sidecarEnv(),
        CAVEAT_HOME: caveatHome,
        CAVEAT_HOOK_CODEX_SIDECAR: 'require',
        CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS: String(options.timeoutMs),
      },
    },
  );

  const pending = findPendingReminder(caveatHome);
  const reminder = readFileSync(pending, 'utf8');
  if (!reminder.includes('[caveat:codex-sidecar] Codex advisory:')) {
    throw new Error('pending reminder does not contain Codex advisory');
  }
  if (reminder.includes('advisory unavailable')) {
    throw new Error('pending reminder reports advisory unavailable');
  }

  const rawLogRef = rawEventLogRef(reminder);
  if (!existsSync(rawLogRef)) {
    throw new Error(`rawEventLogRef does not exist: ${rawLogRef}`);
  }
  verifyRawLog(rawLogRef);

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        repo: options.repo,
        model: DEFAULT_MODEL,
        modelReasoningEffort: DEFAULT_REASONING_EFFORT,
        diagnostics,
        pendingReminder: pending,
        rawEventLogRef: rawLogRef,
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  keepTemp = true;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[caveat-sidecar-advisory-smoke:error] ${message}\n`);
  process.stderr.write(`[caveat-sidecar-advisory-smoke:error] temp kept at ${root}\n`);
  process.exitCode = 1;
} finally {
  if (!keepTemp) {
    rmSync(root, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const parsed = {
    repo: process.cwd(),
    caveatCommand: 'caveat',
    caveatNodeCli: undefined,
    codexSidecarCommand: process.env.CAVEAT_CODEX_SIDECAR_COMMAND,
    codexSidecarNodeCli: process.env.CAVEAT_CODEX_SIDECAR_NODE_CLI,
    timeoutMs: positiveInteger(
      process.env.CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS ?? '240000',
      'CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS',
    ),
    keepTemp: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--repo') {
      parsed.repo = resolve(requireValue(args, (index += 1), arg));
    } else if (arg === '--caveat-command') {
      parsed.caveatCommand = requireValue(args, (index += 1), arg);
    } else if (arg === '--caveat-node-cli') {
      parsed.caveatNodeCli = resolve(requireValue(args, (index += 1), arg));
    } else if (arg === '--codex-sidecar-command') {
      parsed.codexSidecarCommand = requireValue(args, (index += 1), arg);
    } else if (arg === '--codex-sidecar-node-cli') {
      parsed.codexSidecarNodeCli = resolve(requireValue(args, (index += 1), arg));
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = positiveInteger(requireValue(args, (index += 1), arg), arg);
    } else if (arg === '--keep-temp') {
      parsed.keepTemp = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return parsed;
}

function runCaveat(args, runOptions = {}) {
  const command = options.caveatNodeCli ? process.execPath : options.caveatCommand;
  const commandArgs = options.caveatNodeCli ? [options.caveatNodeCli, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: options.repo,
    encoding: 'utf8',
    input: runOptions.input,
    env: runOptions.env ?? process.env,
    timeout: options.timeoutMs + 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command} ${commandArgs.join(' ')}`);
  }
}

function sidecarEnv() {
  const {
    CAVEAT_CODEX_SIDECAR_COMMAND: _command,
    CAVEAT_CODEX_SIDECAR_NODE_CLI: _nodeCli,
    ...baseEnv
  } = process.env;

  return {
    ...baseEnv,
    ...(options.codexSidecarNodeCli
      ? { CAVEAT_CODEX_SIDECAR_NODE_CLI: options.codexSidecarNodeCli }
      : {}),
    ...(options.codexSidecarCommand
      ? { CAVEAT_CODEX_SIDECAR_COMMAND: options.codexSidecarCommand }
      : {}),
  };
}

function sidecarCliArgs() {
  if (options.codexSidecarNodeCli) return ['--node-cli', options.codexSidecarNodeCli];
  if (options.codexSidecarCommand) return ['--command', options.codexSidecarCommand];
  return [];
}

function findPendingReminder(home) {
  const pendingDir = `${home}/pending/${SESSION_ID}`;
  if (!existsSync(pendingDir)) {
    throw new Error(`pending reminder directory does not exist: ${pendingDir}`);
  }
  const [first] = listFiles(pendingDir)
    .filter((path) => path.endsWith('.txt'))
    .sort();
  if (!first) throw new Error(`pending reminder file does not exist under ${pendingDir}`);
  return first;
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function rawEventLogRef(reminder) {
  const matches = [...reminder.matchAll(/^rawEventLogRef:\s*(.+)$/gm)];
  const value = matches.at(-1)?.[1]?.trim();
  if (!value) throw new Error('pending reminder does not contain rawEventLogRef');
  return value;
}

function verifyRawLog(path) {
  let startupOk = false;
  let threadOk = false;
  for (const line of readFileSync(path, 'utf8').trim().split(/\n/)) {
    const entry = JSON.parse(line);
    if (entry.event === 'process/start') {
      const args = entry.data?.args ?? [];
      startupOk =
        args.includes(`model="${DEFAULT_MODEL}"`) &&
        args.includes(`model_reasoning_effort="${DEFAULT_REASONING_EFFORT}"`);
    }
    if (entry.event === 'message/receive' && typeof entry.data?.line === 'string') {
      threadOk ||= entry.data.line.includes(`"model":"${DEFAULT_MODEL}"`) &&
        entry.data.line.includes(`"reasoningEffort":"${DEFAULT_REASONING_EFFORT}"`);
    }
  }
  if (!startupOk) throw new Error('raw log does not contain advisory startup model policy');
  if (!threadOk) throw new Error('raw log does not contain advisory thread model policy');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/codex-sidecar-advisory-smoke.mjs [options]

Options:
  --repo <path>                       repository root with .codex-sidecar.yml
  --caveat-command <command>          caveat command on PATH (default: caveat)
  --caveat-node-cli <path>            development path to Caveat CLI JS
  --codex-sidecar-command <command>   codex-sidecar command on PATH
  --codex-sidecar-node-cli <path>     development path to codex-sidecar CLI JS
  --timeout-ms <ms>                   hook advisory timeout (default: 240000)
  --keep-temp                         keep temporary CAVEAT_HOME files
`);
}
