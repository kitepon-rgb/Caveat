const CAVEAT_TRIGGERS: RegExp[] = [
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

export function detectCaveatTrigger(prompt: unknown): boolean {
  if (typeof prompt !== 'string' || prompt.length === 0) return false;
  return CAVEAT_TRIGGERS.some((re) => re.test(prompt));
}

export function userPromptSubmitReminderText(): string {
  return [
    '[caveat] このプロンプトは外部仕様の罠（GPU/ドライバ/ツールバージョン/IDE/再現性の低い挙動）に触れる可能性があります。',
    '実装を始める前に mcp__caveat__caveat_search を呼んで既存の罠メモを確認してください。',
    '3 文字以上のクエリで検索、日本語は trigram 一致。該当なしなら続行、該当あれば environment 一致を見て適用判断を。',
  ].join('\n');
}

export function stopReminderText(): string {
  return [
    '[caveat] このセッションで外部仕様の罠（GPU/ドライバ/ツールバージョン/IDE/再現性）を踏み、次回の自分の調査が短縮できそうなら mcp__caveat__caveat_record で登録を検討してください。',
    '解決したケースだけでなく、「現状の制約では不可能と判定した」結論も outcome: impossible として記録対象。次回同じ 3 時間を溶かさないために。',
    '既に同等の caveat がある場合は caveat_update で上書き、または last_verified だけ更新。',
    '記録した罠が他のユーザにも再利用価値があるなら mcp__caveat__caveat_push で共有 DB に PR を投げることも検討（個人プロジェクト固有の物は push しない）。',
  ].join('\n');
}
