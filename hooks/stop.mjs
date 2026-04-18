#!/usr/bin/env node
// Claude Code Stop hook for Caveat.
// Reminds Claude to record reusable external-spec gotchas via caveat_record,
// including "impossible" conclusions (not only resolved cases).
// Guards against infinite loops via stop_hook_active.

export function reminderText() {
  return [
    '[caveat] このセッションで外部仕様の罠（GPU/ドライバ/ツールバージョン/IDE/再現性）を踏み、次回の自分の調査が短縮できそうなら mcp__caveat__caveat_record で登録を検討してください。',
    '解決したケースだけでなく、「現状の制約では不可能と判定した」結論も outcome: impossible として記録対象。次回同じ 3 時間を溶かさないために。',
    '既に同等の caveat がある場合は caveat_update で上書き、または last_verified だけ更新。',
  ].join('\n');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(`[caveat:hook] stdin read error: ${err?.message ?? err}\n`);
    process.exit(0);
  }

  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`[caveat:hook] json parse error: ${err?.message ?? err}\n`);
    process.exit(0);
  }

  // Prevent loops: if Claude Code re-invoked Stop while this hook is already
  // active, don't re-emit.
  if (payload.stop_hook_active === true) {
    process.exit(0);
  }

  process.stdout.write(`<system-reminder>${reminderText()}</system-reminder>\n`);
  process.exit(0);
}

const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
const thisPath = import.meta.url.startsWith('file://')
  ? import.meta.url.slice(7).replace(/^\/+([a-zA-Z]:)/, '$1')
  : '';
if (invokedPath && thisPath && invokedPath.toLowerCase() === thisPath.toLowerCase()) {
  main();
}
