#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const AUTH_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 120_000;
const PROMPT_SENTINEL = 'caveat-claude-session-ok';

const options = parseArgs(process.argv.slice(2));
let workDir;
try {
  assertInput('settings', options.settings);
  assertInput('mcp config', options.mcpConfig);
  assertInput('CAVEAT_HOME', options.caveatHome);
  assertAuthenticated();

  workDir = mkdtempSync(`${tmpdir()}/caveat-claude-fresh-session-`);
  const result = spawnSync(options.claudeCommand, [
    ...options.claudeCommandArgs,
    '-p',
    '--verbose',
    '--output-format=stream-json',
    '--include-hook-events',
    '--setting-sources', 'project',
    '--settings', options.settings,
    '--mcp-config', options.mcpConfig,
    '--strict-mcp-config',
    '--model', 'haiku',
    '--max-budget-usd', '0.05',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    `Reply exactly: ${PROMPT_SENTINEL}`,
  ], {
    cwd: workDir,
    env: { ...process.env, CAVEAT_HOME: options.caveatHome },
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Claude session did not complete within ${options.timeoutMs}ms`);
  if (result.status !== 0) throw new Error(`Claude session exited with status ${result.status ?? 'unknown'}`);
  verifyStream(result.stdout);
  process.stdout.write(`${JSON.stringify({ status: 'ok', model: 'haiku', promptSentinel: PROMPT_SENTINEL })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const unavailable = message.startsWith('Claude authentication unavailable:');
  process.stderr.write(`[claude-fresh-session-smoke:${unavailable ? 'unavailable' : 'error'}] ${message}\n`);
  process.exitCode = unavailable ? 2 : 1;
} finally {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
}

function assertAuthenticated() {
  const result = spawnSync(options.claudeCommand, [...options.claudeCommandArgs, 'auth', 'status'], {
    cwd: tmpdir(),
    env: process.env,
    encoding: 'utf8',
    timeout: options.authTimeoutMs,
    maxBuffer: 64 * 1024,
  });
  if (result.error) throw new Error(`Claude authentication unavailable: auth status did not complete within ${options.authTimeoutMs}ms`);
  if (result.status !== 0) throw new Error('Claude authentication unavailable: auth status was not successful');
  let status;
  try { status = JSON.parse(result.stdout); } catch { throw new Error('Claude authentication unavailable: auth status was not valid JSON'); }
  if (!plainObject(status) || status.loggedIn !== true) throw new Error('Claude authentication unavailable: auth status reports no authenticated user');
}

function verifyStream(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) throw new Error('Claude stream JSON is empty');
  const events = stdout.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Claude stream JSON line ${index + 1} is invalid`); }
    if (!plainObject(event)) throw new Error(`Claude stream JSON line ${index + 1} is not an object`);
    return event;
  });
  const hookStarts = events.filter((event) => event.type === 'system' && event.subtype === 'hook_started');
  const hookResponses = events.filter((event) => event.type === 'system' && event.subtype === 'hook_response');
  for (const hookName of ['UserPromptSubmit', 'Stop']) {
    const starts = hookStarts.filter((event) => event.hook_name === hookName && event.hook_event === hookName);
    const responses = hookResponses.filter((event) => event.hook_name === hookName && event.hook_event === hookName);
    if (starts.length !== 1 || responses.length !== 1 || starts[0].hook_id !== responses[0].hook_id || responses[0].exit_code !== 0 || responses[0].outcome !== 'success') {
      throw new Error(`Claude ${hookName} hook did not report exit_code 0 and success`);
    }
  }
  const terminal = events.filter((event) => event.type === 'result');
  if (terminal.length !== 1 || terminal[0].subtype !== 'success' || terminal[0].is_error !== false || terminal[0].result !== PROMPT_SENTINEL) {
    throw new Error('Claude result sentinel is missing or unsuccessful');
  }
  const assistantModels = events
    .filter((event) => event.type === 'assistant')
    .map((event) => event.message?.model)
    .filter((model) => typeof model === 'string');
  const usageModels = plainObject(terminal[0].modelUsage) ? Object.keys(terminal[0].modelUsage) : [];
  if (assistantModels.length === 0 || usageModels.length === 0 || [...assistantModels, ...usageModels].some((model) => !model.toLowerCase().includes('haiku'))) {
    throw new Error('Claude effective model is not Haiku');
  }
  if (events.some(containsCaveatErrorText)) {
    throw new Error('Claude stream contains a Caveat error');
  }
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function containsCaveatErrorText(value) {
  if (typeof value === 'string') return /caveat.*(?:error|invalid|failed)|(?:error|invalid|failed).*caveat/i.test(value);
  if (Array.isArray(value)) return value.some(containsCaveatErrorText);
  if (plainObject(value)) return Object.values(value).some(containsCaveatErrorText);
  return false;
}
function assertInput(name, value) {
  if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`${name} must be an existing absolute path`);
}
function parseArgs(args) {
  const parsed = { claudeCommand: 'claude', claudeCommandArgs: [], settings: undefined, mcpConfig: undefined, caveatHome: undefined, timeoutMs: SESSION_TIMEOUT_MS, authTimeoutMs: AUTH_TIMEOUT_MS };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--claude-command-arg') parsed.claudeCommandArgs.push(required(args[++i], key));
    else if (key === '--claude-command') parsed.claudeCommand = required(args[++i], key);
    else if (key === '--settings') parsed.settings = absolutePath(required(args[++i], key), key);
    else if (key === '--mcp-config') parsed.mcpConfig = absolutePath(required(args[++i], key), key);
    else if (key === '--caveat-home') parsed.caveatHome = absolutePath(required(args[++i], key), key);
    else if (key === '--timeout-ms') parsed.timeoutMs = positiveInt(required(args[++i], key), key);
    else if (key === '--auth-timeout-ms') parsed.authTimeoutMs = positiveInt(required(args[++i], key), key);
    else if (key === '--help') { process.stdout.write('Usage: claude-fresh-session-smoke.mjs --settings <path> --mcp-config <path> --caveat-home <path> [--claude-command <bin>]\n'); process.exit(0); }
    else throw new Error(`unknown option: ${key}`);
  }
  return parsed;
}
function required(value, option) { if (!value) throw new Error(`${option} requires a value`); return value; }
function absolutePath(value, option) { if (!isAbsolute(value)) throw new Error(`${option} must be an absolute path`); return resolve(value); }
function positiveInt(value, option) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${option} must be a positive integer`); return n; }
