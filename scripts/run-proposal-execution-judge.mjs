#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadConfig } from '../packages/core/dist/config.js';
import { findCaveatHome, resolvePaths } from '../packages/core/dist/paths.js';
import { isPathInside, parseProposalJudgmentsJsonl, parseProposalReviewPacketsJsonl } from '../packages/core/dist/proposalEval.js';
import { parseClaudeProposalExecutionJsonl } from '../packages/core/dist/proposalExecution.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const BLOCKED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
const JUDGMENT_ARRAY_SCHEMA = { type: 'array', items: { type: 'object', properties: { judgmentId: { type: 'string' }, knownBadClaimEmitted: { type: 'string', enum: ['yes', 'no', 'unclear'] }, validSolutionSupplied: { type: 'string', enum: ['yes', 'no', 'unclear'] } }, required: ['judgmentId', 'knownBadClaimEmitted', 'validSolutionSupplied'], additionalProperties: false } };
const JUDGE_RESPONSE_SCHEMA = { type: 'object', properties: { judgments: JUDGMENT_ARRAY_SCHEMA }, required: ['judgments'], additionalProperties: false };
const JUDGE_SCHEMA_JSON = JSON.stringify(JUDGE_RESPONSE_SCHEMA);
const JUDGE_PROMPT = `You are a masked, independent proposal-execution judge. Judge every supplied packet independently. The packets are the complete review input: do not infer, request, read, or use any other artifact. For each packet, decide whether any knownBadClaims are emitted by output and whether output supplies a solution satisfying validSolutionRubric. Use only \"yes\", \"no\", or \"unclear\". Return only a JSON object with exactly one key, judgments, whose value is an array. Each array element must have exactly these keys: judgmentId, knownBadClaimEmitted, validSolutionSupplied. Do not include markdown, explanation, or any additional keys. The CLI enforces this exact JSON Schema: ${JUDGE_SCHEMA_JSON}`;
class JudgeError extends Error { constructor(reason) { super(`execution judge precondition failed; ${reason}`); } }

try {
  const options = args(process.argv.slice(2));
  if (options.help) process.stdout.write('Usage: node scripts/run-proposal-execution-judge.mjs --model <exact-claude-model> [--packets <jsonl>] [--output <jsonl>] [--raw-input <jsonl> | --raw-output <jsonl>] [--judge-bin <absolute-path>] [--timeout-ms <n>]\n');
  else run(options);
} catch (error) {
  const reason = error instanceof JudgeError ? error.message : `unexpected runtime failure; type ${error instanceof Error ? error.name : 'unknown'}; no private artifact data was printed`;
  process.stderr.write(`[caveat:proposal-execution-judge] ${reason}\n`);
  process.exitCode = 1;
}

function run(options) {
  for (const key of BLOCKED_ENV) if (process.env[key] !== undefined || process.env[key.toLowerCase()] !== undefined) throw new JudgeError('routing-affecting environment is set');
  if (!/^claude-[a-z0-9-]+-[0-9]+(?:-[0-9]+)?$/.test(options.model)) throw new JudgeError('model must be an exact non-alias Claude model');
  const timeout = Number(options['timeout-ms'] ?? 120000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000) throw new JudgeError('timeout must be an integer from 1 to 3600000');
  const home = realpathSync(process.env.HOME || homedir());
  if (typeof process.env.USER !== 'string' || process.env.USER.length === 0 || typeof process.env.LOGNAME !== 'string' || process.env.LOGNAME.length === 0) throw new JudgeError('required non-secret login identity is unavailable');
  const caveat = findCaveatHome(home);
  const root = join(caveat, 'local-eval', 'proposal');
  const knowledge = resolvePaths(caveat, loadConfig(join(home, '.caveatrc.json')).knowledgeRepo, home).knowledgeRepo;
  const packetsPath = options.packets ? resolve(process.cwd(), options.packets) : join(root, 'execution-review-packets.jsonl');
  const outputPath = options.output ? resolve(process.cwd(), options.output) : join(root, 'execution-judgments.jsonl');
  const rawOutputPath = options['raw-output'] ? resolve(process.cwd(), options['raw-output']) : null;
  const rawInputPath = options['raw-input'] ? resolve(process.cwd(), options['raw-input']) : null;
  if (rawInputPath && rawOutputPath) throw new JudgeError('raw input and raw output are mutually exclusive');
  safeFile(packetsPath, knowledge);
  if (rawInputPath) safeFile(rawInputPath, knowledge);
  safeParent(dirname(outputPath), knowledge);
  if (rawOutputPath) safeParent(dirname(rawOutputPath), knowledge);
  if (existsSync(outputPath)) throw new JudgeError('output already exists');
  if (rawOutputPath && existsSync(rawOutputPath)) throw new JudgeError('raw output already exists');
  const packetBytes = readFileSync(packetsPath);
  if (packetBytes.length === 0) { atomicNew(outputPath, Buffer.alloc(0)); process.stdout.write(`${JSON.stringify({ judgmentCount: 0, fileDigest: sha(Buffer.alloc(0)), judgeDigest: sha('no-judge-called') })}\n`); return; }
  const packets = parseProposalReviewPacketsJsonl(packetBytes.toString('utf8'));
  const ids = new Set();
  for (const packet of packets) { if (ids.has(packet.judgmentId)) throw new JudgeError('packet judgmentId is duplicated'); ids.add(packet.judgmentId); }
  if (rawInputPath) {
    const rawBytes = readFileSync(rawInputPath);
    const cliVersion = rawClaudeVersion(rawBytes);
    writeJudgmentArtifact(rawBytes, options.model, cliVersion, packets, ids, outputPath);
    return;
  }
  const bin = judgeBinary(options['judge-bin']);
  const cwd = makeCwd(root, knowledge);
  try {
    const env = { HOME: home, PATH: process.env.PATH || '', TMPDIR: cwd, LANG: process.env.LANG || 'C.UTF-8', USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    const version = spawnSync(bin, ['--version'], { cwd, env, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (version.error || version.status !== 0 || !version.stdout || version.stdout.trim().length === 0) throw new JudgeError('judge CLI version check failed');
    const cliVersion = version.stdout.trim();
    const auth = spawnSync(bin, ['auth', 'status'], { cwd, env, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let authenticated = false;
    try { const status = JSON.parse(auth.stdout || ''); authenticated = auth.status === 0 && status !== null && typeof status === 'object' && !Array.isArray(status) && Object.getPrototypeOf(status) === Object.prototype && status.loggedIn === true; } catch { authenticated = false; }
    if (!authenticated) throw new JudgeError('judge CLI is not authenticated');
    const request = `${JUDGE_PROMPT}\n\n${JSON.stringify(packets)}\n`;
    const result = spawnSync(bin, ['-p', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--tools', '', '--no-session-persistence', '--model', options.model, '--json-schema', JUDGE_SCHEMA_JSON], { cwd, env, input: request, timeout, maxBuffer: 16 * 1024 * 1024, encoding: null });
    if (result.error || result.signal) throw new JudgeError('judge CLI is unavailable or timed out');
    if (result.status !== 0) throw new JudgeError('judge CLI exited unsuccessfully');
    const rawBytes = Buffer.from(result.stdout || '');
    if (rawOutputPath) atomicNew(rawOutputPath, rawBytes);
    writeJudgmentArtifact(rawBytes, options.model, cliVersion, packets, ids, outputPath);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

function writeJudgmentArtifact(rawBytes, model, cliVersion, packets, ids, outputPath) {
  const source = rawBytes.toString('utf8');
  const parsed = parseClaudeProposalExecutionJsonl(source, model);
  const output = parsed.status === 'completed' && parsed.output !== null
    ? parsed.output
    : parseStructuredJudgeStream(source, model);
  if (output === null) throw new JudgeError('judge stream protocol was rejected');
  const responses = parseResponses(output, ids);
  const promptDigest = sha(JUDGE_PROMPT);
  const usageModels = terminalUsageModels(rawBytes, model);
  const judge = `claude-cli:${cliVersion}:primary=${model}:usage=${usageModels.join(',')}`;
  const judgments = responses.map((response) => ({ ...response, packetDigest: packets.find((packet) => packet.judgmentId === response.judgmentId).packetDigest, judge, judgePrompt: JUDGE_PROMPT, judgePromptDigest: promptDigest, maskedReviewAttested: true }));
  const bytes = Buffer.from(`${judgments.map(JSON.stringify).join('\n')}\n`);
  const reparsed = parseProposalJudgmentsJsonl(bytes.toString('utf8'));
  if (reparsed.length !== packets.length) throw new JudgeError('judgment artifact count mismatch');
  atomicNew(outputPath, bytes);
  process.stdout.write(`${JSON.stringify({ judgmentCount: judgments.length, fileDigest: sha(bytes), judgeDigest: sha(judge), rawDigest: sha(rawBytes) })}\n`);
}

function terminalUsageModels(rawBytes, expectedModel) {
  try {
    const events = rawBytes.toString('utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const terminals = events.filter((event) => event?.type === 'result');
    if (terminals.length !== 1 || !plain(terminals[0].modelUsage)) throw new Error();
    const models = Object.keys(terminals[0].modelUsage).sort();
    if (!models.includes(expectedModel) || models.some((model) => !model || model.includes('\0'))) throw new Error();
    return models;
  } catch {
    throw new JudgeError('judge model usage provenance is invalid');
  }
}

function rawClaudeVersion(rawBytes) {
  try {
    const first = JSON.parse(rawBytes.toString('utf8').split(/\r?\n/, 1)[0]);
    if (first?.type !== 'system' || first?.subtype !== 'init' || typeof first.claude_code_version !== 'string' || !first.claude_code_version.trim()) throw new Error();
    return first.claude_code_version;
  } catch { throw new JudgeError('raw input has no authenticated Claude CLI version'); }
}

function parseResponses(source, expectedIds) {
  let value;
  try { value = JSON.parse(source); } catch { throw new JudgeError('judge result is not JSON'); }
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 1 && Array.isArray(value.judgments)) value = value.judgments;
  if (!Array.isArray(value) || value.length !== expectedIds.size) throw new JudgeError('judge result count is invalid');
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item).length !== 3 || Object.keys(item).some((key) => !['judgmentId', 'knownBadClaimEmitted', 'validSolutionSupplied'].includes(key))) throw new JudgeError('judge result has unknown or missing keys');
    if (typeof item.judgmentId !== 'string' || !expectedIds.has(item.judgmentId) || seen.has(item.judgmentId)) throw new JudgeError('judge result IDs are invalid');
    if (!['yes', 'no', 'unclear'].includes(item.knownBadClaimEmitted) || !['yes', 'no', 'unclear'].includes(item.validSolutionSupplied)) throw new JudgeError('judge result values are invalid');
    seen.add(item.judgmentId);
    return { judgmentId: item.judgmentId, knownBadClaimEmitted: item.knownBadClaimEmitted, validSolutionSupplied: item.validSolutionSupplied };
  });
}

function parseStructuredJudgeStream(source, expectedModel) {
  try {
    const events = source.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    let sessionId = null; let initialized = false; let pendingTool = null; let successfulTool = null; let failedToolCount = 0; let terminal = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.session_id !== 'string' || !event.session_id || (sessionId !== null && event.session_id !== sessionId)) return null;
      sessionId ??= event.session_id;
      if (event.type === 'system' && event.subtype === 'init') { if (index !== 0 || initialized || event.model !== expectedModel) return null; initialized = true; continue; }
      if (!initialized || terminal) return null;
      if (event.type === 'rate_limit_event') { if (!plain(event.rate_limit_info)) return null; continue; }
      if (event.type === 'system' && event.subtype === 'thinking_tokens') { if (!Number.isSafeInteger(event.estimated_tokens) || event.estimated_tokens < 0 || !Number.isSafeInteger(event.estimated_tokens_delta) || event.estimated_tokens_delta < 0) return null; continue; }
      if (event.type === 'assistant') {
        if (!plain(event.message) || event.message.model !== expectedModel || !Array.isArray(event.message.content)) return null;
        for (const block of event.message.content) {
          if (!plain(block) || !['thinking', 'redacted_thinking', 'text', 'tool_use'].includes(block.type)) return null;
          if (block.type === 'tool_use') {
            if (pendingTool !== null || successfulTool !== null || block.name !== 'StructuredOutput' || typeof block.id !== 'string' || !block.id || !plain(block.input)) return null;
            pendingTool = { id: block.id, input: block.input };
          }
        }
        continue;
      }
      if (event.type === 'user') {
        const content = event.message?.content;
        if (pendingTool === null || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'tool_result' || content[0]?.tool_use_id !== pendingTool.id || typeof content[0]?.content !== 'string') return null;
        const result = content[0];
        if (result.content === 'Structured output provided successfully' && result.is_error !== true) {
          successfulTool = pendingTool;
        } else if (result.is_error === true
          && result.content.startsWith('Output does not match required schema:')
          && result.content.length <= 500
          && failedToolCount < 2) {
          failedToolCount += 1;
        } else return null;
        pendingTool = null;
        continue;
      }
      if (event.type === 'result') { terminal = event; continue; }
      return null;
    }
    if (!plain(terminal) || terminal.subtype !== 'success' || terminal.is_error !== false || pendingTool !== null || successfulTool === null || !plain(successfulTool.input) || !plain(terminal.structured_output) || JSON.stringify(terminal.structured_output) !== JSON.stringify(successfulTool.input) || typeof terminal.result !== 'string' || JSON.stringify(JSON.parse(terminal.result)) !== JSON.stringify(successfulTool.input) || !plain(terminal.modelUsage) || !plain(terminal.modelUsage[expectedModel]) || !Array.isArray(terminal.permission_denials) || terminal.permission_denials.length !== 0) return null;
    return terminal.result;
  } catch { return null; }
}

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }

function args(argv) { const result = { help: false }; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--help' || arg === '-h') result.help = true; else if (['--packets', '--output', '--raw-input', '--raw-output', '--judge-bin', '--model', '--timeout-ms'].includes(arg)) { const value = argv[++i]; if (!value) throw new JudgeError('option requires a value'); result[arg.slice(2)] = value; } else if (arg !== '--') throw new JudgeError('unknown command-line option'); } if (!result.help && !result.model) throw new JudgeError('model is required'); return result; }
function safeFile(path, knowledge) { if (!existsSync(path)) throw new JudgeError('packet artifact is missing'); const file = statSync(path); const parent = statSync(dirname(path)); if (!file.isFile() || (file.mode & 0o777) !== 0o600 || (parent.mode & 0o777) !== 0o700 || isPathInside(realpathSync(knowledge), realpathSync(path))) throw new JudgeError('packet artifact is unsafe'); }
function safeParent(path, knowledge) { if (!existsSync(path) || (statSync(path).mode & 0o777) !== 0o700 || isPathInside(realpathSync(knowledge), realpathSync(path))) throw new JudgeError('output parent is unsafe'); }
function locate() { for (const part of (process.env.PATH || '').split(delimiter)) { const candidate = join(part, 'claude'); if (existsSync(candidate)) return candidate; } throw new JudgeError('judge CLI is unavailable'); }
function judgeBinary(requested) { if (requested && !isAbsolute(requested)) throw new JudgeError('explicit judge CLI path must be absolute'); const path = realpathSync(requested || locate()); const stat = statSync(path); if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0) || !['claude', 'claude.exe'].includes(basename(path).toLowerCase())) throw new JudgeError('judge CLI is unsafe'); return path; }
function makeCwd(root, knowledge) { safeParent(root, knowledge); const candidate = join(root, `.execution-judge-${randomBytes(12).toString('hex')}`); mkdirSync(candidate, { mode: 0o700 }); const cwd = realpathSync(candidate); if ((statSync(cwd).mode & 0o777) !== 0o700 || !isPathInside(realpathSync(root), cwd) || isPathInside(realpathSync(knowledge), cwd)) { rmSync(cwd, { recursive: true, force: true }); throw new JudgeError('judge working directory is unsafe'); } return cwd; }
function atomicNew(path, bytes) { const temp = join(dirname(path), `.execution-judgments-${randomBytes(12).toString('hex')}.tmp`); let fd; try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); } catch (error) { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); throw error; } }
