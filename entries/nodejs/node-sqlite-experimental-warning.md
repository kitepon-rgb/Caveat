---
id: node-sqlite-experimental-warning
title: 'Node 22.5+ の node:sqlite は ExperimentalWarning を 1 回吐く（import 時発火で runtime 抑制不能）'
visibility: public
confidence: confirmed
outcome: resolved
tags: [nodejs, sqlite, mcp, esm]
environment:
  node: ">=22.5"
  runtime: node
source_project: null
source_session: "manual/2026-04-18"
created_at: 2026-04-18
updated_at: 2026-04-18
last_verified: 2026-04-18
---

## Context
Caveat tool の MCP stdio サーバを実装中。MCP は stdout に JSON-RPC 以外を出してはいけない制約がある。`@caveat/core` の `db.ts` が `node:sqlite` を import すると起動時に stderr に `(node:PID) ExperimentalWarning: SQLite is an experimental feature...` が 1 行出る。

## Symptom
- 現象: `import { DatabaseSync } from 'node:sqlite'` すると process ごと 1 回だけ `ExperimentalWarning` が emit される
- `process.on('warning', handler)` で filter しようとしても間に合わない

## Cause
ESM の import は syntactically hoist される。`import './bootstrap.js'; import '...node:sqlite 経由...'` と書いても、両者の module 評価は依存関係順で、top-level import 文の位置には意味がない。さらに `node:sqlite` の warning は module load 時（`DatabaseSync` の construct 時ではなく）に emit されるので、bootstrap 内で `process.on('warning')` を登録した時点では warning が既に発火済み。

## Resolution
- **stderr 出力なので無害なら放置**: CLI のように stdout が自由な場合は 1 行出るだけで動作に影響しない
- **stdout に出してはいけない場面（MCP stdio）では Node の CLI フラグで抑制**: `node --disable-warning=ExperimentalWarning server.js` で発火自体を止める。spawn 側で付ける
- **runtime の `process.on('warning')` は使うな**: ESM hoisting で間に合わない。最初 bootstrap.ts で試したが効かず削除

## Evidence
- Node 公式: `--disable-warning=<name>` CLI flag
- 再現: `node -e "import('node:sqlite').then(m => new m.DatabaseSync(':memory:'))"` → stderr に 1 行
- Caveat の実装判断: Phase 3 で CLI は stderr 出力を許容、Phase 4 で MCP は `--disable-warning` を spawn 時に付与する運用
