---
id: json-locale-chinese-curly-quotes
title: '中華圏 locale の JSON ファイルに 「」 が混入すると JSON.parse が silent fail'
visibility: public
confidence: confirmed
outcome: resolved
tags: [json, i18n, chinese, encoding, locale]
environment:
  language: js/ts/python/any
  locale: zh-tw / zh-cn / ja
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
多言語対応 Web アプリで `locales/zh-tw.json` を用意。中国語ネイティブ翻訳者から受け取ったテキストを貼り付けた。

## Symptom
- `JSON.parse` で `Unexpected token` エラー、行番号もわかりにくい
- あるいはパース自体は通るが後続の string 処理で quote 境界が壊れる
- エラーメッセージを読むまで原因が「全角括弧」だと気付かない

## Cause
中国語 / 日本語 typing では `「」` や `『』`、`「`（smart quote）を自動変換する IME が多い。JSON の string delimiter は **straight ASCII double quote `"` のみ**。`「abc」: value` は JSON として不正。

エディタによっては見た目で区別しにくい（特に fullwidth `"` と ASCII `"`）。

## Resolution
**CI で JSON locale の lint を走らせる**:
```bash
# 簡易チェック（ASCII quote 以外の quote-like 文字を検出）
grep -rnP '[「」『』“”‟„〝〞]' locales/*.json
```
何か引っかかったら CI fail。

**sed で一括置換**:
```bash
sed -i 's/「/"/g; s/」/"/g; s/『/"/g; s/』/"/g' locales/*.json
```
ただし本文中の意図的な引用符まで置換されるので、review を挟む。

**根本対策**: 翻訳者に `.json` ではなく `.yaml` で提出してもらう（YAML は smart quote も処理できる）→ ビルド時に JSON に変換。

## Evidence
- HIT Auction System の HANDOVER.md に「JSON parse 失敗の 9 割は curly quote 混入」と記録
- JSON 仕様: https://www.rfc-editor.org/rfc/rfc8259.html §7 "String" は ASCII quote のみ
