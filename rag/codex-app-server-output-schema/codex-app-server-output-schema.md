# Codex App Server outputSchema 調査

- 出典: [[raw/codex-0.144.1-turn-start-output-schema]]
- 取得日: 2026-07-13
- 確度: confirmed for Codex CLI 0.144.1

## 結論

Codex CLI 0.144.1のApp Server protocolは`turn/start.params.outputSchema`を持ち、最終assistant
messageをJSON Schemaで拘束できる。現行codex-sidecarはpromptでJSONを要求した後に
`JSON.parse`しているが、`startTurn`へ`outputSchema`を渡していない。

Luna advisoryで観測した「valid JSONの後ろへ余分な文字」は、壊れた出力を切り詰めて救済せず、
workflow別schemaを`outputSchema`へ渡して生成時に拘束するのが正規の修正候補である。
旧App Server互換のためにschema無しで無言再実行することは、失敗原因と実効契約を隠すため採用しない。

公式Codex manual helperは`x-content-sha256`欠落で取得検証に失敗し、OpenAI Docs MCP検索には
App Server固有の該当文書が見つからなかった。この結論は公開docsではなく、現行CLIが自身で生成した
protocol schemaに基づく。
