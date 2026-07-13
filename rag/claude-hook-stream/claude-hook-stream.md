# Claude fresh-session hook stream 調査

- 出典: [[raw/hooks]]、[[raw/headless]]、ローカル `claude` 2.1.207 実測
- 取得日: 2026-07-13
- 確度: confirmed（公式仕様と当該CLI実物）

## 結論

公開packageのfresh-session smokeは、認証済みの実HOMEを維持しつつ、Caveatのsettings、MCP
config、`CAVEAT_HOME`、作業ディレクトリだけを一時領域へ隔離する。`claude auth status`の
JSONで `loggedIn: true` を事前確認し、未認証・timeout・非JSONを成功扱いしない。

Claude Codeの非対話出力は `--output-format=stream-json --verbose` でNDJSONになる。公式hook
仕様では `UserPromptSubmit` はprompt処理前、`Stop`は応答完了時に発火し、exit 0が成功である。
ローカル2.1.207へ `--include-hook-events` を付けた実測では、両hookについて
`system/hook_started` と `system/hook_response` が同じ `hook_id` で現れ、成功responseは
`exit_code: 0`、`outcome: "success"` だった。

実効モデルは `assistant.message.model` とterminal resultの `modelUsage` keyの両方で確認する。
Haiku指定の実測値は `claude-haiku-4-5-20251001`。terminal resultは `subtype: "success"`、
`is_error: false` とprompt sentinelを持った。秘密値・auth token・組織情報・生streamは保存していない。

## Caveatへの適用

CIは同じevent形を返すfake CLIでparserの成功・失敗境界を固定する。実Claude呼出しはrelease時だけ、
`--model haiku --max-budget-usd 0.05 --no-session-persistence`で1回実行する。hook eventや実効モデルを
観測できないrunは、exit 0であってもsmoke成功にしない。
