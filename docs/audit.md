# Caveat 計画書監査 履歴

対象: `docs/plan.md`
実施日: 2026-04-18
方針: (a) 何が壊れるか (b) 根拠 (c) 最小修正 の 3 点セットでのみ指摘。推測・時間予言・多層防御提案を含めない。
状態: **Round 5 で収束**。現計画書は実装ブロッカーなし。

## ラウンド履歴

| Round | 新規 Critical | 新規 High | 反映 | 備考 |
|---|---|---|---|---|
| 1 | 5 | 14 | ✅ 全件 | FTS5 external-content、id PK 衝突、MCP stdout、env 比較仕様、Web UI md レンダラ |
| 2 | 0 | 12 | ✅ 全件 | caveat_update 仕様詳細、~/.caveatrc.json、path 正規化、12 hex、--full、config コメント等 |
| 3 | 4 | 15 | ✅ 全件 | upsert の source 別発行、sections 見出し正規化、schema.sql/migrations 関係、id 衝突、temp table、日本語 slug fallback、coerce 誤ヒット等 |
| 4 | 0 | 2 | ✅ 全件 | user_version 位置統一、caveat_get/update の sections 整合 |
| 5 | 0 | 0 | — | 3 視点全て「収束」判定 |

各ラウンドで 3 視点（schema / spec completeness / consistency）を並列実行。

## Phase 2 実装での発見（plan 更新済）

| 項目 | plan の未検証仕様 | 実装時の結果 |
|---|---|---|
| DB ライブラリ | better-sqlite3 の Node 24 prebuild 可用性 | **不可**（Win MSVC 無しでビルド失敗）→ `node:sqlite` (builtin) に差し替え |
| trigram tokenizer | SQLite 3.34+ 可用性 | ✅ Node 24.14 同梱 SQLite 3.51.2 で動作（ただし 3 文字以上クエリ必須は plan に明記済） |
| gray-matter engines.yaml API | 関数形 vs `{ parse: fn }` | ✅ 関数形 `(s) => object` で動作、`!!js/function` 等 unsafe タグは throw |
| vitest + node:sqlite | vite の node: prefix 解決 | vitest 2 + vite 5 は `node:sqlite` を resolve 不能、**vitest 4 + vite 7 で解決** |

## 却下した監査候補（再掲）

- visibility の多層防御追加（pre-commit 1 層で plan の要件は足りる）
- community quarantine / allowlist / 署名 / 降格（plan の community import 要件にない）
- record → draft → review フロー（plan の直接 entries 作成設計から外れる）
- 2 repo 分離の再考、Web UI / NotebookLM の v1 外し（スコープ判断で監査対象外）
- 型アフィニティ上の `created_at` TEXT 化（SQLite 標準）
