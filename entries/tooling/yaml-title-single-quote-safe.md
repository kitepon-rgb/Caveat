---
id: yaml-title-single-quote-safe
title: 'caveat の title に : / backtick / " が含まれるなら single-quoted スカラーにする'
visibility: public
confidence: confirmed
outcome: resolved
tags: [yaml, frontmatter, caveat, gray-matter]
environment:
  parser: gray-matter + js-yaml JSON_SCHEMA
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
caveat の md ファイルを大量に書き起こすとき、title に `permissions: packages: write` や `"cmd $VAR"` や `` `node:slim` `` のような特殊文字を含めた。

## Symptom
`caveat index --full` が中断し、以下のエラー:
```
[caveat:error] bad indentation of a mapping entry (3:55)
 3 | title: GitHub Actions から GHCR に push するには `permissions: packages: write` が明示必要
---------------------------------------------^
```

YAML parser が title 内の `: ` を別 key-value の区切りと解釈して fail。

## Cause
gray-matter は js-yaml を JSON_SCHEMA で噛ませる設定（[caveat の CLAUDE.md 参照](https://github.com/kitepon-rgb/Caveat/blob/main/CLAUDE.md)）。YAML の plain scalar は**以下を含むと key として解釈される**：
- `: ` (colon + space) → key-value separator
- `#` (space 前後) → comment start
- 先頭 `[`, `{`, `|`, `>`, `*`, `&`, `!`, `%`, `@`, ` `` ` ` 等 → flow/block indicator

特にプログラミング系 title（API 名、メソッド名、エラーメッセージ）は `:` を含みやすい。

## Resolution
**title は single-quoted スカラーにする**（double ではなく single）:
```yaml
# bad: plain scalar、: で崩れる
title: Stripe API で foo: bar エラー

# ambiguous: 埋め込み " で崩れる
title: "error: unable to parse \"foo\""

# good: single-quote、literal 扱い、" も backtick も : も通る
title: 'Stripe API で foo: bar エラー'
title: 'error: unable to parse "foo"'
```

single-quote 内で `'` を書きたい場合は **重ねて** `''`（YAML 仕様）:
```yaml
title: 'user''s setting'   # → user's setting
```

**Obsidian の `.templates/caveat.md` も single-quote 前提に書く**:
```yaml
---
id: <slug>
title: '<one-line title>'
...
---
```

bulk 修正スクリプト（backtick 除去 + 既存 `'` を `''` に escape）:
```bash
grep -rln "^title: " caveats-quo/entries/ | while read f; do
  title=$(sed -n 's/^title: //p' "$f" | head -1)
  cleaned=$(echo "$title" | sed 's/`//g')
  escaped=$(echo "$cleaned" | sed "s/'/''/g")
  sed -i "s|^title: .*|title: '$escaped'|" "$f"
done
```

## Evidence
- Caveat プロジェクトの 31 件 bulk 追加で発生、single-quote 方針で全解消
- YAML 1.2 仕様: https://yaml.org/spec/1.2.2/#731-double-quoted-style
- gray-matter のエンジン設定は [packages/core/src/frontmatter.ts](https://github.com/kitepon-rgb/Caveat/blob/main/packages/core/src/frontmatter.ts)
