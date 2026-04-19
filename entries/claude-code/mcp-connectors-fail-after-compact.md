---
id: claude-code-mcp-connectors-fail-after-compact
title: 'Claude Code の compaction 後、接続済の MCP コネクタが auth エラーで fail する（UI は ✓ のまま）'
visibility: public
confidence: reproduced
outcome: resolved
tags: [claude-code, mcp, compaction, authentication]
environment:
  claude-code: ">=2.1.79"
  mcp: "gmail / google-drive / その他 oauth 系"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
OAuth ベースの MCP connector（claude.ai の Gmail / Google Drive 等）を接続して使っている。長い session で auto-compaction が走った後、急に connector が動かなくなる。

## Symptom
- compaction 前: tool 呼び出し成功
- compaction 後: 同じ tool が auth エラー / 401 / `not authenticated` で落ちる
- **Claude Code UI 上は connector が `✓ Connected` と表示される**（詐称）
- session 再接続しても直らないことがある、connector を disconnect → reconnect で復旧

## Cause
compaction 実装が OAuth access token の in-memory cache を失う。connector の UI 側は「connection metadata」として残っている状態を見ているので ✓ 表示。実 call path は token が無くなっていて 401。upstream bug。

## Resolution
**暫定運用**:
- compaction が起きた直後に connector を使う前に一度 disconnect / reconnect（`/mcp` で該当 connector を toggle）
- または compaction 直後に test call を 1 回して、失敗したら reconnect
- PostCompact hook を書いて、affected connector のリストを reminder として出す（将来）

**恒久対策は upstream 修正待ち**。Claude Code 側で token refresh ハンドリングを compaction と独立に持つ改修が必要。

## Evidence
- everything-claude-code/docs/TROUBLESHOOTING.md で複数 user 観測
- Caveat MCP（stdio）は OAuth を使わないので影響なし。この罠は **HTTP/SSE 系の OAuth connector 特有**
