# Codex App Server 0.144.1: TurnStartParams.outputSchema

- 出典: ローカル導入済み`codex-cli 0.144.1`が生成したprotocol JSON Schema
- 取得コマンド: `codex app-server generate-json-schema --experimental --out <temporary-directory>`
- 取得日: 2026-07-13
- 確度: confirmed（当該CLI実物の生成schema）

`v2/TurnStartParams.json`の該当field:

```json
{
  "outputSchema": {
    "description": "Optional JSON Schema used to constrain the final assistant message for this turn."
  }
}
```

同schemaで`input`と`threadId`がrequired。`outputSchema`はoptionalであり、
codex-sidecarが`turn/start`へ明示的に渡さなければ拘束されない。
