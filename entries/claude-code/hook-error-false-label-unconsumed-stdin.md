---
id: claude-code-hook-error-false-label
title: 'Claude Code で hook が成功しても "Hook Error" ラベルが付く — stdin 未消費 / stderr 出力が犯人'
visibility: public
confidence: confirmed
outcome: resolved
tags: [claude-code, hooks, stderr, stdin]
environment:
  claude-code: ">=2.1.79"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Claude Code の hook（UserPromptSubmit、Stop、etc.）が正常終了しているはずなのに、transcript に `Hook Error` 表示が出る。挙動は正常なので誤検知に見える。

## Symptom
- hook script が exit 0 で終了
- stdout に期待した `<system-reminder>` が出ている
- それでも transcript には `Hook Error` ラベル + 赤いエラー表示
- user は「hook が壊れているのか？」と疑心暗鬼になる

## Cause
Claude Code の hook runner は以下の条件で error 判定する:
1. **exit code が 0 以外**
2. **stderr に何か出力されていた**（exit 0 でも）
3. **stdin が未消費**のまま child process が exit（pipe が open のまま close）

3 は node スクリプトで `process.stdin` から読まずに exit するとよく出る。hook に JSON がパイプで流れてくるのに、それを consume しない構造。

stderr 出力は `throw` / `console.error` 等で出る他、**node の warning**（ExperimentalWarning、DeprecationWarning）も該当。

## Resolution
hook script の先頭で stdin を consume:
```javascript
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
const raw = await readStdin();
```

`process.stdin` を iterate するだけで OK（パース不要でも）。

stderr への出力も制御:
- 診断ログは**発火条件を満たすときだけ**出す
- node の警告（ExperimentalWarning）は `--disable-warning=...` CLI flag で抑制
- `try/catch` で想定済の例外は swallow（stderr に出さない）

exit code:
- 0: 正常完了
- 2: blocking error（Claude に止まれと指示する場合。不要なら使わない）
- その他: error として扱われる

## Evidence
- everything-claude-code/docs/TROUBLESHOOTING.md に stdin 消費パターンと exit code 慣例
- Caveat プロジェクトの hooks/user-prompt-submit.mjs と stop.mjs でこの pattern を採用、false-error ゼロ
