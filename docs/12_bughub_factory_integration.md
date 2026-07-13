# BugHub factory integration

作成: 2026-07-13
状態: 実装完了・`0.16.3`公開待ち
上位計画: `kitepon-rgb/dotagents` の `docs/plan_bughub-factory-integration.md`
公開予定版: `caveat-cli@0.16.3`

## 目的

dotagents が管理する工場製品として、Caveat 自身が所有する状態を機械可読な
read-only diagnostics と opt-in の構造化 runtime error 契約として公開する。
dotagents は Caveat の DB や設定を直接解釈せず、この公開入口だけを BugHub report
へ射影する。

## 完了条件（本書が TODO を兼ねる）

- [x] 変更前 baseline: workspace test 545件、全workspace typecheckがgreen
- [x] `caveat factory-diagnostics --json` が version、DB schema/migration、own sync、Claude MCP/hook、Codex native hookを秘密・絶対pathなしで返す
- [x] diagnosticsはread-onlyで、DB migration、index、sync、hook/MCP登録を実行しない
- [x] `caveat runtime-errors snapshot|diagnostics|ack|resolve|reopen|compact --json` を公開する
- [x] runtime error収集はdotagents factory configのJSON boolean `collection.enabled: true`でだけ有効になり、tokenや`reporting.enabled`から推測しない
- [x] storeはCaveat所有のXDG/LocalAppData stateへ置き、atomic write、single-writer lock、所有者限定権限、bounded record数、ack/cursor、30日retentionを持つ
- [x] message templateは登録済みallowlistだけから組み立て、prompt、入力本文、entry/file内容、token、cookie、絶対path、生stack、生stderrを保存・出力しない
- [x] 既存の失敗境界へだけbest-effort観測を接続し、利用者取消・正常な未設定・unsupportedをerror化しない
- [x] telemetry store故障で本来のCaveat処理を止めず、固定stderrとdiagnosticsで故障を観測できる
- [x] dotagents adapterがCaveat diagnostics/runtime error snapshotを厳密検証し、BugHub accepted後だけackする
- [x] Caveatとdotagentsのfixture、full gate、独立反証を通し、repo別に独立commit/pushする

## 固定する公開契約

### Native diagnostics

- command: `caveat factory-diagnostics --json`
- schema: `caveat.native_factory_diagnostics.v1`
- exit: overall `ready`のみ0、`not_ready` / `unverified`は非0
- DBはread-only接続で`PRAGMA user_version`を読む。対応schemaは3。欠落、open不能、
  schema不一致を区別し、migrationは実行しない。
- own syncはgit worktree、origin有無、private remote名の存在、upstream ahead/behindの
  取得可否だけをread-onlyで検査する。remote URL、branch名、pathは出力しない。
- ClaudeはMCP server登録＋4 hook、Codexはnative 3 hookを正規connectorとする。
  CodexにCaveat MCPを必須化しない。
- MCPのhealth確認で実MCP serverを常駐起動したり、検索本文を送ったりしない。
  登録shapeとCLI assetの存在だけを検査する。

### Runtime error store

- schema: `caveat.runtime_errors.v1`
- command:
  - `snapshot --after-cursor 0 --limit 256 --json`
  - `diagnostics --json`
  - `ack <cursor> --json`
  - `resolve <fingerprint> --json`
  - `reopen <fingerprint> --json`
  - `compact --json`
- 同一原因は `sha256("caveat\0component\0error_code\0message_template")` で集約し、
  retryごとの行を増やさずcountとlast_seenを更新する。
- sequenceは状態変化ごとに単調増加し、snapshotはack済みを含む指定cursor以後を
  最大256件返す。BugHub accepted前にはackしない。
- ack済みかつresolvedで30日を越えたrecordだけcompactできる。openまたは未ackは
  削除しない。
- 初期観測対象は、既存コードがすでに失敗として扱う次の境界に限定する。
  - DB/index起動失敗
  - own sync実行失敗
  - Claude hookの検索/永続化境界失敗
  - Codex hookの検索/永続化境界失敗
  - MCP server起動・tool handler失敗
- 1件の失敗を下位・上位の両layerで重複記録しない。期待された入力validationや
  user cancellationは対象外とする。

## 実装wave

### Wave C1 — characterizationとdiagnostics（挙動不変＋公開入口追加）

- [x] 現行DB v3、sync、Claude/Codex integrationのread-only fixtureを先に追加
- [x] machine-readable diagnosticsを実装
- [x] 欠落、partial、schema drift、malformed config、秘密混入のnegative fixtureを追加

### Wave C2 — runtime error store（新規opt-in挙動）

- [x] collection OFF/config欠落/malformedではstateもnetworkも触らないfixtureを追加
- [x] store、lock、ACL、cursor/ack、resolve/reopen、retention、overflowを実装
- [x] privacy allowlistとnegative fixtureを追加
- [x] 上記の既存失敗境界へbest-effort observerを接続

### Wave C3 — dotagents接続

- [x] Caveat diagnostics adapterを追加
- [x] Caveat runtime error parserとack commandを追加
- [x] product contractとhost/connector matrixをCaveat正典へ訂正
- [x] fake CLI、schema drift、collection OFF、ack failure/retryをfixture化

### Wave C4 — 統合

- [x] Caveat workspace test/typecheck/build
- [x] dotagents `make ci`
- [x] `git diff --check`、独立反証、repo別commit/push
- [x] 上位計画のCaveat項目を完了へ更新

## 非目標

- CaveatからBugHubへ直接送信すること
- 外部利用者のtelemetryを暗黙に有効化すること
- prompt、session、entry本文、生DB、生logをBugHubへ送ること
- diagnosticsのためにmigration、index、sync、hook/MCP登録を実行すること
- CodexへClaude用MCP登録を強制すること
- 既存のhook reminder、検索gate、sync/publish意味論を変更すること

## rollback

- diagnostics/runtime-errorsは追加CLI入口なので、該当commitのcode-only revertで既存CLIへ戻せる。
- collection既定OFFのため、adapterを先に無効化してもCaveat本体の検索・hook・MCPは継続する。
- storeはCaveat state内に保持し、rollback時に自動削除しない。再適用後に同じcursorから再送できる。
- dotagents側はCaveat adapterだけを独立revertし、他8製品のreporter契約を巻き戻さない。
