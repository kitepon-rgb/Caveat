---
id: claude-code-hooks-no-hot-reload
title: 'Claude Code は settings.json の hooks 変更を hot-reload しない、session 再起動が必要'
visibility: public
confidence: confirmed
outcome: resolved
tags: [claude-code, hooks, settings, session]
environment:
  runtime: claude-code
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Claude Code の `~/.claude/settings.json` の hooks（UserPromptSubmit、Stop、etc.）を編集して挙動を変えたい。編集してすぐ効くと期待する。

## Symptom
- hook の command / script を編集しても、**現在の Claude Code session には反映されない**
- 「発火してるはずなのに何も起きない」と錯覚する
- stdout/stderr に出るはずのログも出ない
- hook ファイル自体を直して save しても同じ

## Cause
Claude Code は session 開始時に `settings.json` を読んで hook 登録を cache する。その後の settings.json 変更は無視される（cache invalidation の機構が無い）。

現時点で watch-and-reload の shell 非依存な仕組みは提供されていない。

## Resolution
**session を明示再起動する**:
- Claude Code を閉じて再起動
- または `/reset` / `/clear` の後に新規 session 開始

hook development のサイクル:
1. hook script を編集
2. manual invoke で動作確認（`echo '{...}' | node hook.mjs`）
3. OK なら Claude Code を再起動
4. 新 session で実際の発火を確認

**hook script 側（node のコード部分）の編集は hot-reload 不要**。settings.json から参照される path は毎回読み直される（command が `node /path/to/hook.mjs` の形なら）。**reload が必要なのは settings.json 自体の構造変更（hook を追加 / 削除 / 参照 path 変更）のみ**。

## Evidence
- everything-claude-code/docs/TROUBLESHOOTING.md に記載
- 実機確認: settings.json の command を `echo "A"` → `echo "B"` に変更、session 継続中は "A" のまま
