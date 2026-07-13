#!/usr/bin/env node
const mode = process.env.FAKE_CLAUDE_MODE ?? 'happy';
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  if (mode === 'unauth') { process.stdout.write('{"loggedIn":false}\n'); process.exit(0); }
  if (mode === 'bad-auth-json') { process.stdout.write('Logged in\n'); process.exit(0); }
  if (mode === 'auth-timeout') setTimeout(() => process.exit(0), 20_000);
  else { process.stdout.write('{"loggedIn":true}\n'); process.exit(0); }
}
if (mode === 'timeout') setTimeout(() => process.exit(0), 20_000);
const events = [
  { type: 'system', subtype: 'hook_started', hook_id: 'hook-user', hook_name: 'UserPromptSubmit', hook_event: 'UserPromptSubmit' },
  { type: 'system', subtype: 'hook_response', hook_id: 'hook-user', hook_name: 'UserPromptSubmit', hook_event: 'UserPromptSubmit', exit_code: 0, outcome: 'success' },
  { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } },
  { type: 'system', subtype: 'hook_started', hook_id: 'hook-stop', hook_name: 'Stop', hook_event: 'Stop' },
  { type: 'system', subtype: 'hook_response', hook_id: 'hook-stop', hook_name: 'Stop', hook_event: 'Stop', exit_code: 0, outcome: 'success' },
  { type: 'result', subtype: 'success', is_error: false, result: 'caveat-claude-session-ok', modelUsage: { 'claude-haiku-4-5-20251001': {} } },
];
if (mode === 'hook-failure') events[4] = { ...events[4], exit_code: 1, outcome: 'failure' };
if (mode === 'wrong-model') { events[2].message.model = 'claude-sonnet-5'; events[5].modelUsage = { 'claude-sonnet-5': {} }; }
if (mode === 'missing-hook') events.splice(3, 2);
if (mode === 'error-text') events.splice(3, 0, { type: 'system', message: 'Caveat hook failed' });
if (mode === 'bad-json') process.stdout.write('{not json}\n');
else process.stdout.write(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
