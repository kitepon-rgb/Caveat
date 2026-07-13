# Codex hooks feature key

- 出典: [[raw/openai-config-reference]]
- 取得日: 2026-07-13
- 確度: 高（OpenAI公式config reference + Codex CLI 0.144.1実測）

Codex lifecycle hooksの正規feature keyは`[features].hooks`。`codex_hooks`はdeprecated alias。
Caveat installerは正規keyを書き、旧`codex_hooks = true`だけがある場合は正規keyへ移行する。
明示false、矛盾、重複、quoted keyはconsent／TOML安全性のためfail closedにする。

実測ではCodex CLI 0.144.1が旧keyにdeprecated warningを出し、`codex features list`は
`hooks stable true`を返した。
