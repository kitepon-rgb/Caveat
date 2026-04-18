#!/usr/bin/env node
// Claude Code UserPromptSubmit hook for Caveat.
// Outputs a [caveat] system-reminder when the prompt looks like it touches
// external-spec gotcha territory (GPU/driver/tool-version/IDE/flakiness).
// Silent otherwise to keep token spend low.

const CAVEAT_TRIGGERS = [
  /\b(gpu|cuda|nvidia|amd|rtx|nvenc|nvdec|blackwell|ada|ampere)\b/i,
  /\bdriver\b/i,
  /ドライバ/,
  /\b(vscode|vs\s?code|jetbrains|intellij|pycharm)\b/i,
  /\bclaude\s?code\b/i,
  /\b(flaky|intermittent|reproducib|reproduce|repro)\b/i,
  /再現(しない|性|できない)/,
  /挙動が(違|おかしい|変)/,
  /\b(node|python|cuda|cudnn)\s*\d+(\.\d+)?/i,
  /バージョン(依存|違い|差)/,
  /\b(prebuild|native\s+module|msvc|gyp)\b/i,
];

export function detectCaveatTrigger(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return false;
  return CAVEAT_TRIGGERS.some((re) => re.test(prompt));
}

export function reminderText() {
  return [
    '[caveat] このプロンプトは外部仕様の罠（GPU/ドライバ/ツールバージョン/IDE/再現性の低い挙動）に触れる可能性があります。',
    '実装を始める前に mcp__caveat__caveat_search を呼んで既存の罠メモを確認してください。',
    '3 文字以上のクエリで検索、日本語は trigram 一致。該当なしなら続行、該当あれば environment 一致を見て適用判断を。',
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

  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';

  if (detectCaveatTrigger(prompt)) {
    process.stdout.write(`<system-reminder>${reminderText()}</system-reminder>\n`);
  }

  process.exit(0);
}

// Only run main when invoked directly (not when imported for tests)
const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
const thisPath = import.meta.url.startsWith('file://')
  ? import.meta.url.slice(7).replace(/^\/+([a-zA-Z]:)/, '$1')
  : '';
if (invokedPath && thisPath && invokedPath.toLowerCase() === thisPath.toLowerCase()) {
  main();
}
