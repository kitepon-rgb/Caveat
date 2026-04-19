---
id: settings-mcpservers-rejected
title: 'Claude Code の ~/.claude/settings.json は mcpServers フィールドを受け付けない'
visibility: public
confidence: confirmed
outcome: resolved
tags: [claude-code, mcp, settings]
environment:
  runtime: claude-code
source_project: null
source_session: "manual/2026-04-18"
created_at: 2026-04-18
updated_at: 2026-04-18
last_verified: 2026-04-18
---

## Context
Caveat プロジェクトの Phase 10（MCP サーバ登録 + Claude Code hooks 追記）で `~/.claude/settings.json` に `mcpServers` ブロックを追加しようとした。`docs/plan.md` の旧設計はこの方式を前提にしていた。

## Symptom
`Edit` ツールでの書き込みが **schema validation でリジェクト** される:
```
Claude Code settings.json validation failed after edit:
- : Unrecognized field: mcpServers. Check for typos or refer to the documentation for valid fields
```

## Cause
Claude Code の settings.json schema は MCP サーバ定義を直接持たない設計。schema の top-level に存在する MCP 関連フィールドは**承認リスト**系のみ:
- `enableAllProjectMcpServers` (bool)
- `enabledMcpjsonServers` / `disabledMcpjsonServers` — `.mcp.json` からのサーバの承認リスト
- `allowedMcpServers` / `deniedMcpServers` — enterprise allow/denylist

MCP サーバの**定義本体**は別ファイルに置く設計になっている:
- ユーザースコープ: `~/.claude.json`（`claude mcp add --scope user` で書き込み）
- プロジェクトスコープ: プロジェクトルートの `.mcp.json`
- プラグイン経由

## Resolution
**`claude mcp add` CLI 経由で `~/.claude.json` に書き込む**のが正解:

```sh
claude mcp add --scope user caveat node \
  -- "--disable-warning=ExperimentalWarning" \
     "C:/absolute/path/to/apps/mcp/dist/server.js"
```

- `--scope user` → `~/.claude.json` に入る（全プロジェクトで有効）
- `--scope project` → 現在のプロジェクト直下の `.mcp.json` に入る
- `--` 以降は node に渡す引数列（shebang-style）

確認:
```sh
claude mcp list            # caveat: ... ✓ Connected が出れば成功
claude mcp get caveat      # 詳細
```

**hooks は settings.json 側で OK** — `hooks.UserPromptSubmit` / `hooks.Stop` 等は schema で定義されており、従来通り書ける。MCP とは配置場所が違う。

## Evidence
- Claude Code settings schema の `properties` に `mcpServers` が存在しないことを validation エラーのメッセージから直接確認（`Unrecognized field: mcpServers`）
- `claude mcp add --help` で `--scope user|project|local` と `stdio|http|sse` transport が選べる
- `File modified: ~/.claude.json` のログで書き込み先を確認
- 実機 `claude mcp list` で `caveat: node --disable-warning=ExperimentalWarning ... - ✓ Connected` 表示
