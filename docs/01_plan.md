# Caveat product contract

この文書はCaveatの現行設計と所有境界を短く示す正本である。実装履歴、完了済み計画、却下案は
[`archive/`](archive/)に置き、通常作業では読まない。コードと本書が食い違う場合はコードを確認し、
同じ変更で本書を直す。

## 製品境界

Caveatは単独でinstall、設定、記録、検索、同期、公開、診断、migration、復旧、releaseできる。
dotagentsは複数製品を束ねる導入・互換・host projectionを所有するが、Caveatの状態や判断を
代行しない。Caveatの動作にdotagentsを必須依存として持ち込まない。

## 真実の源と状態

- 正本はmarkdown-in-git。SQLite FTS5 indexは常に再構築できる派生物。
- 自分の知識は既定で`~/.caveat/own/`、indexは`~/.caveat/index/caveat.db`。
- ユーザー設定の正本は`~/.caveatrc.json`だけ。`knowledgeRepo`で知識repoの場所を変更でき、
  `runtimeErrors: true`でlocal runtime error収集を明示的に有効化できる（既定false）。
- `CAVEAT_HOME`でCaveatのdata rootを明示変更できる。
- entryの主キーはsourceとidの組。sourceは`own`または`community/<handle>`。
- schemaとmigrationは`packages/core/src/schema.sql`と`packages/core/src/migrations/`が所有する。

## 配布境界

`visibility`は配布範囲の上限である。

- `private`: 自分の端末または同じprivate remoteを使える組織内まで。
- `public`: 世界へ配布してよい。
- `caveat sync`: public/privateを含むown全体をprivate remoteと同期する。匿名可読remoteは拒否する。
- `caveat publish`: public entryだけを検査し、`README.md`とAES-256-GCM封緘bundleへ生成して
  public remoteを一方向更新する。non-showcase本文を平文treeへ置かない。
- publishには`publishTarget`、`sealedKeyserverUrl`、`sealedKeyId`が必要。鍵配布契約とrotationは
  [`../keyserver/README.md`](../keyserver/README.md)を正とする。

封緘はカジュアル閲覧、crawler、host上の平文収集を妨げる摩擦であり、認証境界ではない。
keyserverは無認証なので、動機ある人間による解析を防ぐとは主張しない。

## Agent host契約

- Claude Code: MCPと`UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` hooks。
- Codex: `caveat codex-hook install`でnative hooksを登録する。
- Cursor: `caveat cursor-hook install`で`~/.cursor/hooks.json`へnative hooksをupsertする。
- host固有adapterは同じ検索・pending・同期coreを再利用し、別hostのfieldやstdout契約を改名しない。
- 検索結果は共有しても操作案内はhostごとに分ける。ClaudeはMCP、Codex / Cursorは
  Caveat CLIとown Markdownを使い、別hostにしかない入口を案内しない。

詳細なhost契約は[`03_dual_agent_support.md`](03_dual_agent_support.md)、利用手順は
[`../README.md`](../README.md)と[`../README.ja.md`](../README.ja.md)を正とする。

## 運用入口

| 判断 | 正規入口 |
|---|---|
| install / config / update / uninstall | [`../README.md`](../README.md) |
| state / schema / migration / source構造 | [`../CLAUDE.md`](../CLAUDE.md)と実装 |
| host diagnostics | `caveat codex-hook diagnostics`、`caveat cursor-hook diagnostics`、`caveat factory-diagnostics --json` |
| runtime error設定・確認・復旧 | [`../README.md`](../README.md#runtime-error-diagnostics-explicit-opt-in)と`caveat runtime-errors ... --json` |
| sealed publish / key rotation | [`../keyserver/README.md`](../keyserver/README.md) |
| npm release | [`04_release_checklist.md`](04_release_checklist.md) |

## 文書寿命

- 現行文書は[`00_overview.md`](00_overview.md)に列挙したものだけ。
- 完了したplan、handoff、release ledger、監査、告知案は`archive/`へ移す。
- 同じ目的の現行説明はREADME、本書、host契約、release checklistのいずれかへ統合し、並立させない。
- ADRと`rag/`は履歴・根拠として専用棚に残すが、通常作業の必読にはしない。
