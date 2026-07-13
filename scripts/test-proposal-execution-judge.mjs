#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseProposalJudgmentsJsonl } from '../packages/core/dist/proposalEval.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const root = mkdtempSync(join(tmpdir(), 'caveat-execution-judge-')); const secret = 'TOP-SECRET-MASKED-JUDGE';
try {
  const home = join(root, 'home'); const caveat = join(root, 'caveat'); const proposal = join(caveat, 'local-eval', 'proposal'); const own = join(caveat, 'own'); const bin = join(root, 'bin');
  for (const path of [home, proposal, own, bin]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const packets = [packet('00000000000000000000000000000001'), packet('00000000000000000000000000000002')];
  const packetPath = join(proposal, 'execution-review-packets.jsonl'); writeFileSync(packetPath, `${packets.map(JSON.stringify).join('\n')}\n`, { mode: 0o600 });
  const env = { HOME: home, CAVEAT_HOME: caveat, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', USER: 'synthetic-user', LOGNAME: 'synthetic-login' };
  const run = (mode, extra = [], extraEnv = {}) => { const judge = join(bin, 'claude'); if (mode.startsWith('structured')) structuredFake(judge, mode); else fake(judge, mode); return spawnSync(process.execPath, ['scripts/run-proposal-execution-judge.mjs', '--model', 'claude-sonnet-5', '--judge-bin', judge, ...extra], { cwd: process.cwd(), env: { ...env, ...extraEnv }, encoding: 'utf8' }); };
  let result = run('success'); assert(result.status === 0 && !leaks(result), 'success/private output'); const output = join(proposal, 'execution-judgments.jsonl'); const judgments = parseProposalJudgmentsJsonl(readFileSync(output, 'utf8')); assert(judgments.length === 2 && judgments.every((item) => item.maskedReviewAttested && item.judge.includes('claude-sonnet-5')), 'success artifact'); assert((statSync(output).mode & 0o777) === 0o600, 'output permission'); assert(!existsSync(join(proposal, '.execution-judge-marker')), 'temporary cwd cleanup');
  rmSync(output); result = run('structured'); assert(result.status === 0 && !leaks(result) && parseProposalJudgmentsJsonl(readFileSync(output, 'utf8')).length === 2, 'structured output protocol');
  rmSync(output); result = run('structured-retry'); { const retried = parseProposalJudgmentsJsonl(readFileSync(output, 'utf8')); assert(result.status === 0 && !leaks(result) && retried.length === 2 && retried.every((item) => item.judge.includes('primary=claude-sonnet-5') && item.judge.includes('claude-haiku-4-5-20251001')), 'bounded structured schema retry'); }
  rmSync(output); result = run('structured-bad-retry'); assert(result.status !== 0 && !leaks(result) && !existsSync(output), 'unexpected structured retry rejected');
  for (const mode of ['mismatch', 'tool', 'malformed', 'duplicate', 'missing']) { rmSync(output, { force: true }); result = run(mode); assert(result.status !== 0 && !leaks(result) && !existsSync(output), `${mode}/fail closed`); }
  result = run('success'); assert(result.status === 0, 'output fixture remake'); result = run('success'); assert(result.status !== 0 && !leaks(result), 'existing output'); rmSync(output);
  result = run('success', [], { HTTP_PROXY: 'http://sentinel.invalid' }); assert(result.status !== 0 && !leaks(result), 'blocked routing environment');
  result = run('unauth'); assert(result.status !== 0 && !leaks(result) && !existsSync(output), 'unauthenticated judge');
  result = run('success', [], { USER: '' }); assert(result.status !== 0 && !leaks(result) && !existsSync(output), 'missing USER');
  result = run('success', [], { LOGNAME: '' }); assert(result.status !== 0 && !leaks(result) && !existsSync(output), 'missing LOGNAME');
  rmSync(packetPath); writeFileSync(packetPath, Buffer.alloc(0), { mode: 0o600 }); result = run('must-not-call'); assert(result.status === 0 && !leaks(result) && readFileSync(output).length === 0, 'zero packet no call');
  process.stdout.write(`${JSON.stringify({ success: true, structuredOutput: true, modelMismatch: true, toolEvent: true, malformedDuplicateMissing: true, privateSentinel: true, existingOutput: true, unauthenticatedRejected: true, loginIdentityRejected: true, zeroPacketNoCall: true })}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
function packet(judgmentId) { const data = { judgmentId, scenario: secret, evidence: [{ reference: 'r', content: secret, digest: sha(secret) }], knownBadClaims: ['bad'], validSolutionRubric: ['good'], output: secret }; return { ...data, packetDigest: sha(JSON.stringify(data)) }; }
function fake(path, mode) { const model = mode === 'mismatch' ? 'claude-haiku-4-5' : 'claude-sonnet-5'; const ids = ['00000000000000000000000000000001', '00000000000000000000000000000002']; let answer = JSON.stringify(ids.map((judgmentId) => ({ judgmentId, knownBadClaimEmitted: 'no', validSolutionSupplied: 'yes' }))); if (mode === 'malformed') answer = '{'; if (mode === 'duplicate') answer = JSON.stringify([JSON.parse(answer)[0], JSON.parse(answer)[0]]); if (mode === 'missing') answer = JSON.stringify([JSON.parse(answer)[0]]); const assistant = mode === 'tool' ? { type: 'assistant', session_id: 's', message: { model, content: [{ type: 'tool_use', name: 'Read' }] } } : { type: 'assistant', session_id: 's', message: { model, content: [{ type: 'text', text: 'ok' }] } }; const result = { type: 'result', session_id: 's', subtype: 'success', is_error: false, result: answer, modelUsage: { [model]: {} } }; const lines = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model }), JSON.stringify(assistant), JSON.stringify(result)].map((line) => `'${line.replaceAll("'", "'\\''")}'`).join(' '); const source = `#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'fake-claude 1.0\\n'; exit 0; fi\nif [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then printf '%s\\n' '${mode === 'unauth' ? '{"loggedIn":false}' : '{"loggedIn":true}'}'; exit 0; fi\nif [ \"${mode}\" = \"must-not-call\" ]; then exit 99; fi\nprintf '%s\\n' ${lines}\n`; writeFileSync(path, source, { mode: 0o700 }); chmodSync(path, 0o700); }
function structuredFake(path, mode = 'structured') {
  const judgments = ['00000000000000000000000000000001', '00000000000000000000000000000002'].map((judgmentId) => ({ judgmentId, knownBadClaimEmitted: 'no', validSolutionSupplied: 'yes' }));
  const structured = { judgments };
  const events = [
    { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5' },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1, estimated_tokens_delta: 1, session_id: 's' },
    { type: 'assistant', session_id: 's', message: { model: 'claude-sonnet-5', content: [{ type: 'thinking', thinking: '' }] } },
    ...(mode === 'structured' ? [] : [
      { type: 'assistant', session_id: 's', message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'tool-failed', name: 'StructuredOutput', input: { judgments: {} } }] } },
      { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-failed', content: mode === 'structured-retry' ? 'Output does not match required schema: /judgments: must be array' : 'unexpected retry result', is_error: true }] } },
    ]),
    { type: 'assistant', session_id: 's', message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'tool-1', name: 'StructuredOutput', input: structured }] } },
    { type: 'user', session_id: 's', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Structured output provided successfully' }] } },
    { type: 'result', session_id: 's', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured, modelUsage: mode === 'structured-retry' ? { 'claude-sonnet-5': {}, 'claude-haiku-4-5-20251001': {} } : { 'claude-sonnet-5': {} }, permission_denials: [] },
  ];
  const lines = events.map(JSON.stringify).map((line) => `'${line.replaceAll("'", "'\\''")}'`).join(' ');
  const source = `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fake-claude 1.0\n'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then printf '%s\n' '{"loggedIn":true}'; exit 0; fi
printf '%s\n' ${lines}
`;
  writeFileSync(path, source, { mode: 0o700 }); chmodSync(path, 0o700);
}
function leaks(result) { return `${result.stdout ?? ''}${result.stderr ?? ''}`.includes(secret); }
function assert(condition, name) { if (!condition) throw new Error(`synthetic execution judge test failed: ${name}`); }
