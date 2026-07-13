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

const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_REASONING_EFFORT = 'low';
const SESSION_ID = 'sidecar-smoke';
const TOOL_ERROR_SEARCH_TEXT = 'Codex sidecar tool error smoke command failed with exit code 77 sentinel';
const RAW_STOP_SENTINEL = 'RAW_STOP_PRIVATE_SENTINEL_DO_NOT_FORWARD';
const RAW_TOOL_SENTINEL = 'RAW_TOOL_PRIVATE_SENTINEL_DO_NOT_FORWARD';

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
              content: `release smoke failure for Caveat Codex sidecar advisory ${RAW_STOP_SENTINEL}`,
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

  if (options.surface === 'stop') runStopSmoke();
  else runToolErrorSmoke();

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
        surface: options.surface,
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
    surface: 'stop',
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
    } else if (arg === '--surface') {
      parsed.surface = requireValue(args, (index += 1), arg);
      if (!['stop', 'tool-error'].includes(parsed.surface)) {
        throw new Error('--surface must be stop or tool-error');
      }
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

function hookEnv() {
  return {
    ...sidecarEnv(),
    CAVEAT_HOME: caveatHome,
    CAVEAT_HOOK_CODEX_SIDECAR: 'require',
    CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS: String(options.timeoutMs),
    CAVEAT_INDEX_AUTOSYNC: 'off',
    CAVEAT_AUTO_SYNC: 'off',
  };
}

function runStopSmoke() {
  runCaveat(
    ['hook', 'stop'],
    {
      input: JSON.stringify({
        session_id: SESSION_ID,
        transcript_path: transcript,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
      env: hookEnv(),
    },
  );
}

function runToolErrorSmoke() {
  const own = join(caveatHome, 'own', 'entries');
  mkdirSync(own, { recursive: true });
  writeFileSync(
    join(own, 'codex-sidecar-tool-error-smoke.md'),
    `---
id: codex-sidecar-tool-error-smoke
title: 'Codex sidecar tool error smoke command exits 77'
visibility: private
confidence: reproduced
outcome: resolved
tags: [codex-sidecar, tool-error, smoke]
environment:
  caveat: synthetic-smoke
source_project: null
source_session: synthetic-smoke
created_at: 2026-07-13
updated_at: 2026-07-13
last_verified: 2026-07-13
---

## Symptom
The synthetic Codex sidecar tool error smoke command failed with exit code 77 sentinel.

## Resolution
Inspect the failing command and its exact error before retrying.
`,
    'utf8',
  );
  runCaveat(['index', '--full'], { env: hookEnv() });
  runCaveat(
    ['hook', 'post-tool-use'],
    {
      input: JSON.stringify({
        session_id: SESSION_ID,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'synthetic command is local-only' },
        tool_response: {
          is_error: true,
          stderr: `${TOOL_ERROR_SEARCH_TEXT} ${RAW_TOOL_SENTINEL}`,
        },
      }),
      env: hookEnv(),
    },
  );
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
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pendingDir)) {
      const [first] = listFiles(pendingDir)
        .filter((path) => path.endsWith('.ready') || path.endsWith('.txt'))
        .sort();
      if (first) return first;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`pending reminder file does not exist under ${pendingDir}`);
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
  const raw = readFileSync(path, 'utf8');
  let startupOk = false;
  let threadRequestId;
  let threadId;
  let effectivePolicyOk = false;
  let turnRequestId;
  let turnId;
  let turnInputOk = false;
  let turnSchemaOk = false;
  let turnCompleted = false;
  const expectedBlock = JSON.stringify(expectedHookSignalBlock());
  for (const line of raw.trim().split(/\n/)) {
    const entry = JSON.parse(line);
    if (entry.event === 'process/start') {
      const args = entry.data?.args ?? [];
      startupOk =
        args.includes(`model="${DEFAULT_MODEL}"`) &&
        args.includes(`model_reasoning_effort="${DEFAULT_REASONING_EFFORT}"`);
    }
    if (entry.event === 'request/send' && entry.direction === 'outbound') {
      if (entry.data?.method === 'thread/start') {
        threadRequestId = entry.data.id;
      } else if (entry.data?.method === 'turn/start') {
        if (!threadId || entry.data?.params?.threadId !== threadId) continue;
        turnRequestId = entry.data.id;
        const outputSchema = entry.data?.params?.outputSchema;
        turnSchemaOk = outputSchema?.type === 'object' &&
          outputSchema?.additionalProperties === false &&
          Array.isArray(outputSchema?.required) &&
          outputSchema.required.includes('summary') &&
          outputSchema.required.includes('recommendedNextAction');
        const input = entry.data?.params?.input;
        const text = Array.isArray(input) && input.length === 1 && input[0]?.type === 'text'
          ? input[0].text
          : undefined;
        if (typeof text === 'string') {
          turnInputOk = countOccurrences(text, expectedBlock) === 1 &&
            countOccurrences(text, '"source":"caveat-hook-signal"') === 1 &&
            ![RAW_STOP_SENTINEL, RAW_TOOL_SENTINEL, SESSION_ID].some((value) => text.includes(value));
        }
      }
    }
    if (entry.event === 'message/receive' && typeof entry.data?.line === 'string') {
      const message = JSON.parse(entry.data.line);
      if (message.id === threadRequestId) {
        threadId = message.result?.thread?.id;
        effectivePolicyOk = typeof threadId === 'string' &&
          message.result?.model === DEFAULT_MODEL &&
          message.result?.reasoningEffort === DEFAULT_REASONING_EFFORT;
      } else if (message.id === turnRequestId) {
        turnId = message.result?.turn?.id;
      }
    }
    if (entry.event === 'notification/retained' && entry.data?.method === 'turn/completed') {
      turnCompleted ||= entry.data?.params?.threadId === threadId &&
        entry.data?.params?.turn?.id === turnId &&
        entry.data?.params?.turn?.status === 'completed';
    }
  }
  if (!startupOk) throw new Error('raw log does not contain advisory startup model policy');
  if (!effectivePolicyOk) throw new Error('thread/start response does not confirm effective advisory model policy');
  if (!turnSchemaOk) throw new Error('turn/start request does not contain the closed SidecarResult outputSchema');
  if (!turnInputOk) throw new Error('turn/start request does not contain the exact bounded hook signal context');
  if (!turnId || !turnCompleted) throw new Error('hook signal turn did not complete on the matched thread and turn');
}

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function expectedHookSignalBlock() {
  if (options.surface === 'tool-error') {
    return {
      kind: 'manual_note',
      source: 'caveat-hook-signal',
      trust: 'local',
      summary: 'Hook signal: Bash tool error (post-tool-use-failure).',
      data: {
        type: 'tool-error',
        tool: 'bash',
        failure_kind: 'post-tool-use-failure',
      },
    };
  }
  return {
    kind: 'manual_note',
    source: 'caveat-hook-signal',
    trust: 'local',
    summary: 'Hook signal: 1 tool failures, 0 re-edited files, 0 web searches, 0 web fetches, 0 Bash retries, 0 elapsed minutes.',
    data: {
      type: 'stop',
      tool_failure_count: 1,
      reedited_file_count: 0,
      web_search_count: 0,
      web_fetch_count: 0,
      bash_retry_count: 0,
      duration_minutes: 0,
    },
  };
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
  --surface <stop|tool-error>         hook surface to verify (default: stop)
  --keep-temp                         keep temporary CAVEAT_HOME files
`);
}
